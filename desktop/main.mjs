import { translate, resolveLanguage } from '../shared/i18n.mjs';
import { app, BrowserWindow, Menu, dialog, ipcMain, protocol, net, session, shell, safeStorage, Notification } from 'electron';
import { fork } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { attachCodexWorker } from './codex-bridge.mjs';
import { ClaudeLogin } from './claude.mjs';
import { ChatGPTLogin } from './chatgpt.mjs';
import { codexExecutable } from '../server/codex-client.mjs';
import { DesktopSettings, defaults, projectId } from './settings.mjs';
import { codexCapabilities } from './model-capabilities.mjs';
import { ModelProfiles, legacyProfileId } from './model-profiles.mjs';
import { workbenchProtocol } from './protocol.mjs';
import { ProjectRuntimes, runtimeId } from './project-runtimes.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
app.setName('Boan Workbench');
if (process.env.BOAN_USER_DATA) app.setPath('userData', path.resolve(process.env.BOAN_USER_DATA));
// Background GUI verification is opt-in and requires an isolated data directory.
const backgroundTest = process.env.BOAN_BACKGROUND_TEST === '1' && Boolean(process.env.BOAN_USER_DATA);
if (backgroundTest && process.platform === 'darwin') app.setActivationPolicy('accessory');
protocol.registerSchemesAsPrivileged([{ scheme: 'boan', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } }]);
let window, pool, activeId, settings, modelProfiles, uiRevision = 0, switching = false, quitting = false, canQuit = false;
const origin = 'boan://workbench';
const accessToken = randomBytes(32).toString('hex');
const dataDir = app.getPath('userData');
const claude = new ClaudeLogin(dataDir, url => shell.openExternal(url));
const chatgpt = new ChatGPTLogin({ home: path.join(dataDir, 'codex'), openExternal: url => shell.openExternal(url) });
const pendingExits = new WeakMap();
let projectPicker;
function trusted(event) {
  const frame = event.senderFrame;
  if (!window || event.sender !== window.webContents || frame !== window.webContents.mainFrame || !frame.url.startsWith(`${origin}/`)) throw new Error('不允许来自此页面的桌面操作');
}
function handler(channel, fn) { ipcMain.handle(channel, async (event, ...args) => { trusted(event); return fn(...args); }); }
async function stopWorker(target) {
  if (!target || target.exitCode !== null || target.signalCode !== null) return;
  target.expectedExit = true;
  if (target.connected) target.send({ type: 'stop' });
  // Wait for the engine to stop its command process group; only use force as a final fallback.
  const force = setTimeout(() => target.kill('SIGKILL'), 15000);
  await pendingExits.get(target); clearTimeout(force);
}
let chatgptCatalog = [], catalogAt = 0;
async function modelOptions(refresh = false) {
  const options = modelProfiles.options();
  const status = await chatgpt.status().catch(() => ({ loggedIn: false }));
  if (!status.loggedIn) { chatgptCatalog = []; catalogAt = 0; }
  if (refresh && status.loggedIn && Date.now() - catalogAt > 60000) { chatgptCatalog = await chatgpt.models().catch(() => chatgptCatalog); await modelProfiles.cacheChatGPT(chatgptCatalog); catalogAt = Date.now(); }
  const known = new Map(chatgptCatalog.map(m => [m.id, m.name]));
  for (const c of [settings.data.settings, ...Object.values(settings.data.projects || {})]) if (c.connection === 'chatgpt' && c.chatgptModel) known.set(c.chatgptModel, known.get(c.chatgptModel) || c.chatgptModel);
  options.unshift({ profileId: 'chatgpt', model: '', label: nativeText("账号默认模型"), provider: 'ChatGPT', connection: 'chatgpt', available: status.loggedIn, ...codexCapabilities(chatgptCatalog.find(m => m.isDefault)) });
  for (const [model, label] of known) options.push({ profileId: 'chatgpt', model, label, provider: 'ChatGPT', connection: 'chatgpt', available: status.loggedIn, ...codexCapabilities(chatgptCatalog.find(m => m.id === model)) });
  const claudeStatus = await claude.status().catch(() => ({loggedIn:false}));
  if (refresh && claudeStatus.loggedIn) await claude.models(true).catch(()=>{});
  const claudeModels = await claude.models();
  options.push({profileId:'claude',model:'',label:nativeText("Claude 默认模型"),provider:'Claude 登录',connection:'claude',available:claudeStatus.loggedIn,...codexCapabilities(claudeModels.find(m=>m.id==='default'))});
  for (const model of claudeModels.filter(m=>m.id!=='default')) options.push({profileId:'claude',model:model.id,label:model.name,provider:'Claude 登录',connection:'claude',available:claudeStatus.loggedIn,efforts:model.efforts,speeds:model.speeds});
  return options;
}
async function refreshModelOptions(refresh = false) {
  const options = await modelOptions(refresh);
  for (const entry of pool?.entries.values() || []) if (entry.runtime?.child.connected) entry.runtime.child.send({ type: 'model-options', options });
  return options;
}
async function startWorker(data, onSummary, onExit) {
  const config = data.settings;
  if (config.mode === 'pi' && config.connection === 'chatgpt' && !(await chatgpt.status()).loggedIn) throw new Error('请在设置中重新登录 ChatGPT。');
  if (config.mode === 'pi' && config.connection === 'claude' && !(await claude.status()).loggedIn) throw new Error('请在设置中登录 Claude。');
  const apiKey = config.mode === 'pi' && config.connection === 'api' ? await settings.secret(data) : '';
  if (config.mode === 'pi' && config.connection === 'api' && config.keyStorage === 'session' && !apiKey && !['localhost', '127.0.0.1', '[::1]'].includes(config.baseUrl ? new URL(config.baseUrl).hostname : '')) throw new Error('仅本次运行的密钥已随上次退出清除，请打开设置重新填写。');
  const stateDir = path.join(dataDir, 'workspaces', config.mode === 'demo' ? 'demo' : projectId(config.projectPath));
  const allowedEnv = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'SHELL', 'SYSTEMROOT'];
  const env = Object.fromEntries(allowedEnv.filter(k => process.env[k]).map(k => [k, process.env[k]]));
  // No external Node install, shell startup scripts or inherited model keys are needed.
  await modelProfiles.importLegacy(config);
  const options = config.mode === 'pi' ? await modelOptions() : null;
  const child = fork(path.join(here, 'worker.mjs'), [], { execPath: process.execPath, execArgv: [], env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let codexAttached = false, attaching;
  child.on('message', async message => {
    if (message.type === 'model-resolve') {
      try {
        const selection = message.selection;
        if (!selection || typeof selection.profileId !== 'string' || typeof selection.model !== 'string' || selection.model.length > 160) throw Error('模型选择无效');
        const resolved = selection.profileId === 'claude'
          ? ((await claude.status()).loggedIn ? {connection:'claude',claudeModel:selection.model} : (()=>{throw Error('请先登录 Claude');})())
          : selection.profileId === 'chatgpt'
          ? { connection: 'chatgpt', chatgptModel: selection.model }
          : await modelProfiles.resolve(selection);
        if (child.connected) child.send({ type: 'model-resolved', id: message.id, config: resolved });
      } catch (e) { if (child.connected) child.send({ type: 'model-resolved', id: message.id, error: e.message }); }
    }
    if (message.type === 'codex-request' && !codexAttached) {
      try {
        attaching ??= chatgpt.connect().then(client => { attachCodexWorker(child, client); codexAttached = true; client.once('closed', () => { codexAttached = false; attaching = null; }); }).catch(e => { attaching = null; throw e; });
        await attaching; child.emit('message', message);
      } catch (e) { if (child.connected) child.send({ type: 'codex-response', owner: message.owner, id: message.id, error: e.message }); }
    }
  });
  pendingExits.set(child, new Promise(resolve => child.once('exit', resolve)));
  // Keep child stderr private; model errors are reported as task events, not copied to a global log.
  child.stderr.on('data', () => {});
  child.on('message', message => {
    if (message.type === 'summary') onSummary(message.summary);
    if (!backgroundTest && message.type === 'attention' && (config.mode !== 'demo' || activeId === 'demo') && settings.data.settings.notifications && !window?.isFocused() && Notification.isSupported()) {
      const notification = new Notification({ title: nativeText("Boan 工作台"), body: `${path.basename(config.projectPath) || '本地演示'} · ${message.title} · ${nativeText({ review: '成果可验收', blocked: '需要你的决定', failed: '执行需要处理' }[message.status])}` });
      notification.on('click', () => { void selectProject(runtimeId(config)).then(() => { window?.show(); window?.focus(); }).catch(() => {}); }); notification.show();
    }
  });
  child.on('exit', () => {
    if (!child.expectedExit && !quitting) onExit('后台执行服务已停止，任务记录已保留。打开项目可重新连接。');
  });
  const ready = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('后台服务启动超时')), 20000);
    const fail = () => { clearTimeout(timeout); reject(new Error('后台服务未能启动')); };
    child.once('exit', fail);
    const onMessage = message => {
      if (!['ready', 'error'].includes(message.type)) return;
      clearTimeout(timeout); child.off('exit', fail); child.off('message', onMessage);
      if (message.type === 'error') reject(new Error(message.message)); else resolve(message);
    };
    child.on('message', onMessage);
  });
  try {
    child.send({ type: 'start', nodeExecutable: process.execPath, config: {
      ...config, ...(options ? { modelOptions: options, defaultModel: { profileId: config.connection === 'claude' ? 'claude' : config.connection === 'chatgpt' ? 'chatgpt' : legacyProfileId(config), model: config.connection === 'claude' ? config.claudeModel : config.connection === 'chatgpt' ? config.chatgptModel : config.model } } : {}), claudeHome: claude.home, claudeExecutable: claude.executable, workspaceId: runtimeId(config), ...(config.connection === 'chatgpt' ? { codexHome: chatgpt.home, codexExecutable: codexExecutable() } : {}), apiKey, baseUrl: config.baseUrl || undefined, dataDir: stateDir, appDataDir: dataDir,
      projectPath: config.mode === 'demo' ? path.join(stateDir, 'project') : config.projectPath,
      distDir: path.join(here, '..', 'dist'), accessToken, port: 0,
    } });
    const result = await ready;
    return { child, ...result };
  } catch (e) { child.expectedExit = true; child.kill(); await ready.catch(() => {}); throw e; }
}

function projectSnapshot() {
  const configs = new Map(Object.entries(settings.data.projects || {}));
  for (const [id, entry] of pool.entries) configs.set(id, entry.config);
  const projects = [...configs].map(([id, config]) => {
    const entry = pool.entries.get(id), summary = entry?.summary || { tasks: [], active: 0, attention: 0, done: 0, managerBusy: false };
    return { id, name: config.mode === 'demo' ? '本地演示' : path.basename(config.projectPath), path: config.projectPath, mode: config.mode, selected: id === activeId, status: entry?.status || 'stopped', error: entry?.error || '', ...summary, active: entry?.status === 'error' || entry?.status === 'stopped' ? 0 : summary.active };
  });
  return { projects: projects.filter(p => p.mode !== 'demo' || p.selected), activeId, switching, uiRevision };
}
function announceProjects() {
  const snapshot = projectSnapshot();
  const count = snapshot.projects.reduce((sum, p) => sum + p.attention + (p.status === 'error' ? 1 : 0), 0);
  app.dock?.setBadge(count ? String(count) : '');
  window?.webContents.send('desktop:projects', snapshot);
}
async function selectProject(id) {
  if (switching || quitting) throw new Error('正在切换项目，请稍后。');
  const config = settings.data.projects?.[id] || pool.entries.get(id)?.config;
  if (!config) throw new Error('项目不存在');
  switching = true;
  try {
    const entry = await pool.ensure(settings.forProject(config));
    await settings.select(config); activeId = entry.id;
    if (!window) await createWindow();
    return { activeId };
  } finally { switching = false; announceProjects(); }
}

async function createWindow() {
  const boundsFile = path.join(dataDir, 'window.json');
  let bounds = { width: 1380, height: 900 };
  try { const saved = JSON.parse(await fs.readFile(boundsFile, 'utf8')); if (saved.width >= 800 && saved.height >= 600) bounds = { width: Math.min(saved.width, 2400), height: Math.min(saved.height, 1600) }; } catch {}
  window = new BrowserWindow({ ...bounds, minWidth: 800, minHeight: 620, title: nativeText("Boan · Agent 工作台"), show: false, backgroundColor: '#191d20',
    titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 21, y: 22 },
    webPreferences: { preload: path.join(here, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, spellcheck: false } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => { if (url !== `${origin}/`) event.preventDefault(); });
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.webContents.on('render-process-gone', () => { if (backgroundTest) { if (!quitting) window?.reload(); return; } if (!quitting) void dialog.showMessageBox(window, { type: 'error', message: '页面意外停止，后台任务仍被保留。', buttons: ['重新加载'] }).then(() => window?.reload()); });
  window.on('close', () => { const b = window.getNormalBounds(); void fs.writeFile(boundsFile, JSON.stringify({ width: b.width, height: b.height })).catch(() => {}); });
  window.on('closed', () => { window = null; });
  window.once('ready-to-show', () => { if (!backgroundTest) window.show(); });
  await window.loadURL(`${origin}/`);
}
const nativeText=(key,...values)=>translate(resolveLanguage(settings?.data?.settings?.language,app.getLocale()),key,...values);
function createMenu() {
  const command = async value => { if (!window) await createWindow(); else if (!backgroundTest) window.show(); window?.webContents.send('desktop:command', value); };
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Boan', submenu: [{ role: 'about', label: nativeText("关于 Boan") }, { type: 'separator' }, { label: nativeText("设置…"), accelerator: 'CmdOrCtrl+,', click: () => command('settings') }, { type: 'separator' }, { role: 'hide', label: nativeText("隐藏 Boan") }, { role: 'hideOthers', label: nativeText("隐藏其他") }, { role: 'unhide', label: nativeText("显示全部") }, { type: 'separator' }, { role: 'quit', label: nativeText("退出 Boan") }] },
    { label: nativeText("文件"), submenu: [{ label: nativeText("新建任务"), accelerator: 'CmdOrCtrl+N', click: () => command('new-task') }, { label: nativeText("打开项目…"), accelerator: 'CmdOrCtrl+O', click: () => command('open-project') }, { type: 'separator' }, { role: 'close', label: nativeText("关闭窗口") }] },
    { label: nativeText("编辑"), submenu: [{ role: 'undo', label: nativeText("撤销") }, { role: 'redo', label: nativeText("重做") }, { type: 'separator' }, { role: 'cut', label: nativeText("剪切") }, { role: 'copy', label: nativeText("复制") }, { role: 'paste', label: nativeText("粘贴") }, { role: 'selectAll', label: nativeText("全选") }] },
    { label: nativeText("显示"), submenu: [{ role: 'reload', label: nativeText("重新加载") }, { role: 'resetZoom', label: nativeText("实际大小") }, { role: 'zoomIn', label: nativeText("放大") }, { role: 'zoomOut', label: nativeText("缩小") }, { role: 'togglefullscreen', label: nativeText("切换全屏") }, ...(!app.isPackaged ? [{ role: 'toggleDevTools', label: nativeText("开发者工具") }] : [])] },
    { label: nativeText("窗口"), submenu: [{ role: 'minimize', label: nativeText("最小化") }, { role: 'zoom', label: nativeText("缩放") }, { role: 'front', label: nativeText("全部置于前面") }] },
  ]));
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (backgroundTest) return; if (!window) void createWindow(); else { if (window.isMinimized()) window.restore(); window.show(); window.focus(); } });
  app.on('activate', () => { if (backgroundTest) return; if (!window && pool) void createWindow(); else window?.show(); });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  app.on('before-quit', event => {
    if (canQuit) return; event.preventDefault(); if (quitting) return; quitting = true;
    void (pool?.close() || Promise.resolve()).finally(() => { chatgpt.close(); claude.close(); canQuit = true; app.quit(); });
  });
  app.whenReady().then(async () => {
  try {
    await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
    settings = new DesktopSettings(dataDir, {
      available: () => safeStorage.isAsyncEncryptionAvailable(), encrypt: value => safeStorage.encryptStringAsync(value),
      decrypt: async value => (await safeStorage.decryptStringAsync(value)).result,
    });
    await settings.load();
    await claude.initialize();
    modelProfiles = new ModelProfiles(dataDir, settings.crypto, settings); await modelProfiles.load();
    chatgptCatalog = modelProfiles.data.chatgptModels || [];
    for (const config of [settings.data.settings, ...Object.values(settings.data.projects || {})]) await modelProfiles.importLegacy(config);
    pool = new ProjectRuntimes({ start: startWorker, stop: runtime => stopWorker(runtime.child) });
    pool.on('change', announceProjects);
    chatgpt.storage = settings.data.settings.chatgptStorage;
    app.setAboutPanelOptions({ applicationName: 'Boan · Agent 工作台', applicationVersion: app.getVersion(), copyright: '本地 AI 编程工作台', credits: 'Electron · React · pi · OpenAI Codex' });
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    protocol.handle('boan', workbenchProtocol({ distDir: path.join(here, '..', 'dist'), getBackend: id => pool.entries.get(id || activeId)?.runtime, accessToken, fetchBackend: (...args) => net.fetch(...args) }));
    handler('desktop:get-settings', async () => ({ ...settings.public(), version: app.getVersion(), packaged: app.isPackaged, needsClaudeLogin: settings.data.settings.mode==='pi' && settings.data.settings.connection==='claude' && !(await claude.status().catch(()=>({loggedIn:false}))).loggedIn, needsChatGPTLogin: settings.data.settings.mode === 'pi' && settings.data.settings.connection === 'chatgpt' && !(await chatgpt.status().catch(() => ({ loggedIn: false }))).loggedIn }));
    handler('desktop:get-model-profiles', () => modelProfiles.public());
    handler('desktop:save-model-profile', async input => { const result = await modelProfiles.save(input); await refreshModelOptions(); return result; });
    handler('desktop:remove-model-profile', async id => { const result = await modelProfiles.remove(id); await refreshModelOptions(); return result; });
    handler('desktop:refresh-models', () => refreshModelOptions(true));
    handler('desktop:get-projects', () => projectSnapshot());
    handler('desktop:select-project', id => selectProject(id));
    handler('desktop:claude-status', () => claude.status());
    handler('desktop:claude-login', () => claude.login());
    handler('desktop:claude-cancel', () => claude.cancel());
    handler('desktop:claude-code', code => claude.submitCode(code));
    handler('desktop:claude-models', () => claude.models(true));
    handler('desktop:claude-logout', async () => {
      if(switching || quitting) throw Error('正在切换配置，请稍后');
      switching=true;try {
        for(const [id,entry] of pool.entries) if(entry.config.connection==='claude' || entry.summary?.tasks.some(t=>t.connection==='claude'&&['queued','running','verifying','stopping','blocked'].includes(t.status))) await pool.stopOne(id);
        const status=await claude.logout();
        if(settings.data.settings.connection==='claude'&&settings.data.settings.mode==='pi'){const demo=await pool.ensure(settings.forProject({...defaults}));activeId=demo.id;await settings.select({...settings.data.settings,mode:'demo'});uiRevision++;}
        await refreshModelOptions();return status;
      }finally{switching=false;}
    });
    handler('desktop:chatgpt-status', () => chatgpt.status());
    handler('desktop:chatgpt-login', async storage => {
      if (switching || quitting) throw new Error('正在切换配置，请稍后。');
      switching = true;
      try {
        const status = await chatgpt.login(storage);
        // Login persistence is independent of applying a project/model selection.
        await settings.rememberChatGPTStorage(status.storage);
        await refreshModelOptions();
        return status;
      } finally { switching = false; }
    });
    handler('desktop:chatgpt-cancel', () => chatgpt.cancel());
    handler('desktop:chatgpt-models', () => chatgpt.models());
    handler('desktop:chatgpt-logout', async () => {
      if (switching || quitting) throw new Error('正在切换配置，请稍后。');
      switching = true;
      try {
        for (const [id, entry] of pool.entries) if (entry.config.mode === 'pi' && (entry.config.connection === 'chatgpt' || entry.summary?.tasks.some(t => t.connection === 'chatgpt' && ['queued', 'running', 'verifying', 'stopping', 'blocked'].includes(t.status)))) await pool.stopOne(id);
        const status = await chatgpt.logout();
        if (settings.data.settings.connection === 'chatgpt' && settings.data.settings.mode === 'pi') {
          const demo = await pool.ensure(settings.forProject({ ...defaults })); activeId = demo.id;
          await settings.select({ ...settings.data.settings, mode: 'demo' });
          uiRevision++;
        }
        await refreshModelOptions(); return status;
      } finally { switching = false; announceProjects(); }
    });
    handler('desktop:choose-project', () => {
      projectPicker ??= dialog.showOpenDialog(window, { title: nativeText("选择工作项目"), properties: ['openDirectory'] })
        .then(result => result.canceled ? null : result.filePaths[0]).finally(() => { projectPicker = null; });
      return projectPicker;
    });
    handler('desktop:reveal-project', () => { const runtime = pool.entries.get(activeId)?.runtime; if (!runtime) throw new Error('当前项目未连接'); return shell.openPath(runtime.projectPath); });
    handler('desktop:reveal-data', () => shell.openPath(dataDir));
    handler('desktop:save-preferences', async input => {
      if(switching || quitting)throw Error('正在切换项目，请稍后再试');
      switching=true;try{const result=await settings.savePreferences(input);createMenu();window?.setTitle(nativeText('Boan · Agent 工作台'));return result;}finally{switching=false;}
    });
    handler('desktop:save-settings', async input => {
      if (switching || quitting) throw new Error('正在切换项目，请稍后再试');
      switching = true;
      const previous = settings.data;
      try {
        const next = await settings.prepare(input);
        if (next.settings.mode === 'pi' && next.settings.connection === 'chatgpt') {
          const status = await chatgpt.status();
          if (!status.loggedIn || status.storage !== next.settings.chatgptStorage) throw new Error('请先按所选保存方式登录 ChatGPT，再保存应用。');
        }
        if(next.settings.mode==='pi' && next.settings.connection==='claude' && !(await claude.status()).loggedIn) throw Error('请先登录 Claude，再保存应用。');
        const id = runtimeId(next.settings), existing = pool.entries.get(id);
        const previousConfig = existing?.config;
        const changed = existing?.runtime && (JSON.stringify(existing.config) !== JSON.stringify(next.settings) || input.apiKey?.trim() || input.clearApiKey);
        if (changed) await pool.stopOne(id);
        try { const entry = await pool.ensure(next); await settings.commit(next); activeId = entry.id; }
        catch (e) {
          if (changed) { await pool.stopOne(id); await pool.ensure(settings.forProject(previousConfig)).catch(() => {}); }
          else if (!previous.projects?.[id] && id !== activeId) { await pool.stopOne(id); pool.entries.delete(id); }
          throw e;
        }
        // Stable boan:// origin preserves drafts and browsing state across random backend ports.
        await modelProfiles.importLegacy(next.settings); await refreshModelOptions();
        uiRevision++; return settings.public();
      } finally { switching = false; announceProjects(); }
    });
    let needsKey = settings.data.settings.mode === 'pi' && settings.data.settings.connection === 'api' && settings.data.settings.keyStorage === 'session' && !settings.public().hasApiKey;
    if (settings.data.settings.mode === 'pi' && settings.data.settings.connection === 'chatgpt') needsKey = !(await chatgpt.status().catch(() => ({ loggedIn: false }))).loggedIn;
    if(settings.data.settings.mode==='pi' && settings.data.settings.connection==='claude') needsKey=!(await claude.status().catch(()=>({loggedIn:false}))).loggedIn;
    try { const entry = await pool.ensure(settings.data); activeId = entry.id; }
    catch (e) {
      if (!needsKey && !backgroundTest) await dialog.showMessageBox({ type: 'warning', message: '原项目暂时无法打开，先进入演示工作区。', detail: e.message, buttons: ['打开工作台'] });
      const entry = await pool.ensure(settings.forProject({ ...defaults })); activeId = entry.id;
    }
    createMenu(); await createWindow();
    // Restore registered project services independently; interrupted tasks remain explicitly paused.
    void (async () => {
      for (const config of Object.values(settings.data.projects || {})) {
        if (quitting) break;
        const id = runtimeId(config);
        if (!pool.entries.has(id)) await pool.ensure(settings.forProject(config)).catch(() => {});
      }
    })();
    if (needsKey) window?.webContents.send('desktop:command', 'settings');
  } catch (e) { if (!backgroundTest) dialog.showErrorBox('Boan 启动失败', e.message); canQuit = true; await pool?.close(); app.quit(); }
  });
}

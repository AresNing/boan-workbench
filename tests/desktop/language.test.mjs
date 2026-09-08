import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';import {_electron as electron} from 'playwright';
test('desktop language changes menus without restarting workers, and survives app restart', {timeout:60000},async t=>{
 const dir=await fs.mkdtemp('/tmp/boan-language-native-');let app;
 t.after(async()=>{await app?.close().catch(()=>{});await fs.rm(dir,{recursive:true,force:true});});
 async function launch(){const env={...process.env,BOAN_BACKGROUND_TEST:'1',BOAN_USER_DATA:dir};delete env.ELECTRON_RUN_AS_NODE;const executablePath=process.env.BOAN_TEST_EXECUTABLE;app=await electron.launch({...(executablePath?{executablePath,args:[]}:{args:[path.resolve('.')]}),env});const page=await app.firstWindow();await page.waitForSelector('.desktop-app');return page;}
 let page=await launch();const worker=await fs.readFile(path.join(dir,'workspaces/demo/server.lock'),'utf8');
 await page.getByRole('textbox',{name:'交代工作或补充要求'}).fill('Preserve my draft 原文');await page.getByRole('button',{name:'设置',exact:true}).click();await page.getByRole('navigation',{name:'设置分类'}).getByRole('button',{name:'通用',exact:true}).click();await page.getByRole('combobox',{name:'语言',exact:true}).click();await page.getByRole('option',{name:'English',exact:true}).click();
 await page.getByRole('navigation',{name:'Settings categories'}).waitFor();assert.equal((await page.evaluate(()=>window.desktop.getSettings())).language,'en');assert.equal(await fs.readFile(path.join(dir,'workspaces/demo/server.lock'),'utf8'),worker);
 const labels=await app.evaluate(({Menu})=>Menu.getApplicationMenu().items.map(item=>item.label));assert.ok(labels.includes('File'));assert.ok(labels.includes('Window'));
 assert.equal(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].getTitle()),'Boan · Agent Workbench');
 await page.getByRole('button',{name:'Close panel',exact:true}).click();await app.close();app=null;
 page=await launch();await page.getByRole('heading',{name:'Workbench',exact:true}).waitFor();assert.equal(await page.getByRole('textbox',{name:'Describe a task or add requirements'}).inputValue(),'Preserve my draft 原文');
 assert.equal(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().some(w=>w.isVisible()||w.isFocused())),false);
});

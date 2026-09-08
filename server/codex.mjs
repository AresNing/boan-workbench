import { PiBackend } from './pi.mjs';
import { CodexClient, safeError } from './codex-client.mjs';
import { Value } from '@sinclair/typebox/value';

export class CodexBackend extends PiBackend {
  async session(key, customTools, instructions, signal, onEvent) {
    const client = this.config.codexClientFactory?.() || new CodexClient({ home: this.config.codexHome, executable: this.config.codexExecutable });
    let toolQueue = Promise.resolve();
    let threadId, turnId, finish, calls = 0, exhausted = false, closed = false;
    const abort = () => { finish?.(new Error('执行已中止')); client.close(); };
    signal?.addEventListener('abort', abort, { once: true });
    const close = () => { if (closed) {signal?.removeEventListener('abort',abort);this.sessions.delete(key);return;} closed = true; signal?.removeEventListener('abort', abort); client.close(); this.sessions.delete(key); };
    try {
      if (signal?.aborted) throw new Error('执行已中止');
      await client.start();
      const { account } = await client.request('account/read', { refreshToken: false });
      if (account?.type !== 'chatgpt') throw new Error('请在设置中使用 ChatGPT 登录。');
      const { thread } = await client.request('thread/start', {
        ...(this.config.chatgptModel ? { model: this.config.chatgptModel } : {}),
        cwd: this.config.projectPath, environments: [], ephemeral: true,
        sandbox: 'workspace-write', approvalPolicy: 'on-request',
        baseInstructions: instructions, developerInstructions: '只能调用工作台提供的工具，没有可用的 Codex 原生执行环境。工作台工具由独立宿主实现权限控制：write_file 已获得在所选项目内修改文件的授权；run_command 默认由宿主在项目沙箱中执行；联网或解除沙箱限制由宿主按权限范围申请授权，无需通过业务决定重复询问。不要把原生执行环境的限制误当作宿主文件工具不可用。实现任务时使用 write_file，提交结果后结束本轮。',
        dynamicTools: customTools.map(t => ({ type: 'function', name: t.name, description: t.description, inputSchema: t.parameters })),
      });
      threadId = thread.id;
      const session = { sessionId: threadId, sessionFile: null, messages: [], isStreaming: false,
        prompt: async text => {
          if (signal?.aborted) throw new Error('执行已中止');
          session.isStreaming = true;
          try {
            await new Promise((resolve, reject) => {
              finish = error => { finish = null; error ? reject(error) : resolve(); };
              client.request('turn/start', { threadId, ...(this.config.effort ? { effort: this.config.effort } : {}), serviceTierForTurn: this.config.speed && this.config.speed !== 'standard' ? this.config.speed : 'default', environments: [], input: [{ type: 'text', text, text_elements: [] }] }).then(({ turn }) => { turnId = turn.id; }, e => finish?.(e));
            });
          } finally { await toolQueue;session.isStreaming = false; }
        },
        steer: text => client.request('turn/steer', { threadId, expectedTurnId: turnId, input: [{ type: 'text', text, text_elements: [] }] }),
      };
      client.onToolCall = p => {
        const result = toolQueue.then(async () => {
        if (closed || exhausted || signal?.aborted || p.threadId !== threadId || (p.turnId&&turnId&&p.turnId!==turnId) || !session.isStreaming) throw new Error('执行已中止或会话无效');
        if (++calls > (this.config.maxTurns || 30)) { exhausted = true; finish?.(new Error('本轮达到执行步数上限，请检查后恢复。')); throw new Error('执行步数已用尽'); }
        const tool = customTools.find(t => t.name === p.tool && !p.namespace);
        if (!tool || !Value.Check(tool.parameters, p.arguments)) throw new Error('工具或参数无效');
        try {
          const value = await tool.execute(p.callId, p.arguments, signal);
          return { success: true, contentItems: value.content.flatMap(c => c.type === 'text' ? [{ type: 'inputText', text: c.text }] : c.type === 'image' ? [{type:'inputImage',imageUrl:`data:${c.mimeType};base64,${c.data}`}] : []) };
        } catch (e) { return { success: false, contentItems: [{ type: 'inputText', text: safeError(e) }] }; }
        });
        toolQueue = result.catch(() => {});
        return result;
      };
      client.on('closed', e => {closed=true;onEvent?.({type:'session_lost'},session);finish?.(e);});
      client.on('notification', (method, p) => {
        if (p?.threadId !== threadId) return;
        if (method === 'item/completed' && p.item?.type === 'agentMessage' && typeof p.item.text === 'string') onEvent?.({ type: 'public_message', text: p.item.text }, session);
        if (method === 'turn/started') turnId = p.turn.id;
        if (method === 'turn/completed' && (!turnId || p.turn.id === turnId || !p.turn.id)) void toolQueue.then(() => finish?.(p.turn.status === 'completed' ? null : new Error(safeError(p.turn.error || '执行已中止'))));
      });
      this.sessions.set(key, session); onEvent?.({ type: 'session_start' }, session);
      return { session, close, usable:()=>!closed, resetBudget:()=>{calls=0;exhausted=false;}, interrupt:async()=>{if(turnId&&!closed){await client.request('turn/interrupt',{threadId,turnId}).catch(()=>client.close());}}, exhausted: () => exhausted };
    } catch (e) { close(); throw e; }
  }
}

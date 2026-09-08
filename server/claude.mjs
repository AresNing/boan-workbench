import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Value } from '@sinclair/typebox/value';
import { PiBackend } from './pi.mjs';
import { claudeOptions } from './claude-client.mjs';

function schema(s) {
  if(s.const!==undefined)return z.literal(s.const);
  if(s.anyOf)return z.union(s.anyOf.map(schema));
  if(s.type==='string'){let v=z.string();return s.maxLength?v.max(s.maxLength):v;}
  if(s.type==='array'){let v=z.array(schema(s.items));return s.maxItems?v.max(s.maxItems):v;}
  if(s.type==='object')return z.object(Object.fromEntries(Object.entries(s.properties||{}).map(([k,v])=>[k,(s.required||[]).includes(k)?schema(v):schema(v).optional()])));
  if(s.type==='boolean')return z.boolean();if(s.type==='number'||s.type==='integer')return z.number();throw Error('不支持的工具参数类型');
}
export class ClaudeBackend extends PiBackend {
  async session(key,tools,instructions,signal,onEvent){
    const sdk=this.config.claudeSdk || await import('@anthropic-ai/claude-agent-sdk');let active,inputQueue,wakeInput,queryId,closed=false,exhausted=false,queue=Promise.resolve(),calls=0;
    const controller=new AbortController(),abort=()=>{controller.abort();active?.close();};signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    const names=tools.map(t=>`mcp__boan__${t.name}`);
    const mcp=sdk.createSdkMcpServer({name:'boan',version:'1.0.0',tools:tools.map(t=>sdk.tool(t.name,t.description,schema(t.parameters).shape,(params,extra)=>{
      const next=queue.then(async()=>{if(extra?.requestId===undefined)throw Error('工具请求缺少稳定标识，不能执行');if(closed||controller.signal.aborted)throw Error('执行已中止');if(++calls>(this.config.maxTurns||30)){exhausted=true;throw Error('本轮达到执行步数上限');}if(!Value.Check(t.parameters,params))throw Error('工具参数无效');try{const result=await t.execute(`${queryId}:${extra.requestId}`,params,controller.signal);return {content:result.content};}catch(e){return {content:[{type:'text',text:e.message}],isError:true};}});queue=next.catch(()=>{});return next;
    }))});
    let resumeId,invalid=false;
    const session={sessionId:null,sessionFile:null,messages:[],isStreaming:false,steer:async text=>{if(inputQueue){inputQueue.push(text);wakeInput?.();}},prompt:async text=>{
      if(controller.signal.aborted)throw Error('执行已中止');
      session.isStreaming=true;queryId=randomUUID();inputQueue=[text];let inputClosed=false;
      const input=(async function*(){while(!inputClosed){if(!inputQueue.length)await new Promise(r=>{wakeInput=r;});wakeInput=null;if(inputClosed)break;const content=inputQueue.shift();if(content)yield {type:'user',message:{role:'user',content},parent_tool_use_id:null,session_id:resumeId||''};}})();
      active=sdk.query({prompt:input,options:{...claudeOptions(this.config),persistSession:true,...(resumeId?{resume:resumeId}:{}),abortController:controller,systemPrompt:instructions+'\n只使用 boan 提供的工具。文件与命令权限由 Boan 宿主控制。',mcpServers:{boan:mcp},allowedTools:[],canUseTool:async (name,input)=>names.includes(name)?{behavior:'allow',updatedInput:input}:{behavior:'deny',message:'只能使用 Boan 工具'},maxTurns:this.config.maxTurns||30}});
      let success=false;
      try{for await(const m of active){if(m.type==='system'&&m.subtype==='init'){session.sessionId=m.session_id;resumeId=m.session_id;onEvent?.({type:'session_start'},session);}if(m.type==='assistant'){const content=(m.message?.content||[]).filter(c=>c.type==='text');session.messages.push({role:'assistant',content});onEvent?.({type:'message_end',message:{role:'assistant',content}},session);}if(m.type==='result'){if(m.is_error)throw Error((m.errors||['Claude 执行失败']).join('\n'));success=true;break;}}await queue;if(!success)throw Error(controller.signal.aborted?'执行已中止':'Claude 未返回完整执行结果');}
      catch(e){onEvent?.({type:'session_lost'},session);if(/No conversation found|session.*(?:invalid|not found)/i.test(e.message))invalid=true;throw e;}
      finally{inputClosed=true;wakeInput?.();inputQueue=null;session.isStreaming=false;active?.close();active=null;await queue;}
    }};
    this.sessions.set(key,session);
    return {session,usable:()=>!invalid,resetBudget:()=>{calls=0;exhausted=false;},interrupt:async()=>{await active?.interrupt().catch(()=>active?.close());},exhausted:()=>exhausted,close:()=>{closed=true;abort();signal?.removeEventListener('abort',abort);this.sessions.delete(key);}};
  }
}

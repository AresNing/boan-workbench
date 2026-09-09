import {coordinationHttp} from './coordination.mjs';
import http from 'node:http';
export function modelService({ strictDeepseek = false } = {}) {
 const requests=[], counts=new Map();
 const mock=http.createServer(async(req,res)=>{
  let raw='';for await(const c of req)raw+=c;if(!raw || (!req.url.includes('/messages')&&!req.url.includes('/chat/completions'))){res.writeHead(200,{'Content-Type':'application/json'});res.end('{}');return;}if(req.url.includes('count_tokens')){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({input_tokens:10}));return;}const body=JSON.parse(raw);const anthropic=req.url.includes('/messages');
  requests.push({messages:body.messages,model:body.model,path:req.url,auth:anthropic?req.headers['x-api-key']:req.headers.authorization,effort:body.reasoning_effort,thinking:body.thinking,outputConfig:body.output_config,tier:body.service_tier,speed:body.speed,beta:req.headers['anthropic-beta']});
  if(strictDeepseek){
   const invalid=req.url!=='/chat/completions'||body.store!==undefined||body.max_completion_tokens!==undefined||body.max_tokens<=0||body.messages.some(m=>m.role==='developer'||m.role==='assistant'&&body.thinking?.type==='enabled'&&m.reasoning_content!=='fixture reasoning');
   if(invalid){res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{message:'Invalid DeepSeek protocol or missing reasoning_content'}}));return;}
  }
  if(coordinationHttp(body,res))return;
  const manager=body.tools?.some(t=>(t.name||t.function?.name)?.endsWith('submit_plan'));
  const key=`${body.model}-${manager}`, count=counts.get(key)||0;counts.set(key,count+1);
  const call=manager?(count%2===0?{name:'submit_plan',arguments:{reply:'已安排',actions:[{type:'create',title:body.model,text:'写入 '+body.model}]}}:null):count%3===0?{name:'write_file',arguments:{path:`${body.model}.txt`,content:body.model}}:count%3===1?{name:'submit_result',arguments:{summary:'已完成',verificationCommand:`test -f ${body.model}.txt`}}:null;
  if(call){const matched=body.tools?.find(t=>(t.name||t.function?.name)?.endsWith(call.name));if(matched)call.name=matched.name||matched.function.name;}
  res.writeHead(200,{'Content-Type':'text/event-stream'});
  if(anthropic){
   const event=(type,data)=>res.write(`event: ${type}\ndata: ${JSON.stringify({type,...data})}\n\n`);
   event('message_start',{message:{id:'msg-test',type:'message',role:'assistant',model:body.model,content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:10,output_tokens:0}}});
   event('content_block_start',{index:0,content_block:call?{type:'tool_use',id:`tool-${manager}-${count}`,name:call.name,input:{}}:{type:'text',text:''}});
   event('content_block_delta',{index:0,delta:call?{type:'input_json_delta',partial_json:JSON.stringify(call.arguments)}:{type:'text_delta',text:'已提交'}});
   event('content_block_stop',{index:0});event('message_delta',{delta:{stop_reason:call?'tool_use':'end_turn',stop_sequence:null},usage:{output_tokens:20}});event('message_stop',{});res.end();
  }else{
   const chunk=(delta,finish_reason=null)=>res.write(`data: ${JSON.stringify({id:'chatcmpl-test',object:'chat.completion.chunk',created:1,model:body.model,choices:[{index:0,delta,finish_reason}]})}\n\n`);
   if(strictDeepseek&&body.thinking?.type==='enabled'){chunk({role:'assistant',reasoning_content:'fixture '});chunk({reasoning_content:'reasoning'});}
   chunk(call?{role:'assistant',tool_calls:[{index:0,id:`tool-${manager}-${count}`,type:'function',function:{name:call.name,arguments:JSON.stringify(call.arguments)}}]}:{role:'assistant',content:'已提交'});chunk({},call?'tool_calls':'stop');res.end('data: [DONE]\n\n');
  }
 });
 return { mock, requests };
}

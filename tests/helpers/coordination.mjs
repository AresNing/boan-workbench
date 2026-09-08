export function coordinationForPrompt(text) {
  let data;try{data=JSON.parse(text);}catch{return null;}
  const event=data.managementEvent;if(!event)return null;
  return {type:event.type==='task_ready'?'dispatch_task':event.type==='execution_result'?'request_verification':event.type==='session_unavailable'?'replace_session':event.payload.evidence.passed?'submit_delivery':event.payload.repairBudgetRemaining===0?'observe':'dispatch_task',taskId:event.taskId,expectedVersion:event.stateVersion};
}
export function coordinationHttp(body,res) {
  const tool=body.tools?.find(t=>(t.name||t.function?.name)?.endsWith('submit_coordination'));if(!tool)return false;
  const operation=body.messages.flatMap(m=>{const texts=typeof m.content==='string'?[m.content]:(m.content||[]).map(c=>c.text||'');return texts.map(coordinationForPrompt).filter(Boolean);}).at(-1);
  if(!operation){res.writeHead(500);res.end('Missing management event');return true;}
  const finished=body.messages.some(m=>m.role==='tool'||Array.isArray(m.content)&&m.content.some(c=>c.type==='tool_result'));
  const name=tool.name||tool.function.name,anthropic=Boolean(tool.name);
  res.writeHead(200,{'Content-Type':'text/event-stream'});
  if(anthropic){
    const event=(type,data)=>res.write(`event: ${type}\ndata: ${JSON.stringify({type,...data})}\n\n`);
    event('message_start',{message:{id:'coordination',type:'message',role:'assistant',model:body.model,content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:10,output_tokens:0}}});
    event('content_block_start',{index:0,content_block:finished?{type:'text',text:''}:{type:'tool_use',id:'coordination-tool',name,input:{}}});
    event('content_block_delta',{index:0,delta:finished?{type:'text_delta',text:'安排已提交'}:{type:'input_json_delta',partial_json:JSON.stringify(operation)}});
    event('content_block_stop',{index:0});event('message_delta',{delta:{stop_reason:finished?'end_turn':'tool_use',stop_sequence:null},usage:{output_tokens:10}});event('message_stop',{});res.end();
  }else{
    const chunk=(delta,finish_reason=null)=>res.write(`data: ${JSON.stringify({id:'coordination',object:'chat.completion.chunk',created:1,model:body.model,choices:[{index:0,delta,finish_reason}]})}\n\n`);
    chunk(finished?{role:'assistant',content:'安排已提交'}:{role:'assistant',tool_calls:[{index:0,id:'coordination-tool',type:'function',function:{name,arguments:JSON.stringify(operation)}}]});chunk({},finished?'stop':'tool_calls');res.end('data: [DONE]\n\n');
  }
  return true;
}

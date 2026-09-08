import {randomUUID, createHash} from 'node:crypto';
const stamp=()=>new Date().toISOString();
export function initializeTask(t) {
  t.stateVersion ??= 1; t.requirementVersion ??= 1;
  t.requirements ??= [{id:randomUUID(),version:1,kind:'goal',text:t.goal,status:'active'},...(t.constraints||[]).map(text=>({id:randomUUID(),version:1,kind:'constraint',text,status:'active'}))];
  if(!t.deliveries&&['review','done'].includes(t.status))t.deliveries=[{id:randomUUID(),version:t.requirementVersion,source:'legacy',summary:t.summary,artifacts:[...(t.artifacts||[])],evidence:structuredClone(t.evidence||[]),at:t.completedAt||t.updatedAt,...(t.acceptedAt?{acceptedAt:t.acceptedAt}:{})}];
  if(!t.currentSession&&t.sessions?.length){const last=t.sessions.at(-1);t.currentSession={id:last.id,file:last.file,status:'unavailable'};}
  t.updates ??= []; t.rounds ??= []; t.deliveries ??= []; t.operations ??= []; t.handoffs ??= []; t.generation ??= 0;
  t.dependencies ??= [];
  t.auxiliary ??= [];
  return t;
}
export function revise(t, input) {
  const mode=input.change || 'add';
  if(!['add','replace','revoke'].includes(mode))throw Error('要求更新方式无效');
  const targets=input.requirementIds || [];
  if(!Array.isArray(targets)||targets.some(x=>typeof x!=='string'))throw Error('要求标识无效');
  if(mode==='add'&&targets.length)throw Error('追加要求不能撤销或替代旧要求');
  if(input.acceptance!==undefined&&(!Array.isArray(input.acceptance)||input.acceptance.some(x=>typeof x!=='string')))throw Error('验收标准无效');
  if(mode!=='add' && (!targets.length || targets.some(id=>!t.requirements.some(r=>r.id===id&&r.status==='active'))))throw Error('请选择仍有效的被替代或撤销要求');
  if(targets.some(id=>t.requirements.find(r=>r.id===id)?.kind==='goal') && mode==='revoke')throw Error('任务目标只能替代，不能直接撤销');
  if(new Set(targets.map(id=>t.requirements.find(r=>r.id===id)?.kind)).size>1)throw Error('目标与约束请分别修改');
  const version=++t.requirementVersion, id=randomUUID();
  for(const r of t.requirements)if(targets.includes(r.id)){r.status=mode==='replace'?'replaced':'revoked';r.changedBy=id;}
  if(mode!=='revoke')t.requirements.push({id,version,kind:targets.some(target=>t.requirements.find(r=>r.id===target)?.kind==='goal')?'goal':'constraint',text:input.text,status:'active',replaces:targets});
  t.goal=t.requirements.findLast(r=>r.kind==='goal'&&r.status==='active')?.text || t.goal;
  t.constraints=t.requirements.filter(r=>r.kind==='constraint'&&r.status==='active').map(r=>r.text);
  if(input.acceptance)t.acceptance=input.acceptance;
  const update={id,version,text:input.text,change:mode,requirementIds:targets,status:'saved',savedAt:stamp()};
  t.updates.push(update);t.feedback.push({text:input.text,at:stamp(),version,change:mode});
  for(const e of t.evidence)e.applicability='superseded';
  return update;
}
export function handoff(t, reason) {
  const h={id:randomUUID(),at:stamp(),reason,fromSession:t.currentSession?.id||null,goal:t.goal,requirementVersion:t.requirementVersion,requirements:structuredClone(t.requirements),acceptance:structuredClone(t.acceptance),decisions:structuredClone(t.decisions||[]),artifacts:[...t.artifacts],evidence:structuredClone(t.evidence),completed:t.deliveries.map(d=>({version:d.version,summary:d.summary})),remaining:t.summary,uncertain:structuredClone(t.operations.filter(o=>o.status==='uncertain'||o.status==='started')),next:'核对当前文件、工作区与不确定操作；不得重放旧审批或假定操作尚未发生。'};
  h.workspace={status:'requires_inspection',knownArtifacts:[...t.artifacts],note:'交接时未假定文件仍与旧记录一致；接手前由宿主重新观察，执行者需核对内容。'};
  h.dependencies=structuredClone(t.dependencies || []);h.dependencySources=structuredClone(t.dependencyContext || []);h.dependencyWait=[...(t.dependencyWait || [])];
  h.auxiliary=structuredClone(t.auxiliary || []);
  t.handoffs.push(h);return h;
}
export const fingerprint=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

export const modelIdentity=value=>value?JSON.stringify([value.profileId,value.model,value.effort||'',value.speed||'standard']):'';

export function validateParents(tasks){
  const byId=new Map(tasks.map(t=>[t.id,t]));
  for(const task of tasks){const seen=new Set([task.id]);let parent=task.parentTaskId;
    while(parent){if(typeof parent!=='string'||!byId.has(parent))throw Error('父任务不存在');if(seen.has(parent))throw Error('父子任务关系不能成环');seen.add(parent);parent=byId.get(parent).parentTaskId;}
  }
}

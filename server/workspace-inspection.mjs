import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import {createHash} from 'node:crypto';
import {scopedPath,listFiles} from './files.mjs';

// This is an observation of known artifacts, not a claim that the entire checkout
// is clean or verified. The successor still checks content before changing files.
export async function inspectWorkspace(config,task,signal){
  const observedAt=new Date().toISOString(),artifacts=[];
  for(const file of task.artifacts.slice(0,400)){
    if(signal.aborted)throw Error('现场核对已中止');
    let handle;
    try{
      const resolved=await scopedPath(config.projectPath,file,{protectedRoots:[config.dataDir,config.appDataDir,config.codexHome,config.claudeHome,config.commandLifecycle?.root]});
      handle=await fs.open(resolved,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
      const stat=await handle.stat();if(!stat.isFile())throw Error('not regular');
      if(stat.size>4_000_000){artifacts.push({path:file,status:'too_large',size:stat.size});continue;}
      const data=Buffer.alloc(stat.size+1),{bytesRead}=await handle.read(data,0,data.length,0),after=await handle.stat();
      if(bytesRead!==stat.size||stat.mtimeMs!==after.mtimeMs||stat.size!==after.size){artifacts.push({path:file,status:'changed_during_read'});continue;}
      artifacts.push({path:file,status:'observed',size:bytesRead,sha256:createHash('sha256').update(data.subarray(0,bytesRead)).digest('hex')});
    }catch(e){artifacts.push({path:file,status:e.code==='ENOENT'?'missing':'unavailable'});}
    finally{await handle?.close();}
  }
  const files=await listFiles(config.projectPath);
  if(signal.aborted)throw Error('现场核对已中止');
  return {observedAt,requirementVersion:task.requirementVersion,artifacts,files,listingMayBeTruncated:files.length>=400,
    artifactsTruncated:task.artifacts.length>400,verified:false,scope:'项目可见文件列表和已记录成果；不代表完整工作区已验证。'};
}

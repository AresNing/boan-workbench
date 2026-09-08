import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
const hash = text => createHash('sha256').update(text).digest('hex');
const location = (config, taskId, file) => path.join(config.dataDir, 'artifact-changes', hash(taskId), hash(file) + '.json');

export async function rememberChange(config, taskId, file, before, after) {
  const target = location(config, taskId, file);
  let previous;
  try { previous = JSON.parse(await fs.readFile(target, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  // Preserve the task's baseline only while our last write still matches the
  // file. External edits establish a new baseline, never get attributed to us.
  const original = previous?.afterHash === hash(before ?? '') ? previous.before : before;
  await fs.mkdir(path.dirname(target), {recursive:true,mode:0o700});
  const temporary = target + '.' + randomUUID();
  try { await fs.writeFile(temporary, JSON.stringify({before:original,afterHash:hash(after)}), {mode:0o600}); await fs.rename(temporary,target); }
  finally { await fs.rm(temporary,{force:true}); }
}
export async function artifactChange(config, taskId, file, content) {
  try {
    const record = JSON.parse(await fs.readFile(location(config,taskId,file),'utf8'));
    if (record.afterHash !== hash(content)) return { stale:true };
    const left = record.before === null ? [] : record.before.split('\n'), right = content.split('\n');
    let start=0,end=0;
    while(start<left.length&&start<right.length&&left[start]===right[start])start++;
    while(end<left.length-start&&end<right.length-start&&left[left.length-end-1]===right[right.length-end-1])end++;
    return { added:record.before===null, diff:[`--- ${record.before===null?'/dev/null':file}`,`+++ ${file}`,`@@ -${start+1},${left.length-start-end} +${start+1},${right.length-start-end} @@`,...left.slice(start,left.length-end).map(l=>'-'+l),...right.slice(start,right.length-end).map(l=>'+'+l)].join('\n') };
  } catch(e) { if(e.code==='ENOENT')return null; throw e; }
}

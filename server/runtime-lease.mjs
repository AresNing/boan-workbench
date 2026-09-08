import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {spawn,execFileSync} from 'node:child_process';

const digest=s=>createHash('sha256').update(s).digest('hex');
const uid=process.getuid?.();
function alive(group){try{process.kill(-group,0);return true;}catch(e){if(e.code==='ESRCH')return false;throw Error('无法确认上次命令进程是否停止，暂不接管项目');}}
function bootIdentity(){
  if(process.platform==='darwin')return execFileSync('/usr/sbin/sysctl',['-n','kern.bootsessionuuid'],{encoding:'utf8'}).trim();
  if(process.platform==='linux')return fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim();
  throw Error('此系统尚未提供可靠的项目执行互斥');
}
function lockDescriptor(fd){
  // macOS 13/14 do not ship lockf. System Perl exposes BSD flock without
  // requiring developer tools or a separately installed native module.
  const mac=process.platform==='darwin',executable=mac?'/usr/bin/perl':'/usr/bin/flock';
  return new Promise((resolve,reject)=>{
    // The child locks the inherited open file description. Our retained descriptor
    // owns that same kernel lock after the helper exits. It is never given to tools.
    const args=mac?['-MFcntl=:flock','-e','open(my $lock, "+<&=3") or exit 2; flock($lock, LOCK_EX | LOCK_NB) or exit 1;']:['-n','3'];
    const child=spawn(executable,args,{stdio:['ignore','ignore','ignore',fd],env:{PATH:'/usr/bin:/bin'}});
    const timer=setTimeout(()=>{child.kill();reject(Error('项目互斥检查超时，未启动执行'));},5000);
    child.once('error',e=>{clearTimeout(timer);reject(e);});
    child.once('exit',code=>{clearTimeout(timer);code===0?resolve():reject(Error('此项目或状态目录已有服务运行，请先关闭原服务。'));});
  });
}
export async function acquireRuntimeLease(config){
  if(!['darwin','linux'].includes(process.platform)||!Number.isInteger(uid))throw Error('此系统尚未提供可靠的项目执行互斥');
  const root=path.join(process.platform==='darwin'?'/private/tmp':'/tmp',`boan-runtime-locks-${uid}`);
  try{fs.mkdirSync(root,{mode:0o700});}catch(e){if(e.code!=='EEXIST')throw e;}
  const stat=fs.lstatSync(root);
  if(!stat.isDirectory()||stat.isSymbolicLink()||stat.uid!==uid||(stat.mode&0o077))throw Error('项目互斥目录权限不安全，未启动执行');
  const projectKey=digest(fs.realpathSync(config.projectPath)),stateKey=digest(fs.realpathSync(config.dataDir));
  const descriptors=[],boot=bootIdentity(),commandsFile=path.join(root,`project-${projectKey}.commands.json`);
  const recordPid=path.join(config.dataDir,'server.lock');let legacyOwned=false,closed=false;
  function release(){if(closed)return;closed=true;if(legacyOwned){try{if(fs.readFileSync(recordPid,'utf8')===String(process.pid))fs.unlinkSync(recordPid);}catch{}}
    for(const fd of descriptors)try{fs.closeSync(fd);}catch{};process.off('exit',release);
  }
  try{
    for(const key of [`project-${projectKey}`,`state-${stateKey}`].sort()){
      const file=path.join(root,`${key}.lock`),fd=fs.openSync(file,fs.constants.O_CREAT|fs.constants.O_RDWR|fs.constants.O_NOFOLLOW,0o600);descriptors.push(fd);
      const info=fs.fstatSync(fd);if(!info.isFile()||info.uid!==uid||(info.mode&0o077))throw Error('项目锁文件权限不安全');
      await lockDescriptor(fd);
    }
    let groups=[];
    try{const entry=JSON.parse(fs.readFileSync(commandsFile,'utf8'));if(!/^[a-f0-9-]{36}$/i.test(entry.boot||'')||!Array.isArray(entry.groups)||entry.groups.some(g=>!Number.isSafeInteger(g.pid)||g.pid<=1))throw Error('上次命令占用记录无效，不能自动接管');if(entry.boot===boot)groups=entry.groups.filter(g=>alive(g.pid));}
    catch(e){if(e.code!=='ENOENT')throw e;}
    if(groups.length)throw Error(`上次命令进程组仍存活（${groups.map(g=>g.pid).join('、')}），不能启动重复执行；请先确认并停止原命令。`);
    // Older versions only know server.lock. Honor a live legacy owner before recovery.
    if(fs.existsSync(recordPid)){
      const pid=Number(fs.readFileSync(recordPid,'utf8'));if(!Number.isSafeInteger(pid)||pid<=1)throw Error('旧服务占用记录无效，请先核对原服务');
      try{process.kill(pid,0);throw Error('此状态目录已有服务运行，请先关闭原服务。');}catch(e){if(e.code!=='ESRCH')throw e;}
      fs.unlinkSync(recordPid);
    }
    fs.writeFileSync(recordPid,String(process.pid),{flag:'wx',mode:0o600});legacyOwned=true;process.on('exit',release);
    const save=()=>{const tmp=`${commandsFile}.${randomUUID()}.tmp`;try{fs.writeFileSync(tmp,JSON.stringify({boot,groups}),{mode:0o600,flag:'wx'});fs.renameSync(tmp,commandsFile);}finally{try{fs.unlinkSync(tmp);}catch{}}};save();
    return {root,release,
      commandStarted(pid){if(closed)throw Error('项目执行占用已释放');if(!Number.isSafeInteger(pid)||pid<=1)throw Error('命令进程标识无效');groups.push({pid,at:new Date().toISOString()});save();},
      commandSettled(pid){if(closed)return;groups=groups.filter(g=>g.pid!==pid||alive(g.pid));save();},
    };
  }catch(e){release();throw e;}
}

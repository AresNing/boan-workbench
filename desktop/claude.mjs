import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { claudeExecutable, claudeEnv, claudeOptions } from '../server/claude-client.mjs';

export class ClaudeLogin {
  constructor(dir, openExternal, options={}) { this.home=path.join(dir,'claude');this.openExternal=openExternal;this.executable=options.executable || claudeExecutable();this.spawn=options.spawn || spawn;this.error='';this.catalog=[]; }
  async initialize(){await fs.mkdir(this.home,{recursive:true,mode:0o700});try{this.catalog=JSON.parse(await fs.readFile(path.join(this.home,'boan-models.json'),'utf8'));}catch{} }
  run(args) { return new Promise((resolve,reject)=>{
    const child=this.spawn(this.executable,args,{cwd:this.home,env:claudeEnv(this.home),stdio:['ignore','pipe','pipe']});let out='';const timer=setTimeout(()=>{child.kill();reject(Error('Claude 状态检查超时'));},15000);
    child.stdout.on('data',b=>{if(out.length<100000)out+=b;});child.stderr.on('data',()=>{});child.on('error',e=>{clearTimeout(timer);reject(e);});child.on('exit',code=>{clearTimeout(timer);resolve({code,out});});
  }); }
  async status(force=false){
    if(!force&&this.cached&&Date.now()-this.at<2500)return {...this.cached,pending:Boolean(this.child),error:this.error};
    const {out}=await this.run(['auth','status']);let raw;try{raw=JSON.parse(out);}catch{throw Error('无法读取 Claude 登录状态');}
    this.cached={loggedIn:raw.loggedIn===true&&['claude.ai','oauth'].includes(raw.authMethod),email:raw.email||null,plan:raw.subscriptionType||null};this.at=Date.now();
    return {...this.cached,pending:Boolean(this.child),error:this.error};
  }
  async login(){
    if(this.child)return this.status();this.error='';
    const child=this.spawn(this.executable,['auth','login','--claudeai'],{cwd:this.home,env:claudeEnv(this.home),stdio:['pipe','pipe','pipe']});this.child=child;let output='',opened=false;
    const consume=b=>{output=(output+b).slice(-20000);for(const match of output.matchAll(/https:\/\/[^\s\x1b]+/g)){let url;try{url=new URL(match[0]);}catch{continue;}
      if(!opened&&['claude.ai','platform.claude.com','console.anthropic.com','claude.com'].includes(url.hostname)&&/oauth|authorize/.test(url.pathname)){opened=true;void this.openExternal(url.href).catch(()=>{this.error='浏览器未能打开，请取消后重试。';});}
    }};
    child.stdout.on('data',consume);child.stderr.on('data',consume);
    const clear=()=>{if(this.child!==child)return false;clearTimeout(this.timer);this.child=null;this.at=0;return true;};
    child.on('error',()=>{if(clear())this.error='Claude 登录组件未能启动。';});
    child.on('exit',code=>{if(clear()&&code&&!this.cancelled)this.error='Claude 登录未完成，请重试。';});
    this.cancelled=false;this.timer=setTimeout(()=>{this.cancelled=true;child.kill();this.error='登录等待已超时，请重试。';},10*60000);
    return {loggedIn:false,pending:true,error:''};
  }
  submitCode(code){if(!this.child||typeof code!=='string'||!code.trim()||code.length>4000||/[\r\n]/.test(code))throw Error('请填写浏览器显示的授权码');this.child.stdin.write(code.trim()+'\n');return {pending:true};}
  cancel(){this.cancelled=true;this.child?.kill();this.child=null;clearTimeout(this.timer);this.error='';this.at=0;return this.status(true);}
  async logout(){await this.cancel();const {code}=await this.run(['auth','logout']);if(code)throw Error('Claude 退出失败，请重试');this.catalog=[];await fs.rm(path.join(this.home,'boan-models.json'),{force:true});return this.status(true);}
  async models(refresh=false){
    if(!refresh)return this.catalog;if(this.loading)return this.loading;
    this.loading=(async()=>{const {query}=await import('@anthropic-ai/claude-agent-sdk');let release;const gate=new Promise(r=>{release=r;});
      const q=query({prompt:(async function*(){await gate;})(),options:claudeOptions({claudeHome:this.home,claudeExecutable:this.executable,projectPath:this.home})});
      const timer=setTimeout(()=>q.close(),15000);
      try{const list=await q.supportedModels();this.catalog=list.map(m=>({id:m.value,name:m.displayName,efforts:m.supportedEffortLevels||[],speeds:[{value:'standard',label:'标准'},...(m.supportsFastMode?[{value:'fast',label:'快速'}]:[])]}));await fs.writeFile(path.join(this.home,'boan-models.json'),JSON.stringify(this.catalog),{mode:0o600});return this.catalog;}
      finally{clearTimeout(timer);release();q.close();}})();try{return await this.loading;}finally{this.loading=null;}
  }
  close(){this.cancelled=true;this.child?.kill();clearTimeout(this.timer);}
}

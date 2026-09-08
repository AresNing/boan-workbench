// Render the real UI with deterministic public fixtures. No app data, account,
// backend process or external service is accessed. Run after npm run build.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';

const root=fileURLToPath(new URL('../',import.meta.url));
const output=path.join(root,'docs/images');
const at='2026-09-08T10:00:00.000Z';
const model={profileId:'sample',provider:'Example provider',model:'sample-model',label:'Sample model',connection:'api',available:true,efforts:['low','medium','high'],speeds:[{value:'standard',label:'Standard'}]};
function task(id,title,status,extra={}) {
 return {id,title,status,goal:title,summary:'',priority:'normal',createdAt:at,updatedAt:at,attempts:1,constraints:[],acceptance:[],evidence:[],artifacts:[],sessions:[],decisions:[],feedback:[],dependencies:[],auxiliary:[],requirements:[],deliveries:[],updates:[],rounds:[],operations:[],handoffs:[],decision:null,deferredUntil:null,requirementVersion:1,stateVersion:1,generation:1,...extra};
}
const tasks=[
 task('csv','Fix CSV export escaping','review',{goal:'Handle commas, quotes and newlines in exported orders. Keep the existing API unchanged.',summary:'CSV escaping is updated. Edge-case tests passed; the change is ready for your review.',constraints:['Keep the export API unchanged.','Do not introduce new dependencies.'],acceptance:['Quoted fields round-trip correctly.','Empty exports return an empty string.'],artifacts:['export-notes.md'],evidence:[{passed:true,at,command:'node --test export.test.mjs',output:'4 tests passed: plain fields, commas, quotes and empty input.',exitCode:0}]}),
 task('signin','Add GitHub sign-in','blocked',{summary:'Choose how GitHub identities connect to existing accounts.',decision:{kind:'business',question:'How should GitHub identities link to existing accounts?',recommendation:'Let users link an account after signing in.',options:['Link after sign-in','Use separate accounts']}}),
 task('search','Improve product search','running',{summary:'Checking empty queries and keyboard navigation.'}),
 task('docs','Document the export endpoint','queued',{summary:'Starts after the CSV export result is accepted.',dependencies:[{taskId:'csv',gate:'accepted'}]}),
 task('theme','Add a system theme option','done',{summary:'Light and dark themes now follow system appearance.',acceptedAt:at}),
 task('shortcuts','Add keyboard shortcuts','done',{summary:'Task creation and project switching shortcuts are available.',acceptedAt:at}),
];
const projects=[
 {id:'storefront',name:'storefront',path:'/example/projects/storefront',tasks,active:2,attention:2,done:2},
 {id:'design-system',name:'design-system',path:'/example/projects/design-system',tasks:[task('tokens','Review spacing tokens','review',{summary:'Spacing tokens are ready to review.'}),task('buttons','Check button contrast','running')],active:1,attention:1,done:3},
 {id:'docs-site',name:'docs-site',path:'/example/projects/docs-site',tasks:[task('guide','Update the quick-start guide','done',{acceptedAt:at})],active:0,attention:0,done:1},
].map(p=>({...p,mode:'pi',status:'ready',managerBusy:false,selected:p.id==='storefront'}));
const state={version:1,revision:1,project:{id:'storefront',name:'storefront',path:projects[0].path,mode:'pi'},tasks,attentionIds:['csv','signin'],overview:'',events:[],messages:[],requests:{},actions:{},managerBusy:false,preparation:null,modelOptions:[model],defaultModel:model,permissions:{mode:'auto',sandboxAvailable:true,networkGrants:[],grants:[]}};
const markdown='# CSV export update\n\n- Existing API preserved; no new dependencies\n- Four edge-case tests passed';
const browser=await chromium.launch({headless:true});
try {
 const page=await browser.newPage({viewport:{width:1440,height:1120},deviceScaleFactor:2,locale:'en-US',timezoneId:'UTC',colorScheme:'dark',reducedMotion:'reduce'});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',async route=>{
  const url=new URL(route.request().url());
  if(url.origin!=='http://boan.test')throw Error('Unexpected external request');
  if(url.pathname==='/api/state')return route.fulfill({json:state});
  if(url.pathname==='/api/artifact')return route.fulfill({json:{path:'export-notes.md',content:markdown}});
  if(url.pathname.startsWith('/api/'))return route.fulfill({json:{}});
  const name=url.pathname==='/'?'index.html':decodeURIComponent(url.pathname.slice(1));
  const file=path.resolve(root,'dist',name);if(!file.startsWith(path.join(root,'dist')+path.sep))throw Error('Invalid asset path');
  const types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml'};
  return route.fulfill({contentType:types[path.extname(file)]||'application/octet-stream',body:await fs.readFile(file)});
 });
 await page.addInitScript(({state,projects})=>{
  localStorage.setItem('workbench:language','en');localStorage.setItem('workbench:appearance','dark');
  window.desktop={getSettings:async()=>({mode:'pi',language:'en'}),onCommand:()=>()=>{},getProjects:async()=>({activeId:'storefront',projects,switching:false}),onProjects:()=>()=>{}};
  window.EventSource=class{constructor(){queueMicrotask(()=>this.onmessage?.({data:JSON.stringify(state)}));}close(){}};
 },{state,projects});
 await fs.mkdir(output,{recursive:true});
 await page.goto('http://boan.test/');
 await page.getByRole('heading',{name:'CSV export update',exact:true}).waitFor();
 async function capture(name) {
  await page.evaluate(()=>document.fonts.ready);
  const text=await page.locator('body').innerText();
  if(/\p{Script=Han}|\/Users\/|@126\.com|ai-agent-new-form/u.test(text))throw Error('Non-public or non-English content in screenshot');
  if(errors.length)throw Error(errors.join('\n'));
  await page.screenshot({path:path.join(output,name),animations:'disabled'});
  console.log(name);
 }
 await capture('workbench-en.png');
 await page.getByRole('button',{name:/^Task board/}).click();
 await page.getByRole('button',{name:'Board',exact:true}).click();
 await page.locator('.kanban-column').first().waitFor();
 await capture('task-board-en.png');
 await page.getByRole('button',{name:/^All projects/}).click();
 await page.getByRole('heading',{name:'All projects',exact:true}).waitFor();
 await page.getByRole('combobox',{name:'Appearance',exact:true}).click();
 await page.getByRole('option',{name:'Light',exact:true}).click();
 await page.waitForFunction(()=>document.documentElement.dataset.theme==='light');
 await capture('projects-en.png');
} finally {await browser.close();}

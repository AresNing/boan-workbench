import {test,expect} from '@playwright/test';

async function setup(page,request,overrides={}) {
 const base=await(await request.get('/api/state')).json();
 const task={...base.tasks[0],id:'a',title:'任务 A',status:'review',decision:null,summary:'已更新项目说明',artifacts:['result.md','landscape.svg','change.diff'],acceptance:['内容符合目标'],evidence:[{passed:true,at:new Date().toISOString(),command:'check',output:'passed',exitCode:0}]};
 const state={...base,tasks:[task],attentionIds:['a'],managerBusy:false,preparation:null,...overrides};
 await page.route('**/api/state',route=>route.fulfill({json:state}));
 await page.addInitScript(state=>{window.EventSource=class {constructor(){queueMicrotask(()=>this.onmessage?.({data:JSON.stringify(state)}));}close(){}};},state);
 return state;
}
test('成果图片与文档可直接预览，验证和验收同区，恶意标记不执行',async({page,request})=>{
 await setup(page,request);
 await page.route('**/api/artifact?*',route=>{const file=new URL(route.request().url()).searchParams.get('path');return route.fulfill({json:{path:file,mime:file.endsWith('svg')?'image/svg+xml':undefined,content:file.endsWith('svg')?'<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><script>window.hacked=1</script><rect width="100" height="100" fill="red"/></svg>':file.endsWith('diff')?'--- before\n+++ after\n-old\n+new':'# 交付说明\n- **新增预览**\n| 项目 | 结果 |\n| --- | --- |\n| 文档 | 可读 |\n<script>window.hacked=1</script>'}});});
 let accepted;await page.route('**/api/tasks/a/actions',route=>{accepted=route.request().postDataJSON();return route.fulfill({json:{...(JSON.parse(JSON.stringify({})))},status:400});});
 await page.goto('/');const delivery=page.getByRole('region',{name:'成果与验收'});
 await expect(delivery.getByRole('heading',{name:'交付说明'})).toBeVisible();await expect(delivery.getByRole('cell',{name:'可读',exact:true})).toBeVisible();await expect(delivery.locator('strong').filter({hasText:'新增预览'})).toBeVisible();
 await expect(delivery.getByText('验证通过',{exact:true})).toBeVisible();
 await delivery.getByRole('button',{name:'landscape.svg',exact:true}).click();await expect(delivery.getByRole('img')).toBeVisible();
 await expect.poll(()=>delivery.getByRole('img').evaluate(img=>img.complete&&img.naturalWidth>0)).toBe(true);
 expect(await page.evaluate(()=>window.hacked)).toBeUndefined();
 await delivery.getByRole('button',{name:'change.diff',exact:true}).click();await expect(delivery.locator('.diff-added')).toContainText(['+++ after','+new']);
 await delivery.getByRole('button',{name:'确认完成',exact:true}).click();await expect.poll(()=>accepted?.type).toBe('accept');
});
test('失败按原因提供恢复入口，暂停显示继续执行',async({page,request})=>{
 const base=await(await request.get('/api/state')).json();
 await setup(page,request,{tasks:[{...base.tasks[0],id:'a',title:'登录失效任务',status:'failed',decision:null,summary:'401 unauthorized token expired',artifacts:[]}],attentionIds:['a']});
 await page.goto('/');await expect(page.getByRole('button',{name:'重新登录',exact:true})).toBeVisible();await expect(page.getByText('401 unauthorized token expired',{exact:true})).toBeHidden();
 await page.getByText('错误详情',{exact:true}).click();await expect(page.getByText('401 unauthorized token expired',{exact:true})).toBeVisible();
 await page.getByRole('button',{name:'重新登录',exact:true}).click();await expect(page.getByRole('heading',{name:'设置',exact:true})).toBeVisible();
});
test('跨项目待处理直达具体任务且不改变已有草稿提交对象',async({page,request})=>{
 const base=await(await request.get('/api/state')).json();
 const stateA={...base,project:{...base.project,id:'p1',path:'/p1'},tasks:[{...base.tasks[0],id:'a',title:'项目一任务',status:'paused',decision:null}],attentionIds:[]};
 const stateB={...base,project:{...base.project,id:'p2',path:'/p2'},tasks:[{...base.tasks[0],id:'b',title:'项目二待决定',status:'blocked'},{...base.tasks[0],id:'c',title:'项目二待验收',status:'review'}],attentionIds:['b','c']};
 await page.route('**/api/state',route=>route.fulfill({json:route.request().headers()['x-workbench-project']==='p2'?stateB:stateA}));
 await page.addInitScript(({stateA,stateB})=>{
 const snapshot={activeId:'p1',projects:[{id:'p1',name:'项目一',status:'ready',tasks:stateA.tasks,active:0,attention:0,done:0},{id:'p2',name:'项目二',status:'ready',tasks:stateB.tasks,active:0,attention:2,done:0}]};
 window.desktop={getSettings:async()=>({}),onCommand:()=>()=>{},getProjects:async()=>snapshot,onProjects:callback=>{window.projectCallback=callback;return()=>{};},selectProject:async id=>{snapshot.activeId=id;window.projectCallback(snapshot);}};
 window.EventSource=class {constructor(url){const state=url.includes('p2')?stateB:stateA;queueMicrotask(()=>this.onmessage?.({data:JSON.stringify(state)}));}close(){}};
 },{stateA,stateB});
 await page.goto('/');await page.getByRole('textbox',{name:'交代工作或补充要求'}).fill('项目一草稿');
 await page.getByRole('button',{name:/^所有项目/}).click();
 await page.getByRole('region',{name:'跨项目待处理'}).getByRole('button',{name:/项目二待验收/}).click();
 await expect(page.locator('.focus-card h2')).toHaveText('项目二待验收');
 await expect(page.getByRole('combobox',{name:'沟通范围'})).toHaveText('新任务');
 expect(await page.evaluate(()=>localStorage.getItem('draft:/p1'))).toBe('项目一草稿');
});
test('暂停可直接继续，失败与暂停均进入待处理，详情切换保留阅读位置',async({page,request})=>{
 const base=await(await request.get('/api/state')).json();
 await setup(page,request,{tasks:[{...base.tasks[0],id:'a',title:'暂停任务',status:'paused',decision:null,constraints:Array.from({length:30},(_,i)=>`约束 ${i}`)},{...base.tasks[0],id:'b',title:'失败任务',status:'failed',decision:null}],attentionIds:[]});
 let action;await page.route('**/api/tasks/a/actions',r=>{action=r.request().postDataJSON();return r.fulfill({status:400,json:{error:'测试结束'}});});
 await page.goto('/');await page.getByRole('button',{name:'继续执行',exact:true}).click();await expect.poll(()=>action?.type).toBe('resume');
 await page.getByRole('button',{name:'任务详情',exact:true}).click();const overview=page.locator('#detail-panel-overview');await overview.evaluate(e=>e.scrollTop=240);const position=await overview.evaluate(e=>e.scrollTop);expect(position).toBeGreaterThan(100);
 await page.getByRole('tab',{name:'成果',exact:true}).click();await page.getByRole('tab',{name:'概览',exact:true}).click();expect(await overview.evaluate(e=>e.scrollTop)).toBe(position);
 await page.getByRole('button',{name:'收起任务背景',exact:true}).click();await page.getByRole('button',{name:/^项目看板/}).click();await expect(page.locator('.kanban-column').first().locator('h4')).toHaveText(['暂停任务','失败任务']);
 await page.getByRole('button',{name:'看板',exact:true}).click();await expect(page.locator('.kanban')).toHaveClass(/three-columns/);await expect(page.locator('.kanban-column')).toHaveCount(3);
});

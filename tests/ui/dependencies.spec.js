import {test,expect} from '@playwright/test';

test('依赖入口展示等待原因，查看上游保留草稿和提交对象，旧验证不显示有效通过',async({page,request})=>{
  const base=await (await request.get('/api/state')).json(),example=base.tasks[0];
  const upstream={...example,id:'upstream',title:'准备数据',status:'paused',decision:null,dependencies:[]};
  const downstream={...example,id:'downstream',title:'生成报表',status:'queued',decision:null,dependencies:[{taskId:upstream.id,mode:'verified'}],dependencyWait:['等待「准备数据」通过验证并提交最新成果'],summary:'等待「准备数据」通过验证并提交最新成果',evidence:[{passed:true,applicability:'superseded'}]};
  const state={...base,tasks:[downstream,upstream],attentionIds:[],events:[],messages:[]};
  await page.route('**/api/state',route=>route.fulfill({json:state}));
  await page.addInitScript(state=>{window.EventSource=class{constructor(){queueMicrotask(()=>this.onmessage?.({data:JSON.stringify(state)}));}close(){}};},state);
  await page.goto('/');
  await expect(page.locator('.focus-card h2')).toHaveText('生成报表');
  await page.getByRole('button',{name:'补充要求',exact:true}).click();
  const scope=page.getByRole('combobox',{name:'沟通范围'}),input=page.getByRole('textbox',{name:'交代工作或补充要求'});
  await input.fill('报表保留中文列名');await expect(scope).toHaveText('补充要求 · 生成报表');
  await page.getByRole('button',{name:'任务详情',exact:true}).click();
  await expect(page.getByRole('complementary',{name:'任务背景'})).toContainText('依赖任务');
  await expect(page.getByRole('button',{name:/要求已变化，需重新验证/})).toBeVisible();
  await page.screenshot({path:'/tmp/boan-dependency-light.png'});
  await page.emulateMedia({colorScheme:'dark'});await page.screenshot({path:'/tmp/boan-dependency-dark.png'});
  await page.getByRole('button',{name:'准备数据 使用已验证成果'}).click();
  await expect(page.locator('.focus-card h2')).toHaveText('准备数据');
  await expect(input).toHaveValue('报表保留中文列名');await expect(scope).toHaveText('补充要求 · 生成报表');
});

test('父子任务入口显示各自状态，浏览相关任务不改变输入对象或草稿',async({page,request})=>{
  const base=await (await request.get('/api/state')).json(),example=base.tasks[0];
  const parent={...example,id:'parent',title:'交付网站',status:'paused',decision:null,dependencies:[],parentTaskId:null};
  const child={...example,id:'child',title:'交付使用文档',status:'review',summary:'文档待验收',decision:null,dependencies:[],parentTaskId:'parent'};
  const state={...base,tasks:[parent,child],attentionIds:[],events:[],messages:[]};
  await page.route('**/api/state',route=>route.fulfill({json:state}));
  await page.addInitScript(state=>{window.EventSource=class{constructor(){queueMicrotask(()=>this.onmessage?.({data:JSON.stringify(state)}));}close(){}};},state);
  await page.goto('/');await page.getByRole('button',{name:'补充要求',exact:true}).click();
  const input=page.getByRole('textbox',{name:'交代工作或补充要求'}),scope=page.getByRole('combobox',{name:'沟通范围'});await input.fill('网站保留浅色主题');
  await page.getByRole('button',{name:'任务详情',exact:true}).click();
  await page.getByRole('button',{name:/交付使用文档 子任务/}).click();
  await expect(page.locator('.focus-card h2')).toHaveText('交付使用文档');await expect(input).toHaveValue('网站保留浅色主题');await expect(scope).toHaveText('补充要求 · 交付网站');
  await expect(page.getByRole('button',{name:/交付网站 父任务/})).toBeVisible();
});

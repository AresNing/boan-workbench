import { test, expect } from '@playwright/test';
import { defaults } from '../../desktop/settings.mjs';

test('模型下拉可搜索、键盘选择、多选；空结果不提交，项目与共享服务选择隔离', async ({page,request})=>{
  const base=await(await request.get('/api/state')).json();
  const state={...base,project:{...base.project,mode:'pi'}};
  await page.route('**/api/state',r=>r.fulfill({json:state}));
  await page.addInitScript(({state,defaults})=>{
    window.savedProfiles=[];
    window.desktop={
      getSettings:async()=>({...defaults,mode:'pi',provider:'deepseek',model:'old-model',projectPath:'/example/project',hasApiKey:true}),
      getModelCatalog:async provider=>provider==='deepseek'?[{id:'deepseek-v4-flash',name:'DeepSeek V4 Flash'},{id:'deepseek-v4-pro',name:'DeepSeek V4 Pro'}]:[{id:'other-model',name:'Other'}],
      getModelProfiles:async()=>[],saveModelProfile:async profile=>{window.savedProfiles.push(profile);return [];},
      chatgptStatus:async()=>({loggedIn:false}),onCommand:()=>()=>{},
    };
    window.EventSource=class{constructor(){queueMicrotask(()=>this.onmessage?.({data:JSON.stringify(state)}));}close(){}};
  },{state,defaults});
  await page.goto('/');await page.getByRole('button',{name:'设置',exact:true}).click();
  const nav=page.getByRole('navigation',{name:'设置分类'});
  await nav.getByRole('button',{name:'项目模型',exact:true}).click();
  const projectModel=page.getByRole('combobox',{name:'模型名称',exact:true}),search=page.getByRole('textbox',{name:'搜索模型',exact:true});
  await expect(projectModel).toContainText('old-model');await projectModel.click();
  await search.fill('not-found');await expect(page.getByText('没有匹配的模型',{exact:true})).toBeVisible();await search.press('Enter');
  await expect(projectModel).toContainText('old-model');await search.fill('PRO');await expect(page.getByRole('option')).toHaveCount(1);await search.press('Enter');
  await expect(projectModel).toContainText('deepseek-v4-pro');await expect(search).toBeHidden();
  await page.getByLabel('API Key',{exact:true}).fill('public-fixture-draft');
  await projectModel.click();await search.press('Escape');await expect(page.getByRole('heading',{name:'设置',exact:true})).toBeVisible();
  await nav.getByRole('button',{name:'账号与服务',exact:true}).click();await page.getByRole('button',{name:'添加厂商',exact:true}).click();
  await page.getByRole('combobox',{name:'厂商',exact:true}).click();await page.getByRole('option',{name:'DeepSeek',exact:true}).click();
  const shared=page.getByRole('combobox',{name:'模型',exact:true});await shared.click();
  await search.fill('flash');await search.press('Enter');await expect(shared).not.toContainText('flash');await expect(shared).toContainText('pro');
  expect(await page.evaluate(()=>window.savedProfiles.length)).toBe(0);
  await search.fill('');await page.getByRole('option',{name:/^deepseek-v4-flash/}).click();
  await page.setViewportSize({width:680,height:620});await expect(search).toBeInViewport();await expect(page.getByRole('listbox',{name:'模型',exact:true})).toBeInViewport();
  await page.screenshot({path:'docs/screenshots/model-search.png'});
  await page.getByRole('button',{name:'完成选择',exact:true}).click();
  await page.getByRole('button',{name:'保存服务',exact:true}).click();
  expect((await page.evaluate(()=>window.savedProfiles[0])).models.split('\n').sort()).toEqual(['deepseek-v4-flash','deepseek-v4-pro']);
  await nav.getByRole('button',{name:'项目模型',exact:true}).click();await expect(projectModel).toContainText('deepseek-v4-pro');await expect(page.getByLabel('API Key',{exact:true})).toHaveValue('public-fixture-draft');
});

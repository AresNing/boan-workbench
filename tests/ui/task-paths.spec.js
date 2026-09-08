import {test,expect} from '@playwright/test';

test('浏览任务不改变提交对象，补充要求不覆盖草稿，刷新保留目标，新任务一键聚焦',async({page,request})=>{
 const base=await(await request.get('/api/state')).json();
 const tasks=['a','b'].map(id=>({...base.tasks[0],id,title:`任务 ${id.toUpperCase()}`,status:'running',decision:null,summary:'正在执行',artifacts:[]}));
 const state={...base,tasks,attentionIds:[],events:[],messages:[],managerBusy:false,preparation:null};
 await page.route('**/api/state',route=>route.fulfill({json:state}));
 await page.addInitScript(state=>{window.EventSource=class{constructor(){queueMicrotask(()=>this.onmessage?.({data:JSON.stringify(state)}));}close(){}};},state);
 let submitted;await page.route('**/api/messages',route=>{submitted=route.request().postDataJSON();return route.fulfill({json:{reply:'已提交'}});});
 await page.goto('/');
 const input=page.getByRole('textbox',{name:'交代工作或补充要求'}),scope=page.getByRole('combobox',{name:'沟通范围'});
 await input.fill('保留已有草稿');
 const choose=async name=>{await page.getByRole('button',{name:'进行中 2',exact:true}).click();await page.getByRole('region',{name:'筛选任务'}).getByRole('button',{name:new RegExp(name)}).click();};
 await choose('任务 B');await expect(page.locator('.focus-card h2')).toHaveText('任务 B');
 await expect(scope).toHaveText('新任务');await expect(input).toHaveValue('保留已有草稿');
 await page.getByRole('button',{name:'补充要求',exact:true}).click();await expect(input).toBeFocused();
 await expect(input).toHaveValue('保留已有草稿');await expect(scope).toContainText('任务 B');
 await choose('任务 A');await expect(page.getByText('补充至：任务 B')).toBeVisible();await expect(page.getByRole('button',{name:'返回该任务'})).toBeVisible();await expect(page.getByRole('button',{name:'发送要求'})).toHaveAttribute('title','发送补充至：任务 B');await expect(scope).toContainText('任务 B');await expect(input).toHaveValue('保留已有草稿');
 await page.reload();await expect(scope).toContainText('任务 B');await expect(input).toHaveValue('保留已有草稿');
 await page.getByRole('button',{name:'发送要求',exact:true}).click();await expect.poll(()=>submitted?.focusId).toBe('b');await expect(input).toHaveValue('');
 await input.fill('新的项目任务');await page.getByRole('button',{name:'新建任务',exact:true}).click();
 await expect(scope).toHaveText('新任务');await expect(input).toHaveValue('新的项目任务');await expect(input).toBeFocused();
 await page.getByRole('button',{name:'发送要求',exact:true}).click();await expect.poll(()=>submitted?.focusId).toBe(null);
 await expect(page.locator('body')).not.toContainText('与你一起，把事情做完');
 await page.screenshot({path:'docs/screenshots/simple-workbench.png'});
});

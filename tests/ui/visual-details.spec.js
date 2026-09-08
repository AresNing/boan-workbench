import {test,expect} from '@playwright/test';
test('附件支持选择、粘贴与拖入，按提交对象保存并随消息送达',async({page,request})=>{
 const base=await(await request.get('/api/state')).json(),state={...base,tasks:[{...base.tasks[0],id:'a',status:'paused',decision:null}],managerBusy:false,preparation:null,attentionIds:[]};
 await page.route('**/api/state',r=>r.fulfill({json:state}));await page.addInitScript(state=>{window.EventSource=class{constructor(){queueMicrotask(()=>this.onmessage?.({data:JSON.stringify(state)}));}close(){}};},state);
 let sent;await page.route('**/api/messages',r=>{sent=r.request().postDataJSON();return r.fulfill({json:{reply:'材料已接收'}});});
 await page.route('**/api/files',r=>r.fulfill({json:{files:['existing.md']}}));
 await page.goto('/');await page.getByRole('button',{name:'引用项目文件',exact:true}).click();await page.getByRole('combobox',{name:'选择项目文件',exact:true}).click();await page.getByRole('option',{name:'existing.md',exact:true}).click();await expect(page.locator('.attachment-list')).toContainText('existing.md');
 await page.locator('input[type=file]').setInputFiles({name:'reference.md',mimeType:'text/markdown',buffer:Buffer.from('# 参考')});
 await expect(page.getByRole('region',{name:'本次附带文件'}).or(page.locator('.attachment-list'))).toContainText('reference.md');
 await page.evaluate(()=>{const files=new DataTransfer();files.items.add(new File(['png'],'pasted.png',{type:'image/png'}));document.querySelector('textarea').dispatchEvent(new ClipboardEvent('paste',{clipboardData:files,bubbles:true,cancelable:true}));});
 await expect(page.locator('.attachment-list')).toContainText('pasted.png');
 await page.evaluate(()=>{const files=new DataTransfer();files.items.add(new File(['text'],'dropped.txt',{type:'text/plain'}));document.querySelector('.composer').dispatchEvent(new DragEvent('drop',{dataTransfer:files,bubbles:true,cancelable:true}));});
 await expect(page.locator('.attachment-list')).toContainText('dropped.txt');
 await page.getByRole('button',{name:'补充要求',exact:true}).click();await expect(page.locator('.attachment-list')).toHaveCount(0);
 await page.getByRole('button',{name:'新建任务',exact:true}).click();await expect(page.locator('.attachment-list')).toContainText('reference.md');await page.reload();await expect(page.locator('.attachment-list')).toContainText('dropped.txt');
 await page.getByRole('textbox',{name:'交代工作或补充要求'}).fill('根据参考文件更新说明');await page.getByRole('button',{name:'发送要求',exact:true}).click();await expect.poll(()=>sent?.attachments.length).toBe(4);await expect(page.locator('.attachment-list')).toHaveCount(0);
 await expect(page.getByText('材料已接收',{exact:true})).toBeVisible();await expect(page.getByText('材料已接收',{exact:true})).toBeHidden({timeout:10000});
});
test('面板宽度可键盘调整并恢复，深浅色与小窗口保持可操作',async({page})=>{
 await page.goto('/');await page.getByRole('textbox',{name:'交代工作或补充要求'}).waitFor();
 const sidebar=page.getByRole('separator',{name:'调整项目导航宽度'});await sidebar.focus();await sidebar.press('ArrowRight');await expect(sidebar).toHaveAttribute('aria-valuenow','260');
 await page.getByRole('button',{name:'切换任务背景面板'}).click();const panel=page.getByRole('separator',{name:'调整任务详情宽度'});await panel.focus();await panel.press('ArrowLeft');await expect(panel).toHaveAttribute('aria-valuenow','396');
 await page.reload();await expect(sidebar).toHaveAttribute('aria-valuenow','260');await expect(panel).toHaveAttribute('aria-valuenow','396');
 await page.getByRole('button',{name:'收起任务背景'}).click();await expect(page.locator('.focus-card .task-goal')).toHaveCount(1);await page.screenshot({path:'docs/screenshots/interaction-light.png'});
 await page.emulateMedia({colorScheme:'dark'});await page.screenshot({path:'docs/screenshots/interaction-dark.png'});
 await page.setViewportSize({width:600,height:740});await expect(page.getByRole('button',{name:'发送要求',exact:true})).toBeInViewport();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:'docs/screenshots/interaction-small.png'});
});

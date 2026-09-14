// Run with NODE_PATH pointing to a directory containing Playwright.
const {chromium}=require('playwright');const assert=require('node:assert/strict');const path=require('node:path');const fs=require('node:fs');
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
 const page=await browser.newPage({viewport:{width:1280,height:860}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('file://'+path.resolve(__dirname,'../web/index.html'));await page.waitForFunction(()=>window.__ready);
 assert.equal(await page.locator('.task-row.doing').count(),3);
 const total=await page.locator('.task-row').count();assert.equal(total,19);
 const metrics=await page.evaluate(()=>({firstRowY:document.querySelector('.task-row').getBoundingClientRect().y,visibleRows:[...document.querySelectorAll('.task-row')].filter(r=>r.getBoundingClientRect().bottom<=innerHeight).length,font:getComputedStyle(document.querySelector('.task-title')).fontSize}));
 assert.ok(metrics.firstRowY<220,JSON.stringify(metrics));assert.ok(metrics.visibleRows>=18,JSON.stringify(metrics));assert.equal(metrics.font,'14px');
 console.log('Compact layout:',metrics);
 const roots=await page.locator('.task-row.root').evaluateAll(rows=>rows.map(r=>r.dataset.id));
 const rootOrder=()=>page.locator('.task-row.root').evaluateAll(rows=>rows.map(r=>r.dataset.id));
 const beforeState=await page.evaluate(()=>JSON.stringify(state));
 async function drag(source,target,placement='before'){
   const row=page.locator(`.task-row[data-id="${target}"]`),box=await row.boundingBox();
   await page.locator(`[data-drag="${source}"]`).dragTo(row,{targetPosition:{x:80,y:placement==='before'?3:box.height-3}});
 }
 await drag(roots[1],roots[0]);assert.deepEqual(await rootOrder(),[roots[1],roots[0],...roots.slice(2)]);
 await page.locator('#undo-toast').click();assert.equal(await page.evaluate(()=>JSON.stringify(state)),beforeState);
 const secondChild=await page.evaluate(id=>Biweekly.find(current().tasks,id).children[0].id,roots[1]);
 await drag(roots[0],secondChild,'after');assert.deepEqual(await rootOrder(),[roots[1],roots[0],...roots.slice(2)]);
 await page.evaluate(()=>window.BiweeklyNative.flush());await page.reload();await page.waitForFunction(()=>window.__ready);
 assert.deepEqual(await rootOrder(),[roots[1],roots[0],...roots.slice(2)]);
 await page.locator(`[data-move="${roots[0]}"][data-step="-1"]`).click();assert.deepEqual(await rootOrder(),roots);
 const children=await page.evaluate(id=>Biweekly.find(current().tasks,id).children.map(t=>t.id),roots[0]);
 await drag(children[3],children[0]);assert.deepEqual(await page.evaluate(id=>Biweekly.find(current().tasks,id).children.map(t=>t.id),roots[0]),[children[3],...children.slice(0,3)]);
 await page.locator('#undo-toast').click();
 await page.locator(`[data-drag="${children[0]}"]`).focus();await page.keyboard.press('Alt+ArrowDown');
 assert.deepEqual(await page.evaluate(id=>Biweekly.find(current().tasks,id).children.map(t=>t.id),roots[0]),[children[1],children[0],...children.slice(2)]);
 await page.evaluate(()=>window.BiweeklyNative.command('undo'));
 await page.locator('#focus-doing').click();await drag(roots[2],roots[1]);assert.deepEqual(await rootOrder(),[roots[0],roots[2],roots[1]]);
 await page.locator('#undo-toast').click();await page.locator('[data-filter=all]').click();
 assert.deepEqual(await rootOrder(),roots);

 await page.locator('[data-collapse]').first().click();assert.equal(await page.locator('.task-row').count(),total-4);
 await page.locator('#focus-doing').click();assert.equal(await page.locator('.task-row.doing').count(),3);assert.equal(await page.locator('.task-row').count(),6);
 await page.locator('.task-row.doing .task-title').first().click();assert.match(await page.locator('#note-rendered').innerText(),/测试记录/);
 // A paste event carrying an image should insert at the note cursor, render and survive reload.
 await page.locator('#note-edit').click();await page.locator('#note-editor').fill('before AFTER');
 await page.evaluate(async()=>{
   const editor=document.querySelector('#note-editor');editor.setSelectionRange(7,7);
   const canvas=document.createElement('canvas');canvas.width=160;canvas.height=60;
   const ctx=canvas.getContext('2d');ctx.fillStyle='#7061cd';ctx.fillRect(0,0,160,60);ctx.fillStyle='white';ctx.fillText('IMAGE NOTE',12,34);
   const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png')),dt=new DataTransfer();dt.items.add(new File([blob],'clipboard.png',{type:'image/png'}));
   editor.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:dt}));
 });
 await page.waitForFunction(()=>document.querySelector('#note-rendered img')?.naturalWidth===160);
 assert.match(await page.evaluate(()=>selected().notes),/^before \n\n!\[图片\]/);assert.match(await page.evaluate(()=>selected().notes),/AFTER$/);
 await page.locator('#note-rendered img').click();assert.equal(await page.locator('#modal.image-viewer').isVisible(),true);await page.locator('#modal [data-dismiss]').click();
 await page.evaluate(()=>window.BiweeklyNative.flush());await page.reload();await page.waitForFunction(()=>window.__ready);
 await page.locator('#focus-doing').click();await page.locator('.task-row.doing .task-title').first().click();await page.waitForFunction(()=>document.querySelector('#note-rendered img')?.naturalWidth===160);
 await page.locator('#note-edit').click();await page.locator('#note-editor').fill('## 新笔记\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n```js\nconst a = 1;\n```\n\n<script>window.XSS=true</script><img src=x onerror="window.XSS=true">');await page.locator('#note-preview').click();
 assert.equal(await page.locator('#note-rendered table').count(),1);assert.equal(await page.locator('#note-rendered pre').count(),1);assert.equal(await page.evaluate(()=>!!window.XSS),false);
 await page.locator('#detail-add-child').click();await page.locator('#child-title').fill('动态子任务');await page.locator('#child-form .primary').click();
 assert.equal(await page.locator('#detail-title').inputValue(),'动态子任务');
 await page.locator('#detail-status').selectOption('doing');assert.equal(await page.locator('.task-row.doing').count(),4);
 await page.locator('#task-more').click();await page.locator('#delete-task').click();assert.equal(await page.locator('.task-row.doing').count(),3);
 await page.locator('#undo-toast').click();assert.equal(await page.locator('.task-row.doing').count(),4);
 await page.locator('[data-filter=all]').click();await page.locator('#new-task').fill('新建顶级任务');await page.locator('#new-task').press('Enter');
 await page.locator('#search').fill('新建顶级');assert.equal(await page.locator('.task-row').count(),1);
 await page.locator('.task-title').click();await page.locator('#detail-title').fill('修改后的顶级任务');await page.locator('#detail-title').blur();
 await page.locator('#search').fill('');await page.evaluate(()=>window.BiweeklyNative.flush());await page.reload();await page.waitForFunction(()=>window.__ready);
 assert.equal(await page.getByRole('button',{name:'修改后的顶级任务',exact:true}).count(),1);
 await page.locator('#import-btn').click();await page.locator('#import-text').fill('# 导入文档\n\n- [ ] 导入父任务\n  - [ ] [doing] 导入 Doing\n  - [x] 导入 Done\n\n正文段落');await page.locator('#confirm-import').click();
 assert.equal(await page.getByRole('button',{name:'导入 Doing',exact:true}).count(),1);
 await page.locator('#cycle-notes-btn').click();assert.match(await page.locator('#note-rendered').innerText(),/正文段落/);
 await page.locator('#close-detail').click();await page.locator('#archive-btn').click();await page.locator('#confirm-archive').click();assert.equal(await page.locator('.cycle-btn').count(),2);assert.equal(await page.locator('.task-row.done').count(),0);
 await page.locator('.cycle-btn').last().click();assert.equal(await page.locator('#archive-notice').isVisible(),true);assert.equal(await page.locator('#quick-add').isVisible(),false);assert.equal(await page.locator('.stat.done strong').innerText(),'3');assert.equal(await page.locator('.task-check:enabled').count(),0);assert.equal(await page.locator('[data-drag]').count(),0);assert.equal(await page.locator('[data-move]').count(),0);
 // Restore a clean fixture for screenshots and verify a real export bridge payload.
 await page.evaluate(()=>{window.BiweeklyNative.restore(JSON.stringify(Biweekly.initial('2026-09-14')));});await page.locator('#restore-confirm').click();await page.evaluate(()=>window.BiweeklyNative.flush());await page.reload();await page.waitForFunction(()=>window.__ready);
 await page.locator('.task-row.doing .task-title').first().click();
 const screenshot=process.env.SCREENSHOT_PATH||path.resolve(__dirname,'../build/preview.png');fs.mkdirSync(path.dirname(screenshot),{recursive:true});await page.screenshot({path:screenshot});
 await page.locator('#focus-doing').click();await page.screenshot({path:screenshot.replace('.png','-doing.png')});
 for(const width of [960,1100,1440]){
   await page.setViewportSize({width,height:800});await page.locator('.task-row.doing .task-title').first().click();
   const layout=await page.evaluate(()=>({overflow:document.documentElement.scrollWidth>innerWidth,task:document.querySelector('.task-title').getBoundingClientRect().width,detail:document.querySelector('#detail').getBoundingClientRect().right}));
   assert.equal(layout.overflow,false,JSON.stringify({width,...layout}));assert.ok(layout.task>150,JSON.stringify({width,...layout}));assert.ok(layout.detail<=width,JSON.stringify({width,...layout}));
   await page.locator('#close-detail').click();
 }
 assert.deepEqual(errors,[]);console.log('PASS: drag root/child/filtered order, undo, persisted order, keyboard movement, responsive compact layout; UI add/rename/delete/undo, nesting/collapse, Doing filter, Markdown/XSS, persistence, import, archive and read-only history.');
 await browser.close();
})().catch(e=>{console.error(e);process.exit(1);});

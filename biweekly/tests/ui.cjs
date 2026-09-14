// Run with NODE_PATH pointing to a directory containing Playwright.
const {chromium}=require('playwright');const assert=require('node:assert/strict');const path=require('node:path');const fs=require('node:fs');
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
 const page=await browser.newPage({viewport:{width:1280,height:860}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('file://'+path.resolve(__dirname,'../web/index.html'));await page.waitForFunction(()=>window.__ready);
 assert.equal(await page.locator('.task-row.doing').count(),3);
 const total=await page.locator('.task-row').count();assert.equal(total,19);
 await page.locator('[data-collapse]').first().click();assert.equal(await page.locator('.task-row').count(),total-4);
 await page.locator('#focus-doing').click();assert.equal(await page.locator('.task-row.doing').count(),3);assert.equal(await page.locator('.task-row').count(),6);
 await page.locator('.task-row.doing .task-title').first().click();assert.match(await page.locator('#note-rendered').innerText(),/测试记录/);
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
 await page.locator('.cycle-btn').last().click();assert.equal(await page.locator('#archive-notice').isVisible(),true);assert.equal(await page.locator('#quick-add').isVisible(),false);assert.equal(await page.locator('.stat.done strong').innerText(),'3');assert.equal(await page.locator('.task-check:enabled').count(),0);
 // Restore a clean fixture for screenshots and verify a real export bridge payload.
 await page.evaluate(()=>{window.BiweeklyNative.restore(JSON.stringify(Biweekly.initial('2026-09-14')));});await page.locator('#restore-confirm').click();await page.evaluate(()=>window.BiweeklyNative.flush());await page.reload();await page.waitForFunction(()=>window.__ready);
 await page.locator('.task-row.doing .task-title').first().click();
 const screenshot=process.env.SCREENSHOT_PATH||path.resolve(__dirname,'../build/preview.png');fs.mkdirSync(path.dirname(screenshot),{recursive:true});await page.screenshot({path:screenshot});
 await page.locator('#focus-doing').click();await page.screenshot({path:screenshot.replace('.png','-doing.png')});
 assert.deepEqual(errors,[]);console.log('PASS: UI add/rename/delete/undo, nesting/collapse, Doing filter, Markdown/XSS, persistence, import, archive and read-only history.');
 await browser.close();
})().catch(e=>{console.error(e);process.exit(1);});

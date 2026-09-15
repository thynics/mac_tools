const {chromium}=require('playwright'),assert=require('node:assert/strict'),path=require('node:path');
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
 const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>{
   window.__messages=[];window.webkit={messageHandlers:{bridge:{postMessage:message=>{
     window.__messages.push(message);
     if(message.action==='load')queueMicrotask(()=>BiweeklyNative.bootstrap(JSON.parse(localStorage.getItem('test-state')||'null')));
     if(message.action==='save'){localStorage.setItem('test-state',message.data);BiweeklyNative.saved(message.revision,null);}
   }}}};
 });
 await page.goto('file://'+path.resolve(__dirname,'../web/index.html'));await page.waitForFunction(()=>window.__ready);
 const record={name:'notes <draft> [v1].txt',path:'attachments/'+'a'.repeat(64)+'/notes <draft> [v1].txt',size:4,addedAt:'2026-09-15T01:00:00Z'};
 await page.locator('.task-row.doing .task-title').first().click();
 await page.locator('#attach-files').click();await page.evaluate(file=>{const req=window.__messages.findLast(m=>m.action==='chooseAttachments').request;BiweeklyNative.filesAttached(req,[file],null);},record);
 assert.equal(await page.locator('.attachment-row').count(),1);assert.match(await page.locator('.attachment-name').innerText(),/notes <draft> \[v1\]\.txt/);assert.equal(await page.locator('.attachment-row draft').count(),0);
 await page.locator('[data-open-file]').click();assert.equal(await page.evaluate(()=>window.__messages.at(-1).action),'openAttachment');
 await page.locator('[data-reveal-file]').click();assert.equal(await page.evaluate(()=>window.__messages.at(-1).action),'revealAttachment');
 await page.locator('[data-remove-file]').click();assert.equal(await page.locator('.attachment-row').count(),0);await page.locator('#undo-toast').click();assert.equal(await page.locator('.attachment-row').count(),1);
 // An asynchronous chooser result remains tied to the original note even after selecting another task.
 await page.locator('#attach-files').click();const oldID=await page.evaluate(()=>selectedId);
 await page.locator('.task-row.doing .task-title').nth(1).click();await page.evaluate(file=>{const req=window.__messages.findLast(m=>m.action==='chooseAttachments').request;BiweeklyNative.filesAttached(req,[{...file,name:'second.txt',path:'attachments/'+'b'.repeat(64)+'/second.txt'}],null);},record);
 assert.equal(await page.locator('.attachment-row').count(),0);assert.equal(await page.evaluate(id=>Biweekly.find(current().tasks,id).attachments.length,oldID),2);
 await page.locator('#cycle-notes-btn').click();await page.locator('#attach-files').click();await page.evaluate(file=>{const req=window.__messages.findLast(m=>m.action==='chooseAttachments').request;BiweeklyNative.filesAttached(req,[file],null);},record);assert.equal(await page.locator('.attachment-row').count(),1);
 await page.evaluate(()=>BiweeklyNative.flush());await page.reload();await page.waitForFunction(()=>window.__ready);await page.locator('#cycle-notes-btn').click();assert.equal(await page.locator('.attachment-row').count(),1);
 await page.locator('#close-detail').click();await page.locator('#archive-btn').click();await page.locator('#confirm-archive').click();await page.locator('.cycle-btn').last().click();await page.locator('#cycle-notes-btn').click();
 assert.equal(await page.locator('.attachment-row').count(),1);assert.equal(await page.locator('#attach-files').count(),0);assert.equal(await page.locator('[data-remove-file]').count(),0);assert.equal(await page.locator('[data-open-file]').count(),1);
 assert.deepEqual(errors,[]);console.log('PASS: file attachment cards, escaped filenames, open/reveal requests, remove/undo, async target, cycle attachments, reload and read-only archives.');await browser.close();
})().catch(e=>{console.error(e);process.exit(1);});

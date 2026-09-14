const test=require('node:test');const assert=require('node:assert/strict');
const B=require('../web/model.js'), M=require('../web/markdown.js');
test('calendar arithmetic uses dates, including year/leap/DST boundaries',()=>{
 assert.equal(B.addDays('2026-12-28',13),'2027-01-10');
 assert.equal(B.addDays('2024-02-26',13),'2024-03-10');
 assert.equal(B.periodStart('2026-09-27','2026-09-14'),'2026-09-14');
 assert.equal(B.periodStart('2026-09-28','2026-09-14'),'2026-09-28');
 assert.equal(B.periodStart('2026-09-13','2026-09-14'),'2026-08-31');
 assert.equal(B.addDays('2026-03-02',14),'2026-03-16');
});
test('rollover preserves complete archive, carries unfinished independently, is idempotent',()=>{
 const s=B.initial('2026-09-14');const old=structuredClone(s.cycles[0]);
 assert.equal(B.rollover(s,'2026-09-27'),false);assert.equal(B.rollover(s,'2026-09-28'),true);
 assert.deepEqual(s.cycles[1],{...old,archived:true});assert.equal(B.counts(s.cycles[0].tasks).done,0);
 assert.equal(B.counts(s.cycles[0].tasks).doing,3);
 s.cycles[0].tasks[0].title='Changed';assert.equal(s.cycles[1].tasks[0].title,old.tasks[0].title);
 assert.equal(B.rollover(s,'2026-09-28'),false);B.validate(s);
});
test('long absence starts correct current fortnight and disabled carry leaves it empty',()=>{
 const s=B.initial('2026-09-14');s.settings.carryUnfinished=false;B.rollover(s,'2027-01-12');
 assert.equal(s.cycles.length,2);assert.equal(s.cycles[0].start,'2027-01-04');assert.deepEqual(s.cycles[0].tasks,[]);
});
test('completed parent does not erase unfinished descendants',()=>{
 const original=[B.task('project','done',[B.task('ongoing','doing'),B.task('finished','done')])];
 const copy=B.carry(original);assert.equal(copy[0].status,'todo');assert.equal(copy[0].children.length,1);assert.equal(copy[0].children[0].status,'doing');
});
test('Markdown imports nested tasks and Doing/Done precedence, avoiding checkboxes in code',()=>{
 const parsed=M.importMarkdown('# 双周\n\n- [ ] Project\n  - [ ] [doing] Active\n  - [x] [doing] Finished\n  - [ ] Waiting\n\n```md\n- [ ] code, not task\n```');
 assert.equal(parsed.tasks[0].title,'Project');assert.equal(parsed.tasks[0].children.length,3);
 assert.deepEqual(parsed.tasks[0].children.map(x=>[x.title,x.status,x.notes]),[['Active','doing',''],['Finished','done',''],['Waiting','todo','']]);
 assert.match(parsed.notes,/code, not task/);
});
test('loose Markdown lists preserve notes and strip list markers',()=>{
 const p=M.importMarkdown('- [ ] Parent\n  - [ ] [doing] Child\n\n  A note.\n\n  ```js\n  1 + 1\n  ```');
 assert.equal(p.tasks[0].title,'Parent');assert.equal(p.tasks[0].children[0].notes,'');assert.match(p.tasks[0].notes,/```js\n1 \+ 1\n```/);
});
test('export/import preserves hierarchy, statuses and task prose notes',()=>{
 const c=B.cycle('2026-09-14',[B.task('Project','todo',[B.task('Code','doing',[],'## Findings\n\n```swift\nlet n = 1\n```'),B.task('Ship','done')])]);
 const p=M.importMarkdown(M.exportMarkdown(c));assert.equal(p.tasks[0].title,'Project');assert.equal(p.tasks[0].children[0].status,'doing');assert.match(p.tasks[0].children[0].notes,/let n = 1/);assert.equal(p.tasks[0].children[1].status,'done');
});
test('backup validation rejects corruption, duplicate IDs, invalid dates and deep trees',()=>{
 const s=B.initial('2026-09-14');B.validate(s);const bad=structuredClone(s);bad.cycles[0].tasks[0].status='unknown';assert.throws(()=>B.validate(bad));
 const dup=structuredClone(s);dup.cycles[0].tasks[1].id=dup.cycles[0].tasks[0].id;assert.throws(()=>B.validate(dup));
 const date=structuredClone(s);date.cycles[0].start='2026-02-30';assert.throws(()=>B.validate(date));
 const xss=structuredClone(s);xss.cycles[0].tasks[0].id='" onclick="evil';assert.throws(()=>B.validate(xss));
 let root=B.task('root'),cursor=root;for(let i=0;i<35;i++){cursor.children=[B.task('deep')];cursor=cursor.children[0];}assert.throws(()=>B.validate({...s,cycles:[B.cycle('2026-09-14',[root])]}));
});
test('reordering moves a complete subtree before or after siblings without changing its data',()=>{
 const child=B.task('nested','doing',[],'important notes');const first=B.task('first','todo',[child]);const second=B.task('second');const third=B.task('third');const tasks=[first,second,third];
 assert.equal(B.reorderTask(tasks,first.id,second.id,'after'),true);assert.deepEqual(tasks,[second,first,third]);assert.strictEqual(tasks[1].children[0],child);
 assert.equal(B.reorderTask(tasks,third.id,second.id,'before'),true);assert.deepEqual(tasks,[third,second,first]);assert.equal(child.notes,'important notes');
 assert.equal(B.reorderTask(tasks,first.id,second.id,'after'),false);assert.equal(B.reorderTask(tasks,first.id,child.id,'before'),false);assert.equal(B.reorderTask(tasks,child.id,third.id,'after'),false);
 assert.equal(B.reorderTask(tasks,first.id,first.id),false);assert.equal(B.reorderTask(tasks,'missing',first.id),false);
});
test('nested sibling reordering preserves parent, notes, status and collapsed state',()=>{
 const a=B.task('A','done'),b=B.task('B','doing'),c=B.task('C');const parent=B.task('Parent','todo',[a,b,c],'project notes');parent.collapsed=true;
 assert.equal(B.reorderTask([parent],c.id,a.id),true);assert.deepEqual(parent.children,[c,a,b]);assert.equal(parent.collapsed,true);assert.equal(parent.notes,'project notes');assert.equal(parent.children[2].status,'doing');
});

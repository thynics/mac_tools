(function (root) {
  'use strict';
  const DAY = 86400000;
  const uid = () => globalThis.crypto?.randomUUID?.() || 'id-' + Date.now().toString(36) + Math.random().toString(36).slice(2);
  const key = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  const day = s => Date.parse(s + 'T00:00:00Z');
  const addDays = (s, n) => new Date(day(s) + n * DAY).toISOString().slice(0, 10);
  const periodStart = (today, anchor) => addDays(anchor, Math.floor((day(today)-day(anchor))/(14*DAY))*14);
  const task = (title, status = 'todo', children = [], notes = '') => ({id:uid(), title, status, children, notes, collapsed:false});
  const walk = (tasks, fn, parent = null) => tasks.forEach(t => { fn(t,parent); walk(t.children,fn,t); });
  const find = (tasks,id) => { let found; walk(tasks,t=>{if(t.id===id) found=t;}); return found; };
  // Move the original node as a unit so notes, IDs and all descendants stay intact.
  function taskPosition(tasks, id, parent = null) {
    for (let index = 0; index < tasks.length; index++) {
      if (tasks[index].id === id) return {task:tasks[index], siblings:tasks, index, parent};
      const found = taskPosition(tasks[index].children, id, tasks[index]);
      if (found) return found;
    }
    return null;
  }
  function reorderTask(tasks, sourceId, targetId, placement = 'before') {
    const source = taskPosition(tasks, sourceId), target = taskPosition(tasks, targetId);
    if (!source || !target || sourceId === targetId || source.siblings !== target.siblings || !['before','after'].includes(placement)) return false;
    let destination = target.index + (placement === 'after' ? 1 : 0);
    if (source.index < destination) destination--;
    if (source.index === destination) return false;
    source.siblings.splice(source.index, 1);
    source.siblings.splice(destination, 0, source.task);
    return true;
  }
  const counts = tasks => { const c={todo:0,doing:0,done:0,total:0}; walk(tasks,t=>{c[t.status]++;c.total++;}); return c; };
  const carry = tasks => tasks.flatMap(t => {
    const children=carry(t.children);
    return t.status==='done'&&!children.length ? [] : [{...t,id:uid(),status:t.status==='done'?'todo':t.status,children,collapsed:false,...(t.attachments?{attachments:t.attachments.map(a=>({...a}))}:{})}];
  });
  function cycle(start,tasks=[]) { return {id:uid(),start,archived:false,tasks,notes:''}; }
  function rollover(state, today=key()) {
    const active=state.cycles.find(c=>!c.archived);
    if(!active || today < addDays(active.start,14)) return false;
    active.archived=true;
    state.cycles.unshift(cycle(periodStart(today,active.start),state.settings.carryUnfinished?carry(active.tasks):[]));
    return true;
  }
  function nextCycle(state,shouldCarry) {
    const current=state.cycles.find(c=>!c.archived);
    current.archived=true;
    const next=cycle(addDays(current.start,14),shouldCarry?carry(current.tasks):[]);
    state.cycles.unshift(next); return next;
  }
  function initial(today=key()) {
    const start=periodStart(today,'2026-09-14');
    const tasks=[
      task('产品迭代','todo',[
        task('整理需求与设计方案','done'),
        task('验证核心流程','doing',[], '## 测试记录\n\n在这里记录复测结果、代码或链接。\n\n- [ ] 整理测试数据\n- [ ] 对比结果\n\n```python\n# 粘贴你的代码片段\n```'),
        task('提交代码评审'),task('发布版本')]),
      task('技术验证','todo',[task('运行基线实验','doing')]),
      task('数据分析','todo',[task('检查真实样本','doing')]),
      task('阅读与学习'),
      task('工程优化','todo',[task('整理现有实现','done'),task('优化关键路径'),task('补充边界场景'),task('记录性能结果')]),
      task('团队协作'),task('下阶段准备','todo',[task('拆解目标'),task('整理参考资料')])
    ];
    return {version:1,settings:{carryUnfinished:true},cycles:[cycle(start,tasks)]};
  }
  function validateAttachments(attachments) {
    if(attachments===undefined)return;
    if(!Array.isArray(attachments)||attachments.length>500)throw Error('每条笔记最多支持 500 个文件附件。');
    const seen=new Set();
    for(const a of attachments){
      if(!a||typeof a.name!=='string'||!a.name||['.','..'].includes(a.name)||/[\\/\x00-\x1f\x7f]/.test(a.name)||new TextEncoder().encode(a.name).length>255||
         typeof a.path!=='string'||!/^attachments\/[a-f0-9]{64}\/[^/\\\x00-\x1f\x7f]+$/.test(a.path)||a.path.split('/')[2]!==a.name||
         !Number.isInteger(a.size)||a.size<0||a.size>50000000||typeof a.addedAt!=='string'||!Number.isFinite(Date.parse(a.addedAt))||seen.has(a.path))throw Error('文件附件元数据无效。');
      seen.add(a.path);
    }
  }
  function validate(s) {
    if(!s||s.version!==1||!Array.isArray(s.cycles)||!s.cycles.length||typeof s.settings?.carryUnfinished!=='boolean') throw Error('备份格式不正确，或版本暂不支持。');
    let total=0; const ids=new Set(); const starts=new Set();
    const id=x=>{if(typeof x!=='string'||!/^[a-zA-Z0-9_-]{1,100}$/.test(x)||ids.has(x))throw Error('数据 ID 无效或重复。');ids.add(x);};
    function tasks(arr,depth=0){
      if(!Array.isArray(arr)||depth>32)throw Error('任务层级无效（最多 32 层）。');
      arr.forEach(t=>{if(++total>20000)throw Error('任务数超过 20,000。'); id(t.id);
        if(typeof t.title!=='string'||typeof t.notes!=='string'||!['todo','doing','done'].includes(t.status)||typeof t.collapsed!=='boolean')throw Error('任务格式无效。');
        validateAttachments(t.attachments);tasks(t.children,depth+1);
      });
    }
    if(s.cycles.filter(c=>!c.archived).length!==1)throw Error('必须保留一个当前双周。');
    s.cycles.forEach(c=>{id(c.id);if(!/^\d{4}-\d{2}-\d{2}$/.test(c.start)||!Number.isFinite(day(c.start))||addDays(c.start,0)!==c.start||starts.has(c.start)||typeof c.archived!=='boolean'||typeof c.notes!=='string')throw Error('双周信息无效。');starts.add(c.start);validateAttachments(c.attachments);tasks(c.tasks);});
    const active=s.cycles.find(c=>!c.archived);
    if(s.cycles.some(c=>c.archived&&c.start>=active.start))throw Error('归档日期必须早于当前双周。');
    return s;
  }
  const api={uid,key,day,addDays,periodStart,task,walk,find,taskPosition,reorderTask,counts,carry,cycle,rollover,nextCycle,initial,validateAttachments,validate};
  if(typeof module!=='undefined')module.exports=api; else root.Biweekly=api;
})(globalThis);

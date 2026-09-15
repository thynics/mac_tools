'use strict';
const B=Biweekly, $=s=>document.querySelector(s), $$=s=>[...document.querySelectorAll(s)];
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let state, cycleId, selectedId=null, filter='all', query='', editing=false, history=[], saveTimer, toastTimer, locked=false;
let pendingRestore=null;
let nativeReady=false, saveRevision=0, diskPath='', importedFilename='';
const native=!!window.webkit?.messageHandlers?.bridge;
const post=(action,extra={})=>{ if(native)window.webkit.messageHandlers.bridge.postMessage({action,...extra}); };
const current=()=>state.cycles.find(c=>c.id===cycleId)||state.cycles[0];
const active=()=>state.cycles.find(c=>!c.archived);
const selected=()=>selectedId==='cycle'?current():B.find(current().tasks,selectedId);
const fmt=s=>{const p=s.split('-').map(Number);return `${p[1]}.${p[2]}`;};
function toast(message,undo=false){clearTimeout(toastTimer);$('#toast').innerHTML=esc(message)+(undo?'<button id="undo-toast">撤销</button>':'');$('#toast').hidden=false;$('#undo-toast')?.addEventListener('click',undoChange);toastTimer=setTimeout(()=>$('#toast').hidden=true,undo?9000:4000);}
function snapshot(){history.push(JSON.stringify(state));if(history.length>40)history.shift();}
function flush(){clearTimeout(saveTimer);if(!state||locked)return;try{const data=JSON.stringify(state);if(native){saveRevision++;post('save',{data,revision:saveRevision});}else{localStorage.setItem('biweekly-state',data);$('#save-label').textContent='本地存储 · 已保存';}}catch(e){$('#save-label').textContent='保存失败';toast(e.message);}}
function persist(){if(locked)return;$('#save-label').textContent='正在保存…';clearTimeout(saveTimer);saveTimer=setTimeout(flush,200);}
function changed(render=true){persist();if(render)renderAll();}
function undoChange(){if(!history.length){toast('没有可撤销的更改');return;}state=JSON.parse(history.pop());if(!state.cycles.some(c=>c.id===cycleId))cycleId=active().id;if(selectedId!=='cycle'&&!B.find(current().tasks,selectedId))selectedId=null;changed();toast('已撤销');}
function mutate(fn){if(locked||current().archived)return;snapshot();fn();changed();}
function reorder(sourceId,targetId,placement){
  if(locked||current().archived)return false;
  const before=JSON.stringify(state);
  if(!B.reorderTask(current().tasks,sourceId,targetId,placement))return false;
  history.push(before);if(history.length>40)history.shift();
  changed();return true;
}
function moveStep(id,direction){
  const position=B.taskPosition(current().tasks,id);
  const target=position?.siblings[position.index+direction];
  if(target&&reorder(id,target.id,direction<0?'before':'after')){
    const handle=$(`[data-drag="${id}"]`);
    handle?.focus({preventScroll:true});handle?.scrollIntoView({block:'nearest'});
  }
}
let dragState=null,dragFrame=0;
function clearDropIndicator(){
  $$('.drop-before,.drop-after').forEach(row=>row.classList.remove('drop-before','drop-after'));
}
function finishDrag(){
  cancelAnimationFrame(dragFrame);dragFrame=0;dragState=null;
  document.body.classList.remove('reordering');
  $$('.dragging').forEach(row=>row.classList.remove('dragging'));clearDropIndicator();
}
function updateDrop(row,y){
  if(!dragState)return;
  clearDropIndicator();dragState.target=null;
  const source=dragState.positions.get(dragState.id);
  let target=dragState.positions.get(row.dataset.id);
  // Hovering a project's descendants anchors the move to that whole project.
  while(target&&target.parent!==source.parent){
    target=target.parent?dragState.positions.get(target.parent):null;
  }
  if(!target||target.id===source.id)return;
  const anchor=$(`.task-row[data-id="${target.id}"]`);
  if(!anchor)return;
  const box=anchor.getBoundingClientRect(),placement=y<box.top+box.height/2?'before':'after';
  let indicator=anchor;
  if(placement==='after'){
    let next=anchor.nextElementSibling;
    while(next?.classList.contains('task-row')&&Number(next.getAttribute('aria-level'))>Number(anchor.getAttribute('aria-level'))){indicator=next;next=next.nextElementSibling;}
  }
  indicator.classList.add('drop-'+placement);
  dragState.target={id:target.id,placement};
}
function scrollWhileDragging(){
  if(!dragState)return;
  const pane=$('main'),bounds=pane.getBoundingClientRect(),{x,y}=dragState;
  if(x>=bounds.left&&x<=bounds.right&&y>=bounds.top&&y<=bounds.bottom){
    const distance=y<bounds.top+48?y-(bounds.top+48):y>bounds.bottom-48?y-(bounds.bottom-48):0;
    if(distance){
      pane.scrollTop+=Math.sign(distance)*Math.min(14,Math.abs(distance)/3);
      const row=document.elementFromPoint(x,y)?.closest('.task-row');
      if(row)updateDrop(row,y);
    }
  }
  dragFrame=requestAnimationFrame(scrollWhileDragging);
}
function bindReordering(){
  $$('[data-drag]').forEach(handle=>{
    handle.ondragstart=e=>{
      if(locked||current().archived){e.preventDefault();return;}
      const positions=new Map();B.walk(current().tasks,(t,p)=>positions.set(t.id,{id:t.id,parent:p?.id||null}));
      dragState={id:handle.dataset.drag,positions,target:null,x:e.clientX,y:e.clientY};
      e.dataTransfer.effectAllowed='move';e.dataTransfer.setData('application/x-biweekly-task',dragState.id);
      const row=handle.closest('.task-row');
      e.dataTransfer.setDragImage(row,Math.max(0,e.clientX-row.getBoundingClientRect().left),row.offsetHeight/2);
      row.classList.add('dragging');document.body.classList.add('reordering');scrollWhileDragging();
    };
    handle.ondragend=finishDrag;
    handle.onkeydown=e=>{
      if(e.altKey&&['ArrowUp','ArrowDown'].includes(e.key)){e.preventDefault();moveStep(handle.dataset.drag,e.key==='ArrowUp'?-1:1);}
    };
  });
}
document.addEventListener('dragover',e=>{
  if(!dragState)return;
  e.preventDefault();dragState.x=e.clientX;dragState.y=e.clientY;
  const row=e.target.closest?.('.task-row');
  if(row)updateDrop(row,e.clientY);else{clearDropIndicator();dragState.target=null;}
  e.dataTransfer.dropEffect=dragState.target?'move':'none';
});
document.addEventListener('drop',e=>{
  if(!dragState)return;
  e.preventDefault();
  const row=e.target.closest?.('.task-row');if(row)updateDrop(row,e.clientY);else dragState.target=null;
  const {id,target}=dragState;finishDrag();
  if(target&&reorder(id,target.id,target.placement)){
    $(`[data-drag="${id}"]`)?.focus({preventScroll:true});toast('已调整任务顺序',true);
  }
});
document.addEventListener('dragend',finishDrag);
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&dragState)finishDrag();});
// Checkbox inputs are the only form elements rendered in Markdown. Always keep them inert.
function noteHTML(md){return DOMPurify.sanitize(marked.parse(md||'',{breaks:true,gfm:true}),{USE_PROFILES:{html:true},FORBID_TAGS:['style','form','button','textarea','select','iframe','object','embed'],FORBID_ATTR:['style','id','name']});}
function renderSidebar(){
  $('#global-doing').textContent=B.counts(active().tasks).doing;
  const sorted=[...state.cycles].sort((a,b)=>b.start.localeCompare(a.start));let hadArchive=false;
  $('#cycles').innerHTML=sorted.map(c=>{const header=c.archived&&!hadArchive?(hadArchive=true,'<div class="archive-label">已归档 / ARCHIVE</div>'):'';return header+`<button class="cycle-btn ${c.id===cycleId?'active':''}" data-cycle="${c.id}"><span class="cycle-symbol">${c.archived?'▤':'▦'}</span><span><strong>${fmt(c.start)} 双周</strong><small>${c.start.slice(0,4)} · ${fmt(c.start)} — ${fmt(B.addDays(c.start,13))}</small></span>${!c.archived?'<span class="current-dot"></span>':''}</button>`;}).join('');
  $$('[data-cycle]').forEach(el=>el.onclick=()=>{cycleId=el.dataset.cycle;selectedId=null;query='';$('#search').value='';filter='all';renderAll();});
}
function renderHeader(){
  const c=current(), n=B.counts(c.tasks), pct=n.total?Math.round(100*n.done/n.total):0;
  $('#period-title').textContent=fmt(c.start)+' 双周';$('#breadcrumb-period').textContent=c.archived?'双周归档':'当前双周';
  $('#period-tag').textContent=c.archived?'已归档':B.key()<c.start?'即将开始':'进行中';
  $('#date-range').textContent=`${c.start.replaceAll('-','.')} — ${B.addDays(c.start,13).replaceAll('-','.')}`;
  const elapsed=Math.floor((B.day(B.key())-B.day(c.start))/86400000)+1;
  $('#day-progress').textContent=c.archived?'双周记录已保存':elapsed<1?'将在 '+fmt(c.start)+' 开始':`第 ${Math.min(14,elapsed)} 天 / 共 14 天`;
  $('#progress-fill').style.width=pct+'%';
  $('#stats').innerHTML=`<span class="stat done"><strong>${n.done}</strong> / ${n.total} 已完成</span>`;
  $$('[data-filter]').forEach(b=>{b.classList.toggle('active',b.dataset.filter===filter);b.setAttribute('aria-selected',String(b.dataset.filter===filter));b.querySelector('span').textContent=b.dataset.filter==='all'?n.total:n[b.dataset.filter];});
  $('#archive-btn').hidden=c.archived;$('#archive-notice').hidden=!c.archived;$('#quick-add').hidden=c.archived||locked;
}
function renderTasks(){
  const c=current(), filtered=filter!=='all'||!!query;let shown=0, matched=0;
  const matches=t=>(filter==='all'||t.status===filter)&&(!query||(t.title+' '+t.notes).toLowerCase().includes(query.toLowerCase()));
  const contains=t=>matches(t)||t.children.some(contains);
  function rows(tasks,depth=0){return tasks.map(t=>{
    if(filtered&&!contains(t))return '';
    shown++;if(matches(t))matched++;
    const open=filtered||!t.collapsed, childStats=B.counts(t.children), siblingIndex=tasks.indexOf(t);
    return `<div class="task-row ${t.status} ${depth===0?'root':''} ${t.id===selectedId?'selected':''} ${filtered&&!matches(t)?'context':''}" style="--depth:${Math.min(depth,8)}" data-id="${t.id}" role="treeitem" aria-level="${depth+1}" ${t.children.length?`aria-expanded="${open}"`:''}>
    ${!c.archived&&!locked?`<button class="drag-handle" draggable="true" data-drag="${t.id}" aria-label="排序：${esc(t.title)}" title="拖动调整同级顺序；⌥↑ / ⌥↓ 上下移动">⠿</button>`:'<span class="drag-placeholder"></span>'}
    <button class="collapse ${t.children.length?'':'spacer'}" data-collapse="${t.id}" aria-label="${open?'收起':'展开'}子任务">${open?'▾':'▸'}</button>
    <button class="task-check" data-check="${t.id}" aria-label="${t.status==='done'?'恢复为待办':'标为完成'}：${esc(t.title)}" ${c.archived?'disabled':''}></button>
    <button class="task-title" data-select="${t.id}" title="${esc(t.title)}">${esc(t.title)}</button>
    ${t.notes||t.attachments?.length?'<span class="note-icon" title="有笔记或附件">▤</span>':''}
    ${t.children.length?`<span class="child-count">${childStats.done}/${childStats.total}</span>`:''}
    ${!c.archived&&!locked?`<span class="row-order"><button data-move="${t.id}" data-step="-1" title="上移" aria-label="上移：${esc(t.title)}" ${siblingIndex===0?'disabled':''}>↑</button><button data-move="${t.id}" data-step="1" title="下移" aria-label="下移：${esc(t.title)}" ${siblingIndex===tasks.length-1?'disabled':''}>↓</button></span>`:''}
    ${!c.archived?`<button class="row-add" data-child="${t.id}" title="添加子任务" aria-label="为 ${esc(t.title)} 添加子任务">＋</button>`:''}
    <button class="status-pill ${t.status}" data-status="${t.id}" title="点击切换 Todo → Doing → Done" ${c.archived?'disabled':''}><span class="status-dot ${t.status}"></span>${{todo:'Todo',doing:'Doing',done:'Done'}[t.status]}</button></div>${open?rows(t.children,depth+1):''}`;
  }).join('');}
  const html=rows(c.tasks);
  $('#task-list').innerHTML=html||`<div class="empty"><span class="empty-symbol">${filter==='done'?'✓':'◌'}</span><strong>${query?'没有匹配的任务':filter==='doing'?'暂时没有 Doing 任务':filter==='done'?'完成的任务会出现在这里':'留一点空间，开始新的任务'}</strong>${filter==='doing'?'点击任务右侧的 Todo 状态，即可开始追踪。':'可以添加任务，或导入一份 Markdown 清单。'}</div>`;
  $('#visible-count').textContent=filtered?`${matched} 个匹配 · ${shown} 项可见`:`${shown} 项可见`;
  $$('[data-collapse]').forEach(el=>el.onclick=()=>{const t=B.find(c.tasks,el.dataset.collapse);if(filtered){toast('筛选时自动展开相关子任务；切回「全部」可收起。');return;}t.collapsed=!t.collapsed;persist();renderTasks();});
  $$('[data-select]').forEach(el=>el.onclick=()=>{selectedId=el.dataset.select;editing=false;renderTasks();renderDetail();});
  $$('.task-row').forEach(el=>el.oncontextmenu=e=>{if(!c.archived){e.preventDefault();taskMore(el.dataset.id);}});
  $$('[data-check]').forEach(el=>el.onclick=()=>mutate(()=>{const t=B.find(c.tasks,el.dataset.check);t.status=t.status==='done'?'todo':'done';}));
  $$('[data-status]').forEach(el=>el.onclick=()=>mutate(()=>{const t=B.find(c.tasks,el.dataset.status);t.status={todo:'doing',doing:'done',done:'todo'}[t.status];}));
  $$('[data-child]').forEach(el=>el.onclick=()=>addChild(el.dataset.child));
  $$('[data-move]').forEach(el=>el.onclick=()=>moveStep(el.dataset.move,Number(el.dataset.step)));
  bindReordering();
}
function fitDetailTitle(){const title=$('#detail-title');if(title){title.style.height='auto';title.style.height=title.scrollHeight+'px';}}
window.addEventListener('resize',fitDetailTitle);
function renderDetail(){
  const target=selected();$('#detail').hidden=!target;if(!target)return;
  const isCycle=selectedId==='cycle', readOnly=current().archived;let parent=null;
  B.walk(current().tasks,(t,p)=>{if(t.id===selectedId)parent=p;});
  $('#detail').innerHTML=`<div class="detail-top"><span>${isCycle?'BIWEEKLY NOTES':'TASK DETAILS'}</span><button id="close-detail" aria-label="关闭详情">×</button></div><div class="detail-path">${esc(isCycle?'双周记录':parent?.title||fmt(current().start)+' 双周')} ${readOnly?'· 已归档':''}</div>
    ${isCycle?'<h2 class="detail-title">双周笔记</h2>':`<textarea id="detail-title" class="detail-title title-input" rows="1" aria-label="任务标题" ${readOnly?'readonly':''}>${esc(target.title)}</textarea>`}
    ${!isCycle?`<div class="detail-properties"><span>状态</span><select id="detail-status" class="status-select" aria-label="任务状态" ${readOnly?'disabled':''}>${['todo','doing','done'].map(s=>`<option value="${s}" ${s===target.status?'selected':''}>${{todo:'○ Todo',doing:'◉ Doing',done:'✓ Done'}[s]}</option>`).join('')}</select></div>`:''}
    <div class="note-toolbar"><span>笔记 / MARKDOWN</span><div class="segmented"><button id="note-preview" class="${!editing?'active':''}">预览</button>${!readOnly?`<button id="note-edit" class="${editing?'active':''}">编辑</button>`:''}</div></div>
    ${editing&&!readOnly?`<textarea id="note-editor" class="note-editor" aria-label="Markdown 笔记" placeholder="粘贴 Markdown，或直接写下想法…\n\n## 标题\n- [ ] 待办\n\n支持代码块、表格与链接">${esc(target.notes)}</textarea>`:`<div class="markdown" id="note-rendered">${target.notes?noteHTML(target.notes):'<div class="note-empty">为任务留一些上下文。<br>粘贴图片（⌘V），或点击「编辑」写 Markdown。</div>'}</div>`}
    ${!readOnly?`<div class="detail-actions"><button id="paste-image" class="quiet" title="复制截图或图片后按 ⌘V">▧ 粘贴图片</button><button id="insert-md" class="quiet">↓ 插入 .md</button>${!isCycle?'<button id="detail-add-child" class="quiet">＋ 子任务</button><button id="task-more" class="quiet">更多 ···</button>':''}</div>`:''}
    <section id="attachment-section" class="attachment-section" aria-label="文件附件"></section>
    <p class="detail-tip">${readOnly?'已保存此双周的任务与笔记。':'⌘V 粘贴图片 · 点击图片可放大 · 自动保存'}<br>${!isCycle?'每个任务独立记录状态，父任务不会自动完成。':''}</p>`;
  renderAttachmentSection();
  $('#close-detail').onclick=()=>{selectedId=null;renderDetail();renderTasks();};
  fitDetailTitle();
  $('#detail-title')?.addEventListener('focus',snapshot);
  $('#detail-title')?.addEventListener('input',e=>{target.title=e.target.value;fitDetailTitle();persist();renderTasks();});
  $('#detail-title')?.addEventListener('blur',e=>{if(!target.title.trim()){target.title='未命名任务';e.target.value=target.title;changed(false);renderTasks();}});
  $('#detail-status')?.addEventListener('change',e=>mutate(()=>target.status=e.target.value));
  $('#note-edit')?.addEventListener('click',()=>{editing=true;renderDetail();$('#note-editor').focus();});
  $('#note-preview').onclick=()=>{editing=false;renderDetail();};
  $('#note-editor')?.addEventListener('focus',snapshot);
  $('#note-editor')?.addEventListener('input',e=>{target.notes=e.target.value;persist();});
  $('#paste-image')?.addEventListener('click',()=>requestImagePaste(true));
  $('#insert-md')?.addEventListener('click',()=>post('importMarkdown',{target:'note'}));
  $('#detail-add-child')?.addEventListener('click',()=>addChild(selectedId));
  $('#task-more')?.addEventListener('click',()=>taskMore(selectedId));
  $$('#note-rendered input').forEach(el=>{if(el.type!=='checkbox')el.remove();else el.disabled=true;});
}
function renderAll(){renderSidebar();renderHeader();renderTasks();renderDetail();}
function showModal(html){$('#modal').classList.remove('image-viewer');$('#modal-content').innerHTML=html;$('#modal').showModal();$$('[data-dismiss]').forEach(b=>b.onclick=()=>$('#modal').close());}
function closeModal(){$('#modal').close();}
function addChild(id){
  const t=B.find(current().tasks,id);if(!t||current().archived)return;
  showModal(`<h2>添加子任务</h2><p>属于 ${esc(t.title)}</p><form id="child-form"><input id="child-title" class="note-editor" style="min-height:42px;height:42px" placeholder="子任务标题" aria-label="子任务标题" required maxlength="1000"><div class="modal-actions"><button type="button" class="secondary" data-dismiss>取消</button><button class="primary" type="submit">添加子任务</button></div></form>`);
  $('#child-title').focus();$('#child-form').onsubmit=e=>{e.preventDefault();const title=$('#child-title').value.trim();if(!title)return;let depth=0;const findDepth=(arr,d)=>arr.forEach(x=>{if(x.id===id)depth=d;findDepth(x.children,d+1);});findDepth(current().tasks,0);if(depth>=31){toast('最多支持 32 层任务');return;}mutate(()=>{const child=B.task(title);t.children.push(child);t.collapsed=false;selectedId=child.id;});closeModal();};
}
function taskMore(id){
  const t=B.find(current().tasks,id);let parent=null;B.walk(current().tasks,(x,p)=>{if(x.id===id)parent=p;});const siblings=parent?parent.children:current().tasks, index=siblings.findIndex(x=>x.id===id);
  showModal(`<h2>管理任务</h2><p>${esc(t.title)}${t.children.length?' · 包含 '+B.counts(t.children).total+' 个子任务':''}</p><div class="backup-actions"><button id="move-up" class="secondary" ${index===0?'disabled':''}>↑ 上移</button><button id="move-down" class="secondary" ${index===siblings.length-1?'disabled':''}>↓ 下移</button>${parent?'<button id="promote" class="secondary">提升一级</button>':''}</div><div class="settings-group"><button id="delete-task" class="secondary danger">删除任务${t.children.length?'及全部子任务':''}</button><p>删除后可撤销。子任务会随父任务一起删除。</p></div><div class="modal-actions"><button class="secondary" data-dismiss>关闭</button></div>`);
  $('#move-up').onclick=()=>{moveStep(id,-1);closeModal();};
  $('#move-down').onclick=()=>{moveStep(id,1);closeModal();};
  $('#promote')?.addEventListener('click',()=>{mutate(()=>{let grand=null;B.walk(current().tasks,(x,p)=>{if(x.id===parent.id)grand=p;});const arr=grand?grand.children:current().tasks;siblings.splice(index,1);arr.splice(arr.indexOf(parent)+1,0,t);});closeModal();});
  $('#delete-task').onclick=()=>{mutate(()=>{siblings.splice(index,1);selectedId=null;});closeModal();toast('已删除任务'+(t.children.length?'及其子任务':''),true);};
}
function openImport(text=''){
  if(current().archived){toast('请先选择当前双周再导入');return;}
  showModal(`<h2>插入 Markdown</h2><p>粘贴内容，或选择 .md 文件。嵌套清单会成为可折叠的子任务；<code>[doing]</code> 和 <code>[x]</code> 自动识别状态。</p><textarea id="import-text" aria-label="要导入的 Markdown" placeholder="# 我的双周\n\n- [ ] 项目 A\n  - [ ] [doing] 正在推进\n  - [x] 已完成">${esc(text)}</textarea><div class="modal-preview" id="import-preview"></div><label><input type="radio" name="import-mode" value="tasks" checked> 转成任务清单</label>　<label><input type="radio" name="import-mode" value="note"> 插入为双周笔记</label><div class="modal-actions"><button id="choose-md" class="secondary">选择 .md 文件</button><button class="secondary" data-dismiss>取消</button><button id="confirm-import" class="primary">插入当前双周</button></div>`);
  const preview=()=>{try{const p=MarkdownIO.importMarkdown($('#import-text').value);$('#import-preview').textContent=`识别到 ${B.counts(p.tasks).total} 个任务${p.notes?'，以及 Markdown 正文':''}${importedFilename?' · '+importedFilename:''}`;}catch(e){$('#import-preview').textContent=e.message;}};
  $('#import-text').oninput=preview;preview();$('#choose-md').onclick=()=>post('importMarkdown',{target:'tasks'});
  $('#confirm-import').onclick=()=>{const src=$('#import-text').value;if(!src.trim())return;try{const parsed=MarkdownIO.importMarkdown(src);const asNote=$('input[name=import-mode]:checked').value==='note';const candidate=structuredClone(state), c=candidate.cycles.find(c=>c.id===cycleId);if(asNote)c.notes=[c.notes,src].filter(Boolean).join('\n\n');else{c.tasks.push(...parsed.tasks);c.notes=[c.notes,parsed.notes].filter(Boolean).join('\n\n');}B.validate(candidate);snapshot();state=candidate;filter='all';query='';$('#search').value='';if(asNote||!parsed.tasks.length)selectedId='cycle';changed();closeModal();toast(asNote?'Markdown 已插入双周笔记':`已导入 ${B.counts(parsed.tasks).total} 个任务`);}catch(e){toast(e.message);}};
}
function openArchive(){
 const c=active(), count=B.counts(B.carry(c.tasks)).total;
 showModal(`<h2>完成这个双周</h2><p>${fmt(c.start)} — ${fmt(B.addDays(c.start,13))} 将保留为只读归档。下一个双周从 <b>${B.addDays(c.start,14)}</b> 开始。</p><label><input id="carry-next" type="checkbox" ${state.settings.carryUnfinished?'checked':''}> 延续 ${count} 个未完成任务（含父级）到新双周</label><p>原双周保留全部任务、状态和笔记；新双周中的任务独立更新。</p><div class="modal-actions"><button class="secondary" data-dismiss>取消</button><button id="confirm-archive" class="primary">归档并开启下一双周</button></div>`);
 $('#confirm-archive').onclick=()=>{snapshot();const next=B.nextCycle(state,$('#carry-next').checked);cycleId=next.id;selectedId=null;filter='all';query='';$('#search').value='';changed();closeModal();toast('双周已归档，新双周已开启',true);};
}
function settings(){
 showModal(`<h2>偏好与备份</h2><div class="settings-group"><h3>双周自动归档</h3><label><input id="auto-carry" type="checkbox" ${state.settings.carryUnfinished?'checked':''}> 新双周自动延续未完成任务</label><p>以当前双周的开始日期为锚点，每 14 天归档。App 打开或运行时自动检查，归档仍可浏览与导出。</p><label>当前双周开始 <input id="start-date" type="date" value="${active().start}"></label><p id="date-error" class="error-text"></p></div><div class="settings-group"><h3>数据保存在本机</h3><p class="mono">${esc(diskPath||'浏览器本地存储（预览模式）')}</p><div class="backup-actions"><button id="backup-export" class="secondary">导出完整备份</button><button id="backup-restore" class="secondary">恢复备份…</button><button id="data-folder" class="secondary">打开数据目录</button></div><p>完整备份包含所有双周。每天保留一份自动备份，最多 14 份。</p></div>${gitSettingsHTML()}<div class="settings-group"><h3>快捷键</h3><p>⌘ 1 专注 Doing　⌘ 0 全部任务　⌘ N 新任务<br>⌘ F 搜索　⌘ I 导入 Markdown　⌘ Z 撤销</p></div><div class="modal-actions"><button class="secondary" data-dismiss>取消</button><button id="save-settings" class="primary">保存双周设置</button></div>`);
 bindGitSettings();
 $('#save-settings').onclick=()=>{const date=$('#start-date').value;try{const candidate=structuredClone(state);candidate.settings.carryUnfinished=$('#auto-carry').checked;candidate.cycles.find(c=>!c.archived).start=date;B.validate(candidate);snapshot();state=candidate;changed();closeModal();toast('设置已保存');}catch(e){$('#date-error').textContent=e.message;}};
 $('#backup-export').onclick=()=>{flush();post('export',{name:'Biweekly-backup-'+B.key()+'.json',content:JSON.stringify(state,null,2)});};
 $('#backup-restore').onclick=()=>post('restoreBackup');$('#data-folder').onclick=()=>post('showDataFolder');
}
function checkRollover(){if(!state||locked||$('#modal').open)return;if(B.rollover(state)){history=[];cycleId=active().id;selectedId=null;changed();toast('新的双周开始了，上个双周已自动归档。');}}
window.BiweeklyNative={
 filesAttached:receiveFileAttachments,
 pasteImageCommand:requestImagePaste,imagePasted:receiveImagePaste,gitStatus:receiveGitStatus,
 bootstrap(data,info={}){if(nativeReady)return;nativeReady=true;diskPath=info.path||'';try{state=data?B.validate(data):B.initial();B.rollover(state);cycleId=active().id;renderAll();persist();if(info.warning)toast(info.warning);}catch(e){locked=true;$('#task-list').innerHTML=`<div class="empty"><strong>数据暂时无法读取</strong>${esc(e.message)}<br>请通过「偏好与备份」恢复 JSON 备份。</div>`;state=B.initial();cycleId=state.cycles[0].id;renderSidebar();$('#save-label').textContent='数据读取失败 · 已停止写入';}window.__ready=true;},
 saved(revision,error){if(error){$('#save-label').textContent='保存失败';toast(error);}else if(revision===saveRevision)$('#save-label').textContent='本地存储 · 已保存';},
 imported(text,name,target){importedFilename=name;if(target==='note'&&selected()&&!current().archived){mutate(()=>selected().notes=[selected().notes,text].filter(Boolean).join('\n\n'));editing=false;renderDetail();toast('Markdown 已插入笔记');}else if($('#modal').open&&$('#import-text')){$('#import-text').value=text;$('#import-text').dispatchEvent(new Event('input'));}else openImport(text);},
 restore(text){try{const candidate=B.validate(JSON.parse(text));showModal(`<h2>恢复完整备份</h2><p>备份包含 ${candidate.cycles.length} 个双周、${candidate.cycles.reduce((n,c)=>n+B.counts(c.tasks).total,0)} 个任务。恢复会替换当前数据，当前内容将先保存为独立备份。</p><div class="modal-actions"><button class="secondary" data-dismiss>取消</button><button id="restore-confirm" class="primary">恢复这份备份</button></div>`);$('#restore-confirm').onclick=()=>{pendingRestore=candidate;$('#restore-confirm').disabled=true;if(native)post('beforeRestore',{data:JSON.stringify(pendingRestore)});else window.BiweeklyNative.restorePrepared(null);};}catch(e){toast('无法恢复：'+e.message);}},
 restorePrepared(error,preparedState){if(error){pendingRestore=null;toast(error);$('#restore-confirm').disabled=false;return;}if(!pendingRestore)return;if(preparedState)pendingRestore=B.validate(preparedState);snapshot();state=pendingRestore;pendingRestore=null;locked=false;B.rollover(state);cycleId=active().id;selectedId=null;filter='all';query='';$('#search').value='';changed();flush();closeModal();toast('备份已恢复',true);},
 command(name){if(!state)return;const actions={import:()=>openImport(),export:()=>$('#export-btn').click(),new:()=>{$('#new-task').focus();},doing:()=>$('#focus-doing').click(),all:()=>{filter='all';renderAll();},search:()=>$('#search').focus(),settings,undo:undoChange};actions[name]?.();},
 flush,error:toast
};
$('#quick-add').onsubmit=e=>{e.preventDefault();const title=$('#new-task').value.trim();if(!title)return;mutate(()=>current().tasks.push(B.task(title)));$('#new-task').value='';query='';$('#search').value='';if(filter!=='all'&&filter!=='todo')filter='all';renderHeader();renderTasks();toast('已添加任务');};
$('#focus-doing').onclick=()=>{cycleId=active().id;filter='doing';query='';$('#search').value='';selectedId=null;renderAll();};
$$('[data-filter]').forEach(b=>b.onclick=()=>{filter=b.dataset.filter;renderHeader();renderTasks();});
$('#search').oninput=e=>{query=e.target.value;renderTasks();};
$('#git-status-btn').onclick=()=>{if(gitInfo.enabled){flush();post('gitSync');}else settings();};
$('#import-btn').onclick=()=>openImport();$('#archive-btn').onclick=openArchive;$('#settings-btn').onclick=settings;
$('#export-btn').onclick=()=>post('export',{name:current().start+'-双周.md',content:MarkdownIO.exportMarkdown(current())});
$('#expand-all').onclick=()=>{B.walk(current().tasks,t=>t.collapsed=false);persist();renderTasks();};
$('#collapse-all').onclick=()=>{if(filter!=='all'||query){toast('切回「全部」并清除搜索后可收起任务。');return;}B.walk(current().tasks,t=>t.collapsed=true);persist();renderTasks();};
$('#cycle-notes-btn').onclick=()=>{selectedId='cycle';editing=false;renderDetail();renderTasks();};
$('#modal').addEventListener('click',e=>{if(e.target===$('#modal')){const rect=$('#modal').getBoundingClientRect();if(e.clientX<rect.left||e.clientX>rect.right||e.clientY<rect.top||e.clientY>rect.bottom)closeModal();}});
document.addEventListener('keydown',e=>{if(e.key==='Escape'){selectedId=null;renderDetail();renderTasks();}if(!(e.metaKey||e.ctrlKey))return;const typing=/INPUT|TEXTAREA/.test(document.activeElement.tagName);if(e.key==='z'&&typing)return;if($('#modal').open)return;const commands={'1':'doing','0':'all',n:'new',f:'search',i:'import',',':'settings',z:'undo'};if(commands[e.key]){e.preventDefault();window.BiweeklyNative.command(commands[e.key]);}});
document.addEventListener('click',e=>{const link=e.target.closest('.markdown a');if(link&&!e.target.closest('img')){e.preventDefault();post('openURL',{url:link.href});}});
window.addEventListener('blur',flush);window.addEventListener('focus',checkRollover);setInterval(checkRollover,60000);
window.addEventListener('beforeunload',flush);
if(native)post('load');else{let data;try{data=JSON.parse(localStorage.getItem('biweekly-state'));}catch{}window.BiweeklyNative.bootstrap(data);}

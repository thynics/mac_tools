'use strict';
const pendingFileAttachments=new Map();
function attachmentContext(){
  if(!state||!selected()||$('#modal').open)return null;
  if(current().archived||locked){toast('这个双周的附件是只读的。');return null;}
  return {cycleId,targetId:selectedId};
}
function beginAttachmentRequest(context=attachmentContext()){
  if(!context)return null;
  const request=B.uid();pendingFileAttachments.set(request,{...context});
  renderAttachmentSection();return request;
}
function attachFiles(){
  const request=beginAttachmentRequest();if(!request)return;
  if(native)post('chooseAttachments',{request});else{$('#attachment-input').click();$('#attachment-input').dataset.request=request;}
}
function fileSize(bytes){return bytes>=1000000?(bytes/1000000).toFixed(1)+' MB':bytes>=1000?(bytes/1000).toFixed(1)+' KB':bytes+' B';}
function renderAttachmentSection(){
  const area=$('#attachment-section'),target=selected();if(!area||!target)return;
  const readonly=current().archived||locked,files=target.attachments||[];
  const pending=[...pendingFileAttachments.values()].some(p=>p.cycleId===cycleId&&p.targetId===selectedId);
  area.innerHTML=`<div class="attachment-heading"><span>附件 <b>${files.length}</b></span>${!readonly?`<button id="attach-files" class="text-button" ${pending?'disabled':''}>${pending?'正在复制…':'＋ 附加文件'}</button>`:''}</div>
  ${files.length?`<div class="attachment-list">${files.map(f=>`<div class="attachment-row"><span class="attachment-type">${esc((f.name.includes('.')?f.name.split('.').pop():'FILE').slice(0,5).toUpperCase())}</span><button class="attachment-name" data-open-file="${esc(f.path)}" title="打开 ${esc(f.name)}">${esc(f.name)}<small>${fileSize(f.size)} · 本地副本</small></button><button class="attachment-reveal" data-reveal-file="${esc(f.path)}" title="在 Finder 中显示" aria-label="在 Finder 中显示 ${esc(f.name)}">↗</button>${!readonly?`<button class="attachment-remove" data-remove-file="${esc(f.path)}" title="移除附件" aria-label="移除附件 ${esc(f.name)}">×</button>`:''}</div>`).join('')}</div>`:`<div class="attachment-empty">${readonly?'暂无附件':'拖入文件，或点击「附加文件」'}</div>`}
  ${!readonly?'<p class="attachment-hint">默认复制到数据目录 · 单文件 ≤ 50 MB</p><input id="attachment-input" type="file" multiple hidden>':''}`;
  $('#attach-files')?.addEventListener('click',attachFiles);
  $$('[data-open-file]').forEach(el=>el.onclick=()=>post('openAttachment',{path:el.dataset.openFile}));
  $$('[data-reveal-file]').forEach(el=>el.onclick=()=>post('revealAttachment',{path:el.dataset.revealFile}));
  $$('[data-remove-file]').forEach(el=>el.onclick=()=>{
    mutate(()=>{target.attachments=target.attachments.filter(f=>f.path!==el.dataset.removeFile);});toast('已移除附件',true);
  });
  $('#attachment-input')?.addEventListener('change',async event=>{
    const request=event.target.dataset.request;pendingFileAttachments.delete(request);
    await acceptDroppedFiles([...event.target.files]);
  });
}
function receiveFileAttachments(request,records,error){
  const context=pendingFileAttachments.get(request);pendingFileAttachments.delete(request);if(!context)return;
  const resolve=context.resolve;
  try{
    B.validateAttachments(records||[]);
    const cycle=state.cycles.find(c=>c.id===context.cycleId),target=context.targetId==='cycle'?cycle:B.find(cycle?.tasks||[],context.targetId);
    if(!target||cycle.archived||locked)throw Error('原笔记已删除或归档，未添加附件。');
    const existing=target.attachments||[],added=(records||[]).filter((f,i,all)=>!existing.some(old=>old.path===f.path)&&all.findIndex(item=>item.path===f.path)===i);
    B.validateAttachments([...existing,...added]);
    if(added.length){snapshot();target.attachments=[...existing,...added];persist();renderTasks();}
    renderAttachmentSection();
    if(error)toast((added.length?`已添加 ${added.length} 个附件；`:'')+error);
    else if(added.length)toast(`已复制并添加 ${added.length} 个附件`,true);
    else if(records?.length)toast('文件已在这条笔记中');
  }catch(e){toast(e.message);renderAttachmentSection();}
  resolve?.();
}
async function acceptDroppedFiles(files){
  const context=attachmentContext();if(!context)return;
  if(files.length>20){toast('一次最多附加 20 个文件。');return;}
  for(const file of files){
    if(file.size>50000000){toast(`${file.name} 超过 50 MB，未附加。`);continue;}
    const request=beginAttachmentRequest(context);
    try{
      const contents=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(Error('无法读取 '+file.name));reader.readAsDataURL(file);});
      if(native){
        const completed=new Promise(resolve=>pendingFileAttachments.get(request).resolve=resolve);
        post('attachFileData',{request,name:file.name,base64:contents.slice(contents.indexOf(',')+1)});
        await completed;
      }else{receiveFileAttachments(request,[],'请在双周 App 中附加文件。');}
    }catch(e){receiveFileAttachments(request,[],e.message);}
  }
}
document.addEventListener('dragover',event=>{
  if(![...(event.dataTransfer?.types||[])].includes('Files'))return;
  event.preventDefault();
  const allowed=!!event.target.closest?.('#detail')&&!!selected()&&!current().archived&&!locked;
  event.dataTransfer.dropEffect=allowed?'copy':'none';$('#detail').classList.toggle('file-drop-active',allowed);
});
document.addEventListener('dragleave',event=>{if(!event.relatedTarget||!event.relatedTarget.closest?.('#detail'))$('#detail').classList.remove('file-drop-active');});
document.addEventListener('drop',event=>{
  const files=[...(event.dataTransfer?.files||[])];if(!files.length)return;
  event.preventDefault();$('#detail').classList.remove('file-drop-active');
  if(!event.target.closest?.('#detail')){toast('请打开任务笔记，将文件拖入右侧附件区。');return;}
  if([...(event.dataTransfer?.items||[])].some(item=>item.webkitGetAsEntry?.()?.isDirectory)){toast('文件夹请先压缩后附加。');return;}
  acceptDroppedFiles(files);
});

'use strict';
const pendingImagePastes=new Map();
const localImagePattern=/^biweekly-image:\/\/local\/[a-f0-9]{64}\.png$/;
DOMPurify.addHook('uponSanitizeAttribute',(node,event)=>{
  if(node.tagName==='IMG'&&event.attrName==='src'&&localImagePattern.test(event.attrValue))event.forceKeepAttr=true;
});
function imagePasteContext(explicit=false){
  if(!state||!selected()||$('#modal').open)return null;
  const focused=document.activeElement;
  if(!explicit&&/INPUT|TEXTAREA/.test(focused.tagName)&&focused.id!=='note-editor')return null;
  if(current().archived||locked){toast('这个双周已归档，笔记不能修改。');return null;}
  const editor=$('#note-editor'),notes=selected().notes;
  return {cycleId:cycleId,targetId:selectedId,notes,start:editor?editor.selectionStart:notes.length,end:editor?editor.selectionEnd:notes.length};
}
function requestImagePaste(explicit=false){
  const context=imagePasteContext(explicit);if(!context)return false;
  const request=B.uid();pendingImagePastes.set(request,context);
  if(native)post('pasteImage',{request});
  else{pendingImagePastes.delete(request);toast('请在笔记区域直接粘贴图片。');}
  return true;
}
function receiveImagePaste(request,url,error){
  const context=pendingImagePastes.get(request);pendingImagePastes.delete(request);if(!context)return;
  if(error){toast(error);return;}
  if(!localImagePattern.test(url||'')&&!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(url||'')){toast('图片地址无效。');return;}
  const cycle=state.cycles.find(c=>c.id===context.cycleId),target=context.targetId==='cycle'?cycle:B.find(cycle?.tasks||[],context.targetId);
  if(!target||cycle.archived||locked){toast('原笔记已删除或归档，未插入图片。');return;}
  snapshot();
  const text=`\n\n![图片](${url})\n\n`;
  target.notes=target.notes===context.notes?target.notes.slice(0,context.start)+text+target.notes.slice(context.end):target.notes+'\n'+text;
  const visible=cycleId===context.cycleId&&selectedId===context.targetId;
  if(visible)editing=false;
  persist();renderTasks();if(visible)renderDetail();
  toast(visible?'图片已插入笔记 · 点击可放大':'图片已插入原任务的笔记',true);
}
document.addEventListener('paste',event=>{
  const file=[...(event.clipboardData?.files||[])].find(f=>f.type.startsWith('image/'));
  if(!file)return;
  const context=imagePasteContext();if(!context)return;
  event.preventDefault();
  if(native){requestImagePaste();return;}
  if(file.size>20_000_000){toast('图片过大，请裁剪后重试。');return;}
  const request=B.uid();pendingImagePastes.set(request,context);
  const reader=new FileReader();reader.onload=()=>receiveImagePaste(request,reader.result,null);reader.onerror=()=>receiveImagePaste(request,null,'无法读取图片。');reader.readAsDataURL(file);
});
document.addEventListener('click',event=>{
  const picture=event.target.closest?.('#note-rendered img');if(!picture)return;
  event.preventDefault();
  showModal(`<h2>图片预览</h2><img class="full-note-image" src="${esc(picture.getAttribute('src'))}" alt="${esc(picture.alt||'笔记图片')}"><div class="modal-actions"><button class="secondary" data-dismiss>关闭</button></div>`);
  $('#modal').classList.add('image-viewer');
});

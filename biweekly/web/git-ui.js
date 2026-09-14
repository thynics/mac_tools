'use strict';
let gitInfo={enabled:false,remote:'',intervalMinutes:5,status:'未启用 Git 备份',running:false};
function receiveGitStatus(info){
  gitInfo=info;
  const button=$('#git-status-btn');button.textContent=info.running?'↻ Git 备份中…':info.failure?'! Git 备份失败':info.enabled?(info.lastSync?'↥ Git 已备份 '+info.lastSync:'↥ Git 等待备份'):'↥ 设置 Git 备份';
  button.title=info.status;button.classList.toggle('danger',!!info.failure);button.disabled=!!info.running;
  if($('#git-now'))$('#git-now').disabled=!info.enabled||info.running;
  if($('#git-settings-status'))$('#git-settings-status').textContent=info.status;
  if($('#git-repository-path'))$('#git-repository-path').textContent=info.repository||'';
}
function gitSettingsHTML(){
  return `<div class="settings-group"><h3>Git 定期备份</h3><label><input id="git-enabled" type="checkbox" ${gitInfo.enabled?'checked':''}> 开启自动备份</label><label class="git-interval">每 <input id="git-interval" type="number" min="1" max="1440" value="${gitInfo.intervalMinutes}"> 分钟</label><input id="git-remote" class="git-remote" type="text" aria-label="Git 仓库地址" placeholder="git@github.com:用户名/仓库.git" value="${esc(gitInfo.remote)}"><p>App 运行时定期检查，有变化才提交并推送。每台设备独立存储，包含任务、笔记和图片。</p><p id="git-repository-path" class="mono">${esc(gitInfo.repository||'')}</p><p id="git-settings-status" class="git-status-text">${esc(gitInfo.status)}</p><div class="backup-actions"><button id="git-save" class="secondary">保存 Git 设置</button><button id="git-now" class="secondary" ${!gitInfo.enabled?'disabled':''}>立即备份</button></div></div>`;
}
function bindGitSettings(){
  $('#git-save').onclick=()=>{if(!native){toast('请在双周 App 中配置 Git 备份。');return;}post('configureGit',{enabled:$('#git-enabled').checked,remote:$('#git-remote').value,intervalMinutes:Number($('#git-interval').value)});};
  $('#git-now').onclick=()=>{flush();post('gitSync');};
}

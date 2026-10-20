(function(){
  'use strict';
  const P=window.Poker, AI=window.PokerAI, $=id=>document.getElementById(id);
  const SAVE_KEY='river-club-v1';
  const NAMES=['林间客','沈砚','顾北','洛川','青岚','陆沉','白夜','江屿','闻舟','莫离','墨白','长风','山海','周予','季然','南星','星野','司南','云生','千寻','远山','知秋','松月','寒江'];
  const BLINDS=[20,30,40,60,80,100,150,200,300,400,600,800,1200,1600,2400,3200,5000,8000,12000];
  let tournament=null, hand=null, groups=[], sideResults=[], roundPromise=null, epoch=0, locked=false, speed=1, sound=false, audio=null;
  let decisions=[], lastEvent=0, actionTimer=null, saved=null, setupPreviousFocus=null;
  const fmt=n=>Number(n).toLocaleString('en-US');
  const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const escape=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function tone(win=false){if(!sound)return;try{audio=audio||new (window.AudioContext||window.webkitAudioContext)();audio.resume();const o=audio.createOscillator(),g=audio.createGain();o.connect(g);g.connect(audio.destination);o.type='sine';o.frequency.value=win?660:380;g.gain.setValueAtTime(.028,audio.currentTime);g.gain.exponentialRampToValueAtTime(.001,audio.currentTime+.1);o.start();o.stop(audio.currentTime+.11);}catch{}}
  function card(c,hidden=false){if(hidden)return '<div class="card back" aria-label="未公开底牌"></div>';if(c===undefined)return '<div class="card placeholder" aria-label="尚未发牌"></div>';const v=P.cardLabel(c);return `<div class="card ${v.red?'red':''}" aria-label="${v.rank}${v.suit}"><span class="card-rank">${v.rank}</span><span class="card-suit">${v.suit}</span></div>`;}
  function playerName(p){return p.id===0?'你':escape(p.name);}
  function bigBlind(){const level=Math.floor((tournament.round-1)/8);return Math.min(tournament.initialCount*1000,BLINDS[level]||Math.round(12000*Math.pow(1.5,level-BLINDS.length+1)/100)*100);}
  function members(){return tournament.players.filter(p=>p.stack>0);}
  function snapshotHand(h){return {players:h.players,button:h.button,smallBlind:h.smallBlind,bigBlind:h.bigBlind,deck:h.deck,board:h.board,burned:h.burned,street:h.street,currentBet:h.currentBet,minRaise:h.minRaise,events:h.events,payouts:h.payouts,pots:h.pots,done:h.done,showdown:h.showdown,bankroll:h.bankroll,sb:h.sb,bb:h.bb,pending:[...h.pending],actor:h.actor};}
  function restoreHand(s){const h=Object.assign(Object.create(P.Hand.prototype),s);h.pending=new Set(s.pending);h.random=Math.random;return h;}
  function save(){if(!tournament)return;try{localStorage.setItem(SAVE_KEY,JSON.stringify({version:1,tournament,hand:hand?snapshotHand(hand):null,groups:groups.map(g=>g.map(p=>p.id)),sideResults,decisions,speed}));}catch{}}
  function clearSave(){try{localStorage.removeItem(SAVE_KEY);}catch{}}
  function validateSave(s){
    if(s?.version!==1||!Array.isArray(s.tournament?.players)||s.tournament.players.length<2||!Number.isInteger(s.tournament.round)||s.tournament.round<1)return false;
    const ps=s.tournament.players;if(!ps.every((p,i)=>p.id===i&&Number.isInteger(p.stack)&&p.stack>=0))return false;
    if(!s.hand||!Array.isArray(s.hand.players)||s.hand.players.length<2||s.hand.players.length>9||!Array.isArray(s.hand.pending))return false;
    return true;
  }
  function buildGroups(){
    const active=members();
    // Balanced tables have 2–9 players; player order rotates each round.
    const count=Math.ceil(active.length/9), groups=Array.from({length:count},()=>[]);
    const shift=(tournament.round-1)%active.length;
    const ordered=[...active.slice(shift),...active.slice(0,shift)];
    ordered.forEach((p,i)=>groups[i%count].push(p));
    const heroTable=groups.findIndex(g=>g.some(p=>p.id===0));
    [groups[0],groups[heroTable]]=[groups[heroTable],groups[0]];
    // Keep the hero at the bottom of the displayed table, independent of button.
    const h=groups[0].findIndex(p=>p.id===0);groups[0]=[...groups[0].slice(h),...groups[0].slice(0,h)];
    return groups;
  }
  function initTournament(count){
    epoch++;clearTimeout(actionTimer);locked=false;roundPromise=null;
    tournament={round:1,initialCount:count,players:Array.from({length:count},(_,id)=>({id,name:id===0?'本地玩家':NAMES[(id-1)%NAMES.length]+(id>NAMES.length?' '+(Math.floor((id-1)/NAMES.length)+1):''),stack:1000,style:(id-1+AI.STYLES.length)%AI.STYLES.length})),observed:{},eliminated:0,finished:false};
    $('setup-layer').hidden=true;$('setup-error').textContent='';startRound();
  }
  async function runSides(token){
    for(let t=1;t<groups.length;t++){
      if(token!==epoch)return;
      // Completed tables are persisted, so closing the app cannot replay their results.
      if(sideResults.some(r=>r.table===t))continue;
      const h=new P.Hand(groups[t],{button:(tournament.round-1)%groups[t].length,smallBlind:Math.floor(bigBlind()/2),bigBlind:bigBlind()});
      let steps=0;
      while(!h.done){const d=AI.decide(h,h.actor,{iterations:180,observed:tournament.observed});h.act(h.actor,d.type,d.to);if(++steps%6===0){await pause(0);if(token!==epoch)return;}}
      sideResults.push({table:t,players:h.players.map(p=>({id:p.id,stack:p.stack}))});
      save();$('table-notice').textContent=`其他牌桌已完成 ${t} / ${groups.length-1}`;
      await pause(0);
    }
  }
  function startRound(){
    const token=epoch;groups=buildGroups();sideResults=[];decisions=[];lastEvent=0;
    hand=new P.Hand(groups[0],{button:(tournament.round-1)%groups[0].length,smallBlind:Math.floor(bigBlind()/2),bigBlind:bigBlind()});
    $('activity').innerHTML='';$('observation').innerHTML='<h3>观察行动，形成判断</h3><p>NPC 的底牌与决策数据会保持隐藏，直到本手结束。跟注、加注和下注尺度都是可用的信息。</p>';
    render();save();roundPromise=runSides(token);advance(token);
  }
  function observe(i,type){const id=hand.players[i].id;const o=tournament.observed[id]||(tournament.observed[id]={actions:0,folds:0,raises:0,foldRate:.4});o.actions++;if(type==='fold')o.folds++;if(type==='raise'||type==='allin')o.raises++;o.foldRate=(o.folds+2)/(o.actions+5);}
  async function advance(token=epoch){
    clearTimeout(actionTimer);
    if(token!==epoch||!hand||tournament.finished)return;
    if(hand.done){await finishRound(token);return;}
    render();save();
    if(hand.players[hand.actor].id===0){locked=false;renderActions();return;}
    locked=true;renderActions();
    actionTimer=setTimeout(async()=>{
      if(token!==epoch||!$('setup-layer').hidden||!$('rules-layer').hidden)return;
      try{
        const i=hand.actor,d=AI.decide(hand,i,{observed:tournament.observed,iterations:240});
        decisions.push({player:hand.players[i].id,name:hand.players[i].name,street:hand.street,...d});observe(i,d.type);hand.act(i,d.type,d.to);tone();render();save();advance(token);
      }catch(e){showError(e);}
    },speed===1?650:160);
  }
  async function finishRound(token){
    locked=true;render();
    $('action-panel').innerHTML='<div class="waiting-panel"><span class="waiting-icon pulse">♠</span><div><h3>正在结算本轮</h3><p>其他牌桌也在进行同一手对局…</p></div></div>';
    await roundPromise;
    if(token!==epoch)return;
    const results=[...hand.players,...sideResults.flatMap(r=>r.players)];
    results.forEach(p=>{tournament.players[p.id].stack=p.stack;});
    if(tournament.players.reduce((s,p)=>s+p.stack,0)!==tournament.initialCount*1000){showError(new Error('锦标赛筹码守恒检查失败'));return;}
    tournament.eliminated=tournament.initialCount-members().length;
    tournament.finished=tournament.players[0].stack===0||members().length===1;
    locked=false;render();renderReview();save();tone(true);
    const hero=hand.players.find(p=>p.id===0);
    $('table-notice').textContent=tournament.finished?'本场锦标赛已结束':`本轮完成 · 已淘汰 ${tournament.eliminated} 人${hero.stack>0&&groups.length>1?' · 下手自动平衡牌桌':''}`;
  }
  function render(){renderTable();renderStats();renderActivity();renderActions();}
  function renderTable(){
    if(!hand)return;
    $('pot').textContent=fmt(hand.pot);
    const key=hand.board.join(',');
    if($('board').dataset.cards!==key){$('board').innerHTML=Array.from({length:5},(_,i)=>card(hand.board[i])).join('');$('board').dataset.cards=key;}
    const street=['翻牌前 · PREFLOP','翻牌 · FLOP','转牌 · TURN','河牌 · RIVER'][hand.street];
    $('street-label').textContent=hand.done?(hand.showdown?'摊牌 · SHOWDOWN':'本手结束'):street;
    const n=hand.players.length;
    $('seats').innerHTML=hand.players.map((p,i)=>{
      const theta=Math.PI/2+i*Math.PI*2/n;
      const x=50+Math.cos(theta)*41,y=i===0?84:49+Math.sin(theta)*33;
      const s=AI.STYLES[p.style%AI.STYLES.length],hero=p.id===0;
      const show=hero||hand.done&&hand.showdown&&!p.folded;
      const won=hand.done&&hand.payouts.some(w=>w.player===i);
      const action=hand.done?(won?'赢得 '+fmt(hand.payouts.filter(w=>w.player===i).reduce((a,b)=>a+b.amount,0)):p.folded?'弃牌':p.stack===0?'已出局':p.lastAction):hand.actor===i?(hero?'轮到你了':'思考中…'):p.lastAction||'待行动';
      return `<div class="seat ${hero?'is-hero':''} ${p.folded?'folded':''} ${i===hand.actor?'is-actor':''} ${won?'winner':''}" style="left:${x}%;top:${y}%" aria-label="${escape(p.name)}，筹码 ${p.stack}，${escape(action)}"><div class="hole-cards">${p.hole.map(c=>card(c,!show)).join('')}</div><div class="avatar" style="${hero?'':'background:'+s.color}" title="${hero?'本地玩家':s.tag}">${hero?'♠':s.icon}</div><div class="seat-name">${escape(p.name)}</div><div class="seat-stack">${fmt(p.stack)}</div><div class="seat-action">${escape(action)}</div>${i===hand.button?'<div class="dealer-chip" title="庄家">D</div>':''}${i===hand.sb?'<span class="blind-chip">SB</span>':i===hand.bb?'<span class="blind-chip">BB</span>':''}</div>`;
    }).join('');
    $('table-label').textContent=`主牌桌 · ${n} 人`;$('hand-label').textContent=`第 ${String(tournament.round).padStart(2,'0')} 手`;
    $('blind-label').textContent=`盲注 ${fmt(hand.smallBlind)} / ${fmt(hand.bigBlind)}`;
  }
  function renderStats(){
    if(!tournament)return;
    const live=members(),hero=hand&&!hand.done?hand.players.find(p=>p.id===0):tournament.players[0];
    const ahead=live.filter(p=>p.id!==0&&p.stack>hero.stack).length;
    $('remaining').textContent=fmt(live.length);$('my-rank').textContent=hero.stack?`${ahead+1}`:'出局';$('table-count').textContent=Math.ceil(live.length/9);
    $('session-status').textContent=tournament.finished?(hero.stack?'锦标赛冠军':'本场已结束'):`${fmt(tournament.initialCount)} 人锦标赛 · 正在进行`;
    $('session-total').textContent=`我的筹码 ${fmt(hero.stack)}`;
    const level=Math.floor((tournament.round-1)/8)+1;
    $('level-label').textContent=`盲注等级 ${String(level).padStart(2,'0')}`;$('level-next').textContent=`${8-(tournament.round-1)%8} 手后升级`;$('level-progress').style.width=((tournament.round-1)%8)/8*100+'%';
  }
  function renderActivity(){
    if(!hand)return;
    const fresh=hand.events.slice(lastEvent);lastEvent=hand.events.length;
    if(!fresh.length)return;
    for(const e of fresh){
      const el=document.createElement('div');
      if(e.type==='street'||e.type==='end'){el.className='activity-item street-event';el.textContent=e.text;}
      else {el.className='activity-item';el.innerHTML=`<i class="activity-dot"></i><div class="activity-body"><strong>${playerName(hand.players[e.player])}</strong><span>${['翻前','翻牌','转牌','河牌'][e.street??0]}</span><br>${escape(e.text)}</div>${e.amount?`<span class="activity-amount">${fmt(e.amount)}</span>`:''}`;}
      $('activity').appendChild(el);
    }
    $('activity').scrollTop=$('activity').scrollHeight;
  }
  function renderActions(){
    if(!hand)return;
    if(hand.done&&!locked){
      const hero=hand.players.find(p=>p.id===0), won=hand.payouts.filter(p=>hand.players[p.player].id===0).reduce((s,p)=>s+p.amount,0);
      const winners=[...new Set(hand.payouts.map(p=>playerName(hand.players[p.player])))].join('、');
      const result=tournament.finished?(hero.stack?'恭喜，你是本场冠军。':'筹码归零，本场结束。'):won?`你赢得了 ${fmt(won)} 筹码`:`${winners} 赢得本手`;
      const pots=hand.pots.map((p,i)=>`${i===0?'主池':'边池 '+i} ${fmt(p.amount)}`).join(' · ');
      const best=hand.showdown&&!hero.folded?`你的牌型：${P.evaluate([...hero.hole,...hand.board]).name}。 `:'';
      $('action-panel').innerHTML=`<div class="result-panel"><div><div class="result-kicker">${tournament.finished?'TOURNAMENT COMPLETE':'HAND COMPLETE'}</div><h3>${result}</h3><p>${best}${pots}。${tournament.finished?(hero.stack?'全部 '+fmt(tournament.initialCount*1000)+' 筹码已归你所有。':'已完成 '+tournament.round+' 手。再开一场，重新出发。'):'盲注和庄家将在下一手继续轮转。'}</p></div><button class="next-button" id="next-hand">${tournament.finished?'再来一场':'下一手'} →</button></div>`;
      $('next-hand').onclick=()=>{if(tournament.finished){showSetup();return;}tournament.round++;startRound();};return;
    }
    const heroTurn=!hand.done&&hand.actor>=0&&hand.players[hand.actor].id===0&&!locked;
    if(!heroTurn){const name=hand.actor>=0?escape(hand.players[hand.actor].name):'牌桌';$('action-panel').innerHTML=`<div class="waiting-panel"><span class="waiting-icon pulse">♠</span><div><h3>${hand.done?'正在结算本轮':name+' 正在思考'}</h3><p>${hand.done?'正在等待其他牌桌完成行动…':'观察下注尺度与位置，等待你的行动。'}</p></div></div>`;return;}
    const legal=hand.legal(),min=Math.min(legal.minTo,legal.maxTo);
    let defaultRaise=Math.min(legal.maxTo,Math.max(min,hand.currentBet===hand.bigBlind?hand.bigBlind*3:min));
    $('action-panel').innerHTML=`<div class="action-top"><div class="turn-label"><i></i>轮到你行动</div><span class="action-hint">${legal.canCheck?'可以免费过牌':`需跟注 ${fmt(legal.call)} · 底池赔率 ${Math.round(legal.call/(hand.pot+legal.call)*100)}%`}</span></div><div class="action-buttons"><button class="action-button fold" id="fold">弃牌</button><button class="action-button call" id="call">${legal.canCheck?'过牌':legal.call===hand.players[hand.actor].stack?'全押跟注 '+fmt(legal.call):'跟注 '+fmt(legal.call)}</button><button class="action-button raise" id="raise" ${legal.canRaise?'':'disabled'}>${legal.allinOnly?'全押 ':hand.currentBet?'加注至 ':'下注至 '}<span id="raise-label">${fmt(defaultRaise)}</span></button></div><div class="bet-controls"><span>加注至</span><input id="bet-slider" type="range" min="${min}" max="${legal.maxTo}" value="${defaultRaise}" step="1" aria-label="加注目标筹码" ${legal.canRaise?'':'disabled'}><input id="bet-amount" type="number" min="${min}" max="${legal.maxTo}" value="${defaultRaise}" aria-label="加注金额" ${legal.canRaise?'':'disabled'}><div class="quick-bets"><button data-bet="half" ${legal.canRaise?'':'disabled'}>½ 底池</button><button data-bet="pot" ${legal.canRaise?'':'disabled'}>底池</button><button data-bet="all" ${legal.canRaise?'':'disabled'}>全押</button></div></div>`;
    const setBet=n=>{n=Math.max(min,Math.min(legal.maxTo,Math.round(n)||min));$('bet-slider').value=n;$('bet-amount').value=n;$('raise-label').textContent=fmt(n);};
    $('bet-slider').oninput=e=>setBet(e.target.value);$('bet-amount').onchange=e=>setBet(e.target.value);$('bet-amount').oninput=e=>{$('raise-label').textContent=fmt(e.target.value);};
    $('fold').onclick=()=>heroAct('fold');$('call').onclick=()=>heroAct(legal.canCheck?'check':'call');$('raise').onclick=()=>{setBet($('bet-amount').value);heroAct('raise',Number($('bet-amount').value));};
    document.querySelectorAll('[data-bet]').forEach(b=>b.onclick=()=>{const type=b.dataset.bet;setBet(type==='all'?legal.maxTo:hand.currentBet+Math.round((hand.pot+legal.call)*(type==='half'?.5:1)));});
  }
  function heroAct(type,to){if(locked||!hand||hand.done||hand.actor<0||hand.players[hand.actor].id!==0||!$('setup-layer').hidden||!$('rules-layer').hidden)return;try{locked=true;observe(hand.actor,type);hand.act(hand.actor,type,to);tone();render();save();advance();}catch(e){locked=false;showError(e);}}
  function renderReview(){
    const d=[...decisions].reverse().find(d=>d.street>0)||decisions[decisions.length-1];
    if(!d){$('observation').innerHTML='<h3>这一手，胜在行动。</h3><p>未进入 NPC 决策即完成了全押结算。下一手注意有效筹码与盲注的关系。</p>';return;}
    $('observation').innerHTML=`<h3>${escape(d.name)} · ${['翻前','翻牌','转牌','河牌'][d.street]}决策复盘</h3><p>${escape(d.reason)}。</p><div class="equity-readout"><span>${d.street?'抽样胜率':'起手强度'} ${Math.round(d.equity*100)}%</span><span>所需胜率 ${Math.round(d.odds*100)}%</span></div>`;
  }
  function showError(e){console.error(e);$('table-notice').textContent='牌局遇到错误：'+e.message;$('action-panel').innerHTML='<div class="waiting-panel"><div><h3>牌局暂停</h3><p>可关闭后继续已保存的牌局，或点击右上角新建牌局。</p></div></div>';}
  function showSetup(){setupPreviousFocus=document.activeElement;clearTimeout(actionTimer);$('setup-form').dataset.confirm='';$('setup-error').textContent='';$('setup-layer').hidden=false;$('close-setup').hidden=!tournament;$('resume-game').hidden=!tournament&&!saved;$('player-count').focus();}
  function resume(){
    $('setup-layer').hidden=true;
    if(!tournament&&saved){
      epoch++;tournament=saved.tournament;hand=restoreHand(saved.hand);groups=saved.groups.map(ids=>ids.map(id=>tournament.players[id]));sideResults=saved.sideResults||[];decisions=saved.decisions||[];speed=saved.speed||1;lastEvent=0;
      $('activity').innerHTML='';$('speed').textContent=speed===1?'1× 速度':'4× 速度';
      roundPromise=runSides(epoch);render();
      if(hand.done){locked=false;roundPromise.then(()=>finishRound(epoch));}else advance();
    }else if(tournament){render();if(hand.done){if(!locked)renderReview();}else advance();}
    setupPreviousFocus?.focus();
  }
  function newGame(event){event.preventDefault();const input=$('player-count'),count=Number(input.value);if(!Number.isSafeInteger(count)||count<2||count*1000>Number.MAX_SAFE_INTEGER){$('setup-error').textContent='请输入不少于 2 的整数人数。';return;}if(tournament&&!tournament.finished){$('setup-error').textContent='再次点击“入座”将放弃当前牌局，开始新比赛。';if($('setup-form').dataset.confirm!=='yes'){$('setup-form').dataset.confirm='yes';return;}}$('setup-form').dataset.confirm='';$('start-button').disabled=true;setTimeout(()=>{try{initTournament(count);}catch(e){$('setup-error').textContent='无法创建牌局：'+e.message;}finally{$('start-button').disabled=false;}},30);}
  $('setup-form').onsubmit=newGame;$('new-game').onclick=showSetup;$('nav-table').onclick=()=>{if(!tournament)showSetup();};
  $('close-setup').onclick=resume;$('resume-game').onclick=resume;
  $('count-minus').onclick=()=>{$('player-count').value=Math.max(2,Number($('player-count').value)-1);updatePresets();};$('count-plus').onclick=()=>{$('player-count').value=Number($('player-count').value)+1;updatePresets();};
  function updatePresets(){document.querySelectorAll('[data-count]').forEach(b=>b.classList.toggle('selected',Number(b.dataset.count)===Number($('player-count').value)));$('setup-form').dataset.confirm='';$('setup-error').textContent='';}
  document.querySelectorAll('[data-count]').forEach(b=>b.onclick=()=>{$('player-count').value=b.dataset.count;updatePresets();});$('player-count').oninput=updatePresets;
  $('nav-rules').onclick=()=>{clearTimeout(actionTimer);$('rules-layer').hidden=false;$('close-rules').focus();};$('close-rules').onclick=()=>{$('rules-layer').hidden=true;if(tournament&&!hand.done&&$('setup-layer').hidden)advance();$('nav-rules').focus();};
  $('speed').onclick=()=>{speed=speed===1?4:1;$('speed').textContent=speed===1?'1× 速度':'4× 速度';save();};$('sound').onclick=()=>{sound=!sound;$('sound').textContent=sound?'♫':'♪';$('sound').style.color=sound?'#347452':'';$('sound').setAttribute('aria-label',sound?'关闭音效':'开启音效');tone();};
  const descriptions=['兼顾强牌取值与范围保护。','借助后位优势，选择时机施压。','重视胜率与底池赔率，耐心取值。','以高频加注与混合诈唬制造压力。','根据公开行动调整对手范围。','结合有效筹码和盲注，寻找全押时机。'];
  $('style-grid').innerHTML=AI.STYLES.map((s,i)=>`<div class="style-info"><strong>${s.icon} ${s.tag}</strong>${descriptions[i]}</div>`).join('');
  document.addEventListener('keydown',e=>{
    const modal=!$('rules-layer').hidden?$('rules-layer'):!$('setup-layer').hidden?$('setup-layer'):null;
    if(modal){if(e.key==='Escape'){if(modal===$('rules-layer'))$('close-rules').click();else if(tournament)resume();}if(e.key==='Tab'){const focus=[...modal.querySelectorAll('button:not([hidden]):not(:disabled),input')].filter(el=>el.offsetParent!==null);if(e.shiftKey&&document.activeElement===focus[0]){e.preventDefault();focus[focus.length-1]?.focus();}else if(!e.shiftKey&&document.activeElement===focus[focus.length-1]){e.preventDefault();focus[0]?.focus();}}return;}
    if(/INPUT|TEXTAREA/.test(e.target.tagName)||e.metaKey||e.ctrlKey||e.altKey)return;
    if(e.code==='Space'){e.preventDefault();$('call')?.click();}if(e.key.toLowerCase()==='f')$('fold')?.click();
  });
  window.addEventListener('pagehide',save);document.addEventListener('visibilitychange',()=>{if(document.hidden)save();});
  try{const s=JSON.parse(localStorage.getItem(SAVE_KEY));if(validateSave(s))saved=s;else if(s)clearSave();}catch{clearSave();}
  $('board').innerHTML=Array.from({length:5},()=>card()).join('');
  $('action-panel').innerHTML='<div class="waiting-panel"><span class="waiting-icon">♠</span><div><h3>你的私人牌桌，已经准备就绪。</h3><p>选择人数入座，与不同风格的高手过招。</p></div></div>';
  $('resume-game').hidden=!saved;$('close-setup').hidden=true;
  // Accessible test surface, also useful for diagnosing a saved local game.
  window.RiverClub={get tournament(){return tournament;},get hand(){return hand;},get locked(){return locked;},get groups(){return groups;},start:initTournament,act:heroAct,save};
})();

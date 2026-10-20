/* Pure, dependency-free no-limit Texas Hold'em engine. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Poker = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const SUITS = ['♠', '♥', '♣', '♦'];
  const CATEGORIES = ['高牌', '一对', '两对', '三条', '顺子', '同花', '葫芦', '四条', '同花顺'];
  const rank = c => c % 13 + 2;
  const suit = c => Math.floor(c / 13);
  const cardLabel = c => ({rank: ({11:'J',12:'Q',13:'K',14:'A'})[rank(c)] || String(rank(c)), suit:SUITS[suit(c)], red:suit(c) % 2 === 1});
  function rng(seed) {
    let n = seed >>> 0;
    return () => { n += 0x6D2B79F5; let t = n; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  }
  function shuffled(random = Math.random) {
    const d = Array.from({length:52}, (_,i) => i);
    for (let i=51;i>0;i--) { const j=Math.floor(random()*(i+1)); [d[i],d[j]]=[d[j],d[i]]; }
    return d;
  }
  function pack(v) { let n=0; for (let i=0;i<6;i++) n=n*15+(v[i]||0); return n; }
  function straightHigh(rs) {
    const set = new Set(rs); if(set.has(14)) set.add(1);
    for(let high=14;high>=5;high--) if([0,1,2,3,4].every(k=>set.has(high-k))) return high;
    return 0;
  }
  function evaluate(cards) {
    if(cards.length<5 || cards.length>7) throw new Error('评估需要 5 至 7 张牌');
    const ranks=cards.map(rank).sort((a,b)=>b-a), counts=new Map(), suits=[[],[],[],[]];
    for(const c of cards) { counts.set(rank(c),(counts.get(rank(c))||0)+1); suits[suit(c)].push(rank(c)); }
    const groups=[...counts].sort((a,b)=>b[1]-a[1] || b[0]-a[0]);
    const flush=suits.find(a=>a.length>=5);
    let v;
    if(flush && straightHigh(flush)) v=[8,straightHigh(flush)];
    else if(groups[0][1]===4) v=[7,groups[0][0],ranks.find(r=>r!==groups[0][0])];
    else if(groups[0][1]===3 && groups[1] && groups[1][1]>=2) v=[6,groups[0][0],groups[1][0]];
    else if(flush) v=[5,...flush.sort((a,b)=>b-a).slice(0,5)];
    else if(straightHigh(ranks)) v=[4,straightHigh(ranks)];
    else if(groups[0][1]===3) v=[3,groups[0][0],...ranks.filter(r=>r!==groups[0][0]).slice(0,2)];
    else if(groups[0][1]===2 && groups[1][1]===2) { const pairs=groups.filter(g=>g[1]===2).map(g=>g[0]).sort((a,b)=>b-a); v=[2,...pairs.slice(0,2),ranks.find(r=>!pairs.slice(0,2).includes(r))]; }
    else if(groups[0][1]===2) v=[1,groups[0][0],...ranks.filter(r=>r!==groups[0][0]).slice(0,3)];
    else v=[0,...ranks.slice(0,5)];
    return {score:pack(v), category:v[0], name:CATEGORIES[v[0]], kickers:v.slice(1)};
  }
  class Hand {
    constructor(members, options={}) {
      if(members.length<2 || members.length>9) throw new Error('每桌需要 2 至 9 人');
      this.players=members.map(p=>({...p,hole:[],streetBet:0,totalBet:0,folded:false,allin:false,lastAction:'',raiseAt:null}));
      this.button=options.button ?? 0;
      this.smallBlind=options.smallBlind || 10;
      this.bigBlind=options.bigBlind || 20;
      this.random=options.random || Math.random;
      this.deck=options.deck ? [...options.deck] : shuffled(this.random);
      this.board=[]; this.burned=[]; this.street=0; this.currentBet=0; this.minRaise=this.bigBlind;
      this.events=[]; this.payouts=[]; this.pots=[]; this.done=false; this.showdown=false;
      this.bankroll=this.players.reduce((s,p)=>s+p.stack,0);
      const n=this.players.length;
      if(this.players.some(p=>!Number.isInteger(p.stack)||p.stack<=0)) throw new Error('入座筹码必须为正整数');
      for(let round=0;round<2;round++) for(let j=1;j<=n;j++) this.players[(this.button+j)%n].hole.push(this.deck.pop());
      this.sb=n===2 ? this.button : (this.button+1)%n;
      this.bb=(this.sb+1)%n;
      this.post(this.sb,this.smallBlind,'小盲'); this.post(this.bb,this.bigBlind,'大盲');
      // A short big blind does not lower the minimum bring-in.
      this.currentBet=this.bigBlind;
      this.pending=new Set(this.players.map((_,i)=>i).filter(i=>this.canAct(i)));
      this.actor=this.findNext(this.bb);
      this.progress();
    }
    get pot() { return this.players.reduce((s,p)=>s+p.totalBet,0); }
    canAct(i) { const p=this.players[i]; return !p.folded && !p.allin; }
    pay(i,amount) { const p=this.players[i], paid=Math.min(p.stack,amount); p.stack-=paid; p.streetBet+=paid; p.totalBet+=paid; if(!p.stack)p.allin=true; return paid; }
    post(i,amount,label) { const paid=this.pay(i,amount); this.players[i].lastAction=label+' '+paid; this.events.push({type:'blind',player:i,amount:paid,text:label+' '+paid}); }
    findNext(after) { for(let j=1;j<=this.players.length;j++) { const i=(after+j)%this.players.length; if(this.pending.has(i)&&this.canAct(i))return i; } return -1; }
    legal(i=this.actor) {
      if(this.done || i!==this.actor || i<0) return null;
      const p=this.players[i], call=Math.max(0,this.currentBet-p.streetBet), max=p.streetBet+p.stack;
      const reopened=p.raiseAt===null || this.currentBet-p.raiseAt>=this.minRaise;
      const opponentCanAct=this.players.some((q,j)=>j!==i&&!q.folded&&!q.allin);
      const canRaise=reopened && opponentCanAct && max>this.currentBet;
      const minTo=this.currentBet<this.bigBlind?this.bigBlind:this.currentBet+this.minRaise;
      return {call:Math.min(call,p.stack),toCall:call,canCheck:call===0,canRaise,minTo,maxTo:max,allinOnly:canRaise&&max<minTo};
    }
    act(i,type,to) {
      const legal=this.legal(i); if(!legal)throw new Error('尚未轮到此玩家');
      const p=this.players[i]; let amount=0, text='';
      if(type==='fold') { p.folded=true; text='弃牌'; }
      else if(type==='call' || type==='check') { if(type==='check'&&!legal.canCheck)throw new Error('有下注时不能过牌'); amount=this.pay(i,legal.call); text=legal.toCall ? (p.allin?'全押跟注 ':'跟注 ')+amount : '过牌'; p.raiseAt=this.currentBet; }
      else if(type==='raise' || type==='allin') {
        if(type==='allin' && legal.maxTo<=this.currentBet) return this.act(i,'call');
        to=type==='allin'?legal.maxTo:to;
        if(!legal.canRaise || !Number.isInteger(to) || to>legal.maxTo || to<=this.currentBet || (to<legal.minTo&&to!==legal.maxTo))throw new Error('加注额度不合法');
        const opening=this.currentBet<this.bigBlind, increase=to-this.currentBet, full=opening?to>=this.bigBlind:increase>=this.minRaise;
        amount=this.pay(i,to-p.streetBet);
        this.currentBet=to;
        if(full)this.minRaise=opening?to:increase;
        this.players.forEach((q,j)=>{if(j!==i&&this.canAct(j)&&q.streetBet<this.currentBet)this.pending.add(j);});
        p.raiseAt=this.currentBet; text=(p.allin?'全押至 ':this.currentBet===increase?'下注至 ':'加注至 ')+to;
      } else throw new Error('未知操作');
      p.lastAction=text;
      this.events.push({type:'action',player:i,action:type,amount,to:p.streetBet,street:this.street,pot:this.pot,text});
      this.pending.delete(i); this.actor=this.findNext(i); this.progress();
      return this.events[this.events.length-1];
    }
    progress() {
      while(!this.done) {
        const live=this.players.filter(p=>!p.folded);
        if(live.length===1) { this.refundUncalled(); this.settle(false); return; }
        const actors=this.players.map((_,i)=>i).filter(i=>this.canAct(i));
        // With nobody to bet against, only a player facing a call has a decision.
        if(actors.length<=1) {
          this.currentBet=Math.max(...live.map(p=>p.streetBet));
          this.pending=new Set(actors.filter(i=>this.players[i].streetBet<this.currentBet));
        }
        this.pending=new Set([...this.pending].filter(i=>this.canAct(i)));
        if(this.pending.size) { if(!this.pending.has(this.actor))this.actor=this.findNext((this.button+this.players.length)%this.players.length); return; }
        this.refundUncalled();
        if(this.street===3) { this.settle(true); return; }
        this.street++; this.burned.push(this.deck.pop());
        for(let n=this.street===1?3:1;n>0;n--)this.board.push(this.deck.pop());
        this.players.forEach(p=>{p.streetBet=0;p.raiseAt=null;if(!p.folded)p.lastAction=p.allin?'全押':'待行动';});
        this.currentBet=0;this.minRaise=this.bigBlind;
        this.events.push({type:'street',street:this.street,text:['翻牌前','翻牌','转牌','河牌'][this.street]});
        this.pending=new Set(this.players.map((_,i)=>i).filter(i=>this.canAct(i)));
        this.actor=this.findNext(this.button);
      }
    }
    refundUncalled() {
      const sorted=this.players.map((p,i)=>({p,i})).sort((a,b)=>b.p.totalBet-a.p.totalBet);
      if(sorted[0].p.totalBet>sorted[1].p.totalBet) {
        const {p,i}=sorted[0], amount=p.totalBet-sorted[1].p.totalBet;
        p.totalBet-=amount;p.streetBet=Math.max(0,p.streetBet-amount);p.stack+=amount;p.allin=p.stack===0;
        this.events.push({type:'refund',player:i,amount,text:'退回未被跟注的 '+amount});
      }
    }
    settle(showdown) {
      this.showdown=showdown; this.done=true; this.actor=-1;
      const levels=[...new Set(this.players.map(p=>p.totalBet).filter(Boolean))].sort((a,b)=>a-b);
      let previous=0;
      const scores=this.players.map(p=>!p.folded&&showdown?evaluate([...p.hole,...this.board]):null);
      for(const level of levels) {
        const contributors=this.players.map((p,i)=>({p,i})).filter(x=>x.p.totalBet>=level);
        const amount=(level-previous)*contributors.length;previous=level;
        const eligible=contributors.filter(x=>!x.p.folded);
        if(!eligible.length)throw new Error('底池没有可获胜玩家');
        const best=showdown?Math.max(...eligible.map(x=>scores[x.i].score)):0;
        const winners=eligible.filter(x=>!showdown||scores[x.i].score===best).map(x=>x.i);
        // Odd chips go clockwise from the first seat left of the button.
        winners.sort((a,b)=>(a-this.button-1+this.players.length)%this.players.length-(b-this.button-1+this.players.length)%this.players.length);
        this.pots.push({amount,eligible:eligible.map(x=>x.i),winners});
        winners.forEach((i,j)=>{const won=Math.floor(amount/winners.length)+(j<amount%winners.length?1:0);this.players[i].stack+=won;this.payouts.push({player:i,amount:won,pot:this.pots.length-1,name:showdown?scores[i].name:'对手全部弃牌'});});
      }
      if(this.players.reduce((s,p)=>s+p.stack,0)!==this.bankroll)throw new Error('筹码守恒检查失败');
      this.events.push({type:'end',text:showdown?'摊牌结算':'本手结束'});
    }
  }
  return {Hand,evaluate,rank,suit,cardLabel,shuffled,rng,CATEGORIES};
});

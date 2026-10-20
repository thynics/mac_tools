(function(root,factory){
  if(typeof module==='object'&&module.exports)module.exports=factory(require('./engine.js'));
  else root.PokerAI=factory(root.Poker);
})(typeof globalThis!=='undefined'?globalThis:this,function(P){
  'use strict';
  const STYLES=[
    {tag:'均衡专家',icon:'◈',color:'#b5ccae',tight:.02,aggression:.58,bluff:.13},
    {tag:'位置猎手',icon:'⌁',color:'#d8bc8d',tight:.06,aggression:.71,bluff:.18},
    {tag:'价值大师',icon:'◇',color:'#b6bedb',tight:.1,aggression:.53,bluff:.07},
    {tag:'施压高手',icon:'✳',color:'#d2a99d',tight:-.03,aggression:.83,bluff:.22},
    {tag:'范围分析师',icon:'⊞',color:'#9abfc5',tight:.04,aggression:.64,bluff:.12},
    {tag:'短码专家',icon:'△',color:'#c9b0d0',tight:.01,aggression:.69,bluff:.11}
  ];
  function preflop(hole) {
    let [a,b]=hole.map(P.rank).sort((a,b)=>b-a);
    if(a===b)return .5+a*.031;
    const gap=a-b-1, suited=P.suit(hole[0])===P.suit(hole[1]);
    return Math.max(.23,Math.min(.85,.2+a*.024+b*.012+(suited?.055:0)-(gap>0?Math.min(.16,gap*.025):0)+(a===14?.035:0)));
  }
  function rangeStrength(hole) { return preflop(hole); }
  function equity(hand,index,iterations,random) {
    const me=hand.players[index], opponents=hand.players.filter((p,i)=>i!==index&&!p.folded);
    // Never inspect opponents' hole cards or the actual undealt deck.
    const known=new Set([...me.hole,...hand.board]);
    const pool=Array.from({length:52},(_,i)=>i).filter(c=>!known.has(c));
    let wins=0;
    for(let run=0;run<iterations;run++) {
      const deck=[...pool];let cursor=deck.length;
      const draw=()=>{const j=Math.floor(random()*cursor);const c=deck[j];deck[j]=deck[--cursor];return c;};
      const hands=[];
      for(const opponent of opponents) {
        let h=[draw(),draw()];
        // Rejection sampling conditions ranges on public betting, without peeking.
        const threshold=opponent.streetBet>=hand.bigBlind*3?.57:opponent.totalBet>hand.bigBlind*2?.46:.25;
        if(rangeStrength(h)<threshold && random()<.72) { deck[cursor++]=h[0];deck[cursor++]=h[1];h=[draw(),draw()]; }
        hands.push(h);
      }
      const board=[...hand.board];while(board.length<5)board.push(draw());
      const score=P.evaluate([...me.hole,...board]).score;
      let ties=1, lost=false;
      for(const h of hands){const s=P.evaluate([...h,...board]).score;if(s>score){lost=true;break;}if(s===score)ties++;}
      if(!lost)wins+=1/ties;
    }
    return wins/iterations;
  }
  function decide(hand,index,options={}) {
    const random=options.random||Math.random, p=hand.players[index], legal=hand.legal(index), style=STYLES[p.style%STYLES.length];
    if(!legal)throw new Error('AI 行动顺序错误');
    const active=hand.players.filter(q=>!q.folded).length;
    const position=((index-hand.button+hand.players.length)%hand.players.length)/hand.players.length;
    const late=index===hand.button || position>.72;
    const skill=hand.street===0?preflop(p.hole):equity(hand,index,options.iterations||180,random);
    const live=hand.players.filter(q=>!q.folded&&q.id!==p.id);
    // Equity can only win the matched portions of a side pot.
    const effectivePot=hand.players.reduce((s,q)=>s+Math.min(q.totalBet,p.totalBet+legal.call),0);
    const odds=legal.call/(effectivePot+legal.call||1);
    const bb=p.stack/hand.bigBlind;
    const observed=options.observed||{};
    const tendency=live.reduce((s,q)=>s+(observed[q.id]?.foldRate||.4),0)/Math.max(1,live.length);
    let fold=false;
    if(legal.toCall) {
      if(hand.street===0) {
        const pressure=legal.toCall/Math.max(hand.bigBlind,p.stack+legal.call);
        const threshold=.42+Math.min(.32,pressure*.65)+Math.max(0,active-2)*.021+style.tight-(late?.055:0);
        fold=skill<threshold && legal.toCall>hand.bigBlind*.5;
        if(bb<8 && skill>.64)fold=false;
      } else fold=skill<odds+style.tight*.35+(active>2?.018:0);
    }
    const base={equity:skill,odds,style:style.tag};
    if(fold)return {...base,type:'fold',reason:hand.street===0?'起手牌不足以继续面对当前范围':'估算胜率低于跟注所需的底池赔率'};
    const bluff=active<=3 && legal.canRaise && random()<style.bluff*(late?1.25:.65)*(tendency>.5?1.3:.75);
    const strong=hand.street===0?skill>.72+style.tight*.3:skill>Math.max(.55,1/active+.2);
    const shortPush=bb<11&&((hand.street===0&&skill>.65)||(hand.street>0&&skill>.62));
    if(legal.canRaise && (shortPush || ((strong||bluff)&&random()<style.aggression))) {
      let to;
      if(shortPush)to=legal.maxTo;
      else if(hand.street===0)to=Math.max(legal.minTo,hand.currentBet<=hand.bigBlind?Math.round(hand.bigBlind*(late?2.5:3)):Math.round(hand.currentBet*(late?2.6:3.1)));
      else to=hand.currentBet+Math.max(hand.minRaise,Math.round((hand.pot+legal.call)*(strong?.64:.48)));
      to=Math.min(legal.maxTo,to);
      if(to<legal.minTo&&to!==legal.maxTo)to=legal.maxTo;
      return {...base,type:to===legal.maxTo?'allin':'raise',to,reason:shortPush?'短筹码根据有效筹码深度施压':bluff&&!strong?'利用位置和对手弃牌倾向进行混合诈唬':'对继续范围下注取值，并保护牌力'};
    }
    return {...base,type:legal.canCheck?'check':'call',reason:legal.canCheck?'控制底池，保留范围中的中等牌力':'底池赔率允许继续，以跟注保留对手较弱范围'};
  }
  return {STYLES,decide,equity,preflop};
});

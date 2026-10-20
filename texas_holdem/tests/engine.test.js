'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const P=require('../web/engine.js');
const AI=require('../web/ai.js');
const c=(r,s=0)=>s*13+r-2;
const ps=stacks=>stacks.map((stack,id)=>({id,name:'p'+id,stack,style:id%6}));
const make=(stacks,extra={})=>new P.Hand(ps(stacks),{button:0,random:P.rng(42),...extra});
const checkDown=h=>{let limit=100;while(!h.done&&limit--)h.act(h.actor,h.legal().canCheck?'check':'call');assert.ok(h.done);};

test('all nine categories rank correctly, including ace-low straights',()=>{
  const hands=[
    [c(14),c(11,1),c(9,2),c(7,3),c(3)],
    [c(14),c(14,1),c(9,2),c(7,3),c(3)],
    [c(14),c(14,1),c(9,2),c(9,3),c(3)],
    [c(14),c(14,1),c(14,2),c(7,3),c(3)],
    [c(14),c(2,1),c(3,2),c(4,3),c(5)],
    [c(14),c(11),c(9),c(7),c(3)],
    [c(14),c(14,1),c(14,2),c(9,3),c(9)],
    [c(14),c(14,1),c(14,2),c(14,3),c(3)],
    [c(14),c(13),c(12),c(11),c(10)]
  ];
  hands.forEach((h,i)=>assert.equal(P.evaluate(h).category,i));
  for(let i=1;i<hands.length;i++)assert.ok(P.evaluate(hands[i]).score>P.evaluate(hands[i-1]).score);
  assert.equal(P.evaluate(hands[4]).kickers[0],5);
});
test('seven-card evaluator uses the best full house and third pair kicker',()=>{
  const full=P.evaluate([c(13),c(13,1),c(13,2),c(14),c(14,1),c(14,2),c(2)]);
  assert.deepEqual(full.kickers,[14,13]);
  const pairs=P.evaluate([c(14),c(14,1),c(13),c(13,1),c(12),c(12,1),c(2)]);
  assert.deepEqual(pairs.kickers,[14,13,12]);
});
test('best of seven matches exhaustive five-card subsets',()=>{
  const random=P.rng(978);
  for(let n=0;n<450;n++){
    const cards=P.shuffled(random).slice(0,7);let best=0;
    for(let a=0;a<7;a++)for(let b=a+1;b<7;b++)best=Math.max(best,P.evaluate(cards.filter((_,i)=>i!==a&&i!==b)).score);
    assert.equal(P.evaluate(cards).score,best);
  }
});
test('heads-up button posts small blind and acts first before the flop',()=>{
  const h=make([1000,1000]);assert.equal(h.sb,0);assert.equal(h.bb,1);assert.equal(h.actor,0);
  h.act(0,'call');h.act(1,'check');assert.equal(h.street,1);assert.equal(h.actor,1);
});
test('big blind retains option after every other player calls',()=>{
  const h=make([1000,1000,1000]);assert.equal(h.actor,0);h.act(0,'call');h.act(1,'call');assert.equal(h.actor,2);assert.equal(h.street,0);assert.equal(h.legal().canRaise,true);h.act(2,'check');assert.equal(h.street,1);
});
test('folding awards the pot and returns an uncalled raise',()=>{
  const h=make([1000,1000]);h.act(0,'raise',100);h.act(1,'fold');assert.equal(h.done,true);assert.equal(h.players[0].stack,1020);assert.equal(h.players[1].stack,980);assert.equal(h.pot,40);assert.ok(h.events.some(e=>e.type==='refund'&&e.amount===80));
});
test('illegal checks, raises, fractional chips and out-of-turn actions are rejected',()=>{
  const h=make([1000,1000,1000]);assert.throws(()=>h.act(1,'call'));assert.throws(()=>h.act(0,'check'));assert.throws(()=>h.act(0,'raise',30));assert.throws(()=>h.act(0,'raise',40.5));assert.throws(()=>h.act(0,'raise',1100));
});
test('short all-in does not reopen raising for a player who has acted',()=>{
  const h=make([1000,70,1000]);h.act(0,'raise',60);h.act(1,'allin');h.act(2,'call');assert.equal(h.actor,0);assert.equal(h.legal().call,10);assert.equal(h.legal().canRaise,false);assert.throws(()=>h.act(0,'raise',110));h.act(0,'call');assert.equal(h.street,1);
});
test('cumulative short all-ins can reopen a full raise',()=>{
  const h=make([1000,80,100,1000]);h.act(3,'raise',60);h.act(0,'call');h.act(1,'allin');h.act(2,'allin');assert.equal(h.actor,3);assert.equal(h.legal().canRaise,true);assert.equal(h.legal().minTo,140);
});
test('an incomplete opening all-in can be completed to one big blind',()=>{
  const h=make([1000,25,1000]);h.act(0,'call');h.act(1,'call');h.act(2,'check');assert.equal(h.actor,1);h.act(1,'allin');assert.equal(h.currentBet,5);assert.equal(h.legal().minTo,20);h.act(2,'raise',20);assert.equal(h.minRaise,20);assert.equal(h.legal().minTo,40);
});
test('a short all-in big blind cannot force an unopposed extra call',()=>{
  const h=make([1000,5]);assert.equal(h.done,true);assert.equal(h.players.reduce((s,p)=>s+p.stack,0),1005);assert.equal(h.pot,10);
});
test('an all-in player is dealt the full board without phantom turns',()=>{
  const h=make([1000,1000]);h.act(0,'allin');h.act(1,'call');assert.equal(h.done,true);assert.equal(h.showdown,true);assert.equal(h.board.length,5);assert.equal(h.burned.length,3);assert.equal(new Set([...h.board,...h.burned,...h.players.flatMap(p=>p.hole)]).size,12);
});
test('three all-ins produce correctly eligible main and side pots',()=>{
  const h=make([100,300,1000]);h.act(0,'allin');h.act(1,'allin');h.act(2,'call');assert.equal(h.done,true);assert.deepEqual(h.pots.map(p=>p.amount),[300,400]);assert.deepEqual(h.pots[1].eligible,[1,2]);assert.equal(h.players[2].totalBet,300);assert.equal(h.players.reduce((s,p)=>s+p.stack,0),1400);
});
test('folded contributions remain in side pots but cannot win',()=>{
  const h=make([100,300,1000]);h.act(0,'allin');h.act(1,'raise',200);h.act(2,'raise',400);h.act(1,'fold');assert.equal(h.done,true);assert.equal(h.players[1].stack,100);assert.ok(h.pots.every(p=>!p.winners.includes(1)));assert.equal(h.players.reduce((s,p)=>s+p.stack,0),1400);
});
test('a shared royal flush splits the pot and odd chips follow the button',()=>{
  const h=make([1000,1000,1000]);
  h.players.forEach((p,i)=>{p.stack=999;p.totalBet=1;p.streetBet=0;p.folded=i===0;p.allin=false;});
  h.board=[c(10),c(11),c(12),c(13),c(14)];h.players[1].hole=[c(2,1),c(3,2)];h.players[2].hole=[c(4,1),c(5,2)];
  h.settle(true);assert.equal(h.players[1].stack,1001);assert.equal(h.players[2].stack,1000);assert.equal(h.players[0].stack,999);
});
test('a player need not use either hole card',()=>{
  const h=make([1000,1000]);checkDown(h);h.players.forEach(p=>{p.stack=980;p.totalBet=20;});h.pots=[];h.payouts=[];h.board=[c(10),c(11),c(12),c(13),c(14)];h.settle(true);assert.equal(h.players[0].stack,1000);assert.equal(h.players[1].stack,1000);
});
test('AI cannot change a decision by looking at hidden hands or undealt cards',()=>{
  const a=make([1000,1000,1000]);a.act(0,'call');a.act(1,'call');a.act(2,'check');
  const index=a.actor,b=make([1000,1000,1000]);Object.assign(b,structuredClone({...a,random:undefined}));
  b.players.forEach((p,i)=>{if(i!==index)p.hole=[c(14,i),c(13,i)];});b.deck.reverse();
  const da=AI.decide(a,index,{random:P.rng(123),iterations:100}),db=AI.decide(b,index,{random:P.rng(123),iterations:100});assert.deepEqual(da,db);
});
test('seeded mixed-action fuzz preserves chips and terminates 2,000 hands',()=>{
  const random=P.rng(7247);
  for(let run=0;run<2000;run++){
    const n=2+Math.floor(random()*8),stacks=Array.from({length:n},()=>1+Math.floor(random()*2000));
    const h=make(stacks,{random,button:run%n});let actions=0;
    while(!h.done){assert.ok(++actions<500,'hand must finish');const l=h.legal();assert.ok(l);const r=random();if(r<.15)h.act(h.actor,'fold');else if(r<.42&&l.canRaise){const to=random()<.25?l.maxTo:Math.min(l.maxTo,l.minTo+Math.floor(random()*60));h.act(h.actor,'raise',to);}else h.act(h.actor,l.canCheck?'check':'call');assert.ok(h.players.every(p=>Number.isInteger(p.stack)&&p.stack>=0));}
    assert.equal(h.players.reduce((s,p)=>s+p.stack,0),stacks.reduce((a,b)=>a+b,0));
  }
});
test('all six NPC styles finish real betting hands with legal actions',()=>{
  const random=P.rng(423);
  for(let run=0;run<18;run++){
    const h=make([1000,1000,1000,1000,1000,1000],{random,button:run%6});let actions=0;
    while(!h.done){assert.ok(++actions<250);const d=AI.decide(h,h.actor,{random,iterations:60});h.act(h.actor,d.type,d.to);}
    assert.equal(h.players.reduce((s,p)=>s+p.stack,0),6000);
  }
});

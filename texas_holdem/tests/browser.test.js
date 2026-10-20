'use strict';
// NODE_PATH=/path/to/node_modules node tests/browser.test.js
const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const path=require('node:path');
const fs=require('node:fs');
const {pathToFileURL}=require('node:url');
const artifactDir=process.env.RIVER_ARTIFACT_DIR||path.join(__dirname,'../build/screenshots');
fs.mkdirSync(artifactDir,{recursive:true});
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
 try{
  const context=await browser.newContext({viewport:{width:1440,height:940},deviceScaleFactor:1});
  await context.addInitScript(()=>{let seed=82347;Math.random=()=>{seed+=0x6D2B79F5;let t=seed;t=Math.imul(t^t>>>15,t|1);t^=t+Math.imul(t^t>>>7,t|61);return ((t^t>>>14)>>>0)/4294967296;};});
  const page=await context.newPage(),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  const url=pathToFileURL(path.join(__dirname,'../web/index.html')).href;
  await page.goto(url);
  await page.screenshot({path:path.join(artifactDir,'lobby.png')});
  await page.locator('#player-count').fill('27');await page.locator('#start-button').click();
  await page.waitForFunction(()=>window.RiverClub?.hand);
  assert.equal(await page.evaluate(()=>RiverClub.tournament.players.length),27);
  assert.ok(await page.evaluate(()=>RiverClub.groups.every(g=>g.length>=2&&g.length<=9)));
  await page.locator('#speed').click();
  await page.waitForFunction(()=>RiverClub.hand.done||RiverClub.hand.players[RiverClub.hand.actor]?.id===0,{},{timeout:20000});
  await page.screenshot({path:path.join(artifactDir,'playing.png')});
  // Saving during a real player decision restores exact cards, contributions and actor.
  const before=await page.evaluate(()=>{RiverClub.save();return {cards:RiverClub.hand.players[0].hole,board:RiverClub.hand.board,pot:RiverClub.hand.pot,actor:RiverClub.hand.actor};});
  await page.reload();assert.ok(await page.locator('#resume-game').isVisible());await page.locator('#resume-game').click();
  const after=await page.evaluate(()=>({cards:RiverClub.hand.players[0].hole,board:RiverClub.hand.board,pot:RiverClub.hand.pot,actor:RiverClub.hand.actor}));assert.deepEqual(after,before);
  await page.locator('#nav-rules').click();assert.ok(await page.locator('#rules-layer').isVisible());await page.keyboard.press('Escape');assert.ok(await page.locator('#rules-layer').isHidden());
  // Accelerate animation timers only for a larger integration run.
  await page.evaluate(()=>{const real=window.setTimeout;window.setTimeout=(fn,ms,...args)=>real(fn,Math.min(ms,1),...args);});
  async function finishHand(){
   for(let steps=0;steps<400;steps++){
    const done=await page.evaluate(()=>{const r=RiverClub,h=r.hand;if(h.done)return !r.locked;if(!r.locked&&h.players[h.actor].id===0)r.act(h.legal().canCheck?'check':'call');return false;});
    if(done)return;await page.waitForTimeout(8);
   }
   throw new Error('hand did not settle');
  }
  await finishHand();assert.equal(await page.evaluate(()=>RiverClub.tournament.players.reduce((s,p)=>s+p.stack,0)),27000);
  await page.screenshot({path:path.join(artifactDir,'showdown.png')});
  // Table balancing and settlement scale beyond one deck or one table.
  await page.evaluate(()=>RiverClub.start(100));await finishHand();
  assert.equal(await page.evaluate(()=>RiverClub.tournament.players.reduce((s,p)=>s+p.stack,0)),100000);
  assert.equal(await page.evaluate(()=>RiverClub.groups.length),12);
  await page.evaluate(()=>RiverClub.start(2));
  for(let rounds=0;rounds<150;rounds++){
   await finishHand();
   if(await page.evaluate(()=>RiverClub.tournament.finished))break;
   await page.locator('#next-hand').click();
  }
  assert.equal(await page.evaluate(()=>RiverClub.tournament.finished),true);
  assert.equal(await page.evaluate(()=>RiverClub.tournament.players.reduce((s,p)=>s+p.stack,0)),2000);
  assert.match(await page.locator('#action-panel').innerText(),/筹码归零|本场冠军/);
  await page.screenshot({path:path.join(artifactDir,'game-over.png')});
  await page.setViewportSize({width:390,height:844});await page.locator('#new-game').click();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
  assert.equal(await page.locator('.setup-modal').evaluate(el=>{const r=el.getBoundingClientRect();return r.left>=0&&r.right<=window.innerWidth;}),true);
  await page.screenshot({path:path.join(artifactDir,'mobile.png')});
  assert.deepEqual(errors,[]);
  console.log('PASS: lobby, 27-player tables, exact save/resume, modal keyboard, 100-player settlement, complete heads-up tournament, mobile layout, zero browser errors');
  console.log('Screenshots: '+artifactDir);
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});

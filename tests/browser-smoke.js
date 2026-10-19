async page => {
 const context=await page.context().browser().newContext({viewport:{width:1280,height:800}});
 const p=await context.newPage();const errors=[];p.on('pageerror',e=>errors.push(e.message));p.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
 const assert=(v,m)=>{if(!v)throw new Error(m)};
 const read=()=>p.evaluate(()=>JSON.parse(new TextDecoder().decode(new Uint8Array(wasm_exports.memory.buffer,wasm_exports.rm_snapshot_ptr(),wasm_exports.rm_snapshot_len()))));
 const command=async c=>{const old=(await read()).revision;await p.evaluate(c=>send(c),c);await p.waitForFunction(old=>snapshot?.revision>old,old);return read();};
 await p.goto('http://127.0.0.1:8022');await p.waitForFunction(()=>document.querySelector('#round').textContent.includes('Round'));
 for(const [width,height] of [[320,568],[360,640],[390,844],[844,390],[1280,800]]){
  await p.setViewportSize({width,height});await p.waitForTimeout(50);
  assert(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`horizontal overflow ${width}`);
  assert(await p.locator('#glcanvas').isVisible(),'missing canvas');
 }
 await p.getByRole('button',{name:/Magician.*HP/}).click();await p.locator('#action').selectOption('Prepare');await p.locator('#spell').selectOption('ShockBoltI');await p.locator('#declare').click();
 await p.waitForFunction(()=>snapshot.save.draft.actions.length===1);
 assert((await read()).save.draft.actions[0].activity===90,'preparation cost');
 await command({type:'Commit'});await command({type:'Commit'});
 await p.waitForFunction(()=>snapshot.save.battle.resolving);
 let s=await read();assert(s.save.battle.round===1,'duplicate commit advanced round');assert(s.error.includes('not accepting'),'duplicate commit not guarded');
 await command({type:'Freeze'});await command({type:'Step'});s=await read();const before=JSON.stringify(s.save.battle);
 await p.reload();await p.waitForFunction(()=>snapshot?.save.battle.resolving&&snapshot.paused);
 assert(JSON.stringify((await read()).save.battle)===before,'reload rerolled or reapplied action');
 for(let n=0;n<30&&(await read()).save.battle.resolving;n++)await command({type:'Step'});
 s=await read();assert(s.save.battle.round===2,'round did not finish');
 const live=JSON.stringify(s.save.battle);await command({type:'Replay',index:0});assert(JSON.stringify((await read()).save.battle)===live,'replay changed live battle');await command({type:'Replay',index:null});
 await p.evaluate(()=>{window.realSetItem=Storage.prototype.setItem;Storage.prototype.setItem=()=>{throw new Error('Simulated quota');};});await command({type:'Select',id:2});
 assert((await p.locator('#storage-status').textContent()).includes('Autosave failed'),'save error not surfaced');await p.evaluate(()=>Storage.prototype.setItem=window.realSetItem);
 for(let scenario=0;scenario<3;scenario++){
  await command({type:'Restart',scenario,seed:2026});assert((await read()).save.scenario===scenario,'scenario selection');
  // Drive valid declarations through the same UI bridge, without modifying combat state or dice.
  const result=await p.evaluate(async()=>{
   const read=()=>JSON.parse(new TextDecoder().decode(new Uint8Array(wasm_exports.memory.buffer,wasm_exports.rm_snapshot_ptr(),wasm_exports.rm_snapshot_len())));
   const wait=()=>new Promise(r=>requestAnimationFrame(r));
   const c=async value=>{const old=read().revision;send(value);while(read().revision===old)await wait();return read();};
   const dist=(a,b)=>(Math.abs(a.q-b.q)+Math.abs(a.r-b.r)+Math.abs(a.q+a.r-b.q-b.r))/2;
   const key=p=>`${p.q},${p.r}`;
   for(let round=0;round<110;round++){
    let b=read().save.battle;if(b.finished)return {round:b.round,winner:b.winner};
    const active=f=>!f.dead&&!f.disabling&&f.damage<f.max_hits;
    for(const f of b.fighters.filter(f=>f.team===0&&active(f)&&!f.conditions.some(c=>c.starts<=b.round&&['stun','stunNoParry','downOrOut','mustParry'].includes(c.effect.kind)))){
     const target=b.fighters.filter(t=>t.team===1&&active(t)).sort((a,z)=>dist(f.pos,a.pos)-dist(f.pos,z.pos)||a.id-z.id)[0];if(!target)continue;
     await c({type:'Select',id:f.id});await c({type:'Target',id:target.id});
     let kind='Melee',phase='Normal',activity=100,spell=null;
     if(f.conditions.some(c=>c.starts<=b.round&&c.effect.kind==='prone')){kind='StandUp';activity=50;}
     else if(f.weapon_recovery?.[f.weapon]){kind='RecoverWeapon';activity=100;}
     else if(f.conditions.some(c=>c.starts<=b.round&&c.effect.kind==='noAttack')){kind='Wait';activity=0;}
     else if(f.spells.includes('ShockBoltI')&&f.pp>=2){spell='ShockBoltI';kind=f.preparation?.spell===spell?'Cast':'Prepare';activity=kind==='Cast'?75:90;}
     else if(dist(f.pos,target.pos)>1){
      const walls=new Set(b.walls.map(key));const occupied=new Set(b.fighters.filter(t=>t.id!==f.id&&active(t)).map(t=>key(t.pos)));
      const seen=new Set([key(f.pos)]),queue=[{pos:f.pos,path:[]}];let route=[];
      while(queue.length){const n=queue.shift();if(dist(n.pos,target.pos)===1){route=n.path;break;}for(const [q,r] of [[1,0],[1,-1],[0,-1],[-1,0],[-1,1],[0,1]]){const p={q:n.pos.q+q,r:n.pos.r+r},k=key(p);if(dist(p,{q:0,r:0})>b.radius||seen.has(k)||walls.has(k)||occupied.has(k))continue;seen.add(k);queue.push({pos:p,path:[...n.path,p]});}}
      if(!route.length)continue;const to=route[Math.min(route.length,8)-1];await c({type:'Destination',...to});kind='Move';phase='Deliberate';activity=80;
     }
     const state=await c({type:'Declare',kind,phase,activity,spell,parry:0});if(state.error)throw new Error(state.error);
    }
    await c({type:'Commit'});await c({type:'Freeze'});
    for(let tick=0;tick<50&&read().save.battle.resolving;tick++)await c({type:'Step'});
   }
   throw new Error('battle exceeded 110 rounds');
  });
  assert(result.round>1,`scenario ${scenario} never fought`);
 }
 await command({type:'Restart',scenario:1,seed:2026});
 await p.setViewportSize({width:1280,height:800});await p.screenshot({path:'output/playwright/desktop.png'});
 await p.setViewportSize({width:360,height:640});await p.screenshot({path:'output/playwright/mobile.png'});
 const other=await context.newPage();await other.goto('http://127.0.0.1:8022');await other.waitForFunction(()=>snapshot?.save?.battle);
 await other.evaluate(()=>send({type:'Select',id:3}));await p.waitForFunction(()=>document.querySelector('#storage-status').textContent.includes('Another tab'));
 assert(await p.locator('#commit').isDisabled(),'stale tab can commit');
 assert(errors.length===0,errors.join('\n'));await context.close();return {passed:true,scenarios:3,viewports:5,checks:'declarations, duplicate commit, mid-round reload, replay, failed save, stale tab, complete battles'};
}

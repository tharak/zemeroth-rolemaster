async page => {
 const base=page.url();
 const context=await page.context().browser().newContext({viewport:{width:1280,height:800},hasTouch:true,reducedMotion:'reduce'});
 const p=await context.newPage(),errors=[];p.on('pageerror',e=>errors.push(e.message));
 const assert=(v,m)=>{if(!v)throw new Error(m)};
 const read=()=>p.evaluate(()=>JSON.parse(new TextDecoder().decode(new Uint8Array(wasm_exports.memory.buffer,wasm_exports.rm_snapshot_ptr(),wasm_exports.rm_snapshot_len()))));
 const command=async c=>{const old=(await read()).revision;await p.evaluate(c=>send(c),c);await p.waitForFunction(old=>snapshot?.revision>old,old);return read();};
 await p.goto(base);await p.waitForFunction(()=>typeof snapshot!=='undefined'&&snapshot?.save?.battle?.turns);
 await command({type:'Freeze'});
 for(const [width,height] of [[320,568],[360,640],[390,844],[844,390],[1280,800]]){
  await p.setViewportSize({width,height});await p.waitForTimeout(50);
  assert(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`horizontal overflow ${width}`);
  assert(await p.locator('#glcanvas').isVisible(),'missing canvas');
  assert(await p.locator('#phase,#activity,#parry,#declare,#commit,#pick-select,#pick-move,#pick-target,#move-confirm,#execute').count()===0,'legacy selection or declaration control');
 }
 // Advance enemies / skips to a player turn, using the real playback bridge.
 for(let n=0;n<40;n++){const b=(await read()).save.battle;if(!b.resolving&&b.fighters.find(f=>f.id===b.turns.active).team===0)break;await command({type:'Step'});}
 let s=await read(),b=s.save.battle,actor=b.turns.active,f=b.fighters.find(f=>f.id===actor);
 await command({type:'Select',id:actor});
 const neighbors=[[1,0],[1,-1],[0,-1],[-1,0],[-1,1],[0,1]].map(([q,r])=>({q:f.pos.q+q,r:f.pos.r+r}));
 const to=neighbors.find(p=>(Math.abs(p.q)+Math.abs(p.r)+Math.abs(p.q+p.r))/2<=b.radius&&!b.walls.some(w=>w.q===p.q&&w.r===p.r)&&!b.fighters.some(f=>f.pos.q===p.q&&f.pos.r===p.r));
 assert(to,'no movement test destination');
 const point=async pos=>{const box=await p.locator('#glcanvas').boundingBox(),size=Math.max(10,Math.min(box.width/18,box.height/13));return {x:box.x+box.width/2+size*1.73205*(pos.q+pos.r/2),y:box.y+box.height/2+size*1.5*pos.r*.8125};};
 assert(s.interaction.reachable.some(p=>p.q===to.q&&p.r===to.r),'adjacent hex not highlighted');let pt=await point(to);await p.touchscreen.tap(pt.x,pt.y);
 await p.waitForFunction(to=>snapshot.save.destination?.q===to.q&&snapshot.save.destination?.r===to.r,to);
 assert((await read()).save.battle.fighters.find(f=>f.id===actor).pos.q===f.pos.q,'preview moved actor');
 const token=(await read()).save.battle.turns.sequence;
 await p.touchscreen.tap(pt.x,pt.y);await p.waitForFunction(token=>snapshot.save.battle.turns.sequence>token,token);
 await command({type:'Freeze'});s=await read();assert(s.save.battle.turns.movement_remaining===20,'movement budget');
 const afterMove=JSON.stringify(s.save.battle);
 await command({type:'Turn',actor,sequence:token,kind:'Move'});assert(JSON.stringify((await read()).save.battle)===afterMove,'duplicate move changed state');
 await command({type:'Step'});
 // Exact reload between movement and the main action.
 s=await read();const saved=JSON.stringify(s.save);
 await p.reload();await p.waitForFunction(()=>typeof snapshot!=='undefined'&&snapshot?.paused);
 assert(JSON.stringify((await read()).save)===saved,'reload changed turn, RNG or history');
 // An unreachable enemy cannot execute or change the active fighter.
 b=(await read()).save.battle;const enemy=b.fighters.find(f=>f.team===1);
 const beforeInvalid=JSON.stringify(b);pt=await point(enemy.pos);await p.touchscreen.tap(pt.x,pt.y);
 await p.waitForTimeout(100);
 assert((await read()).save.selected===actor,'targeting changed actor');
 assert(JSON.stringify((await read()).save.battle)===beforeInvalid,'invalid target changed battle');
 // Reserve persists through playback, and duplicate action consumes no dice.
 const sequence=(await read()).save.battle.turns.sequence;
 await p.getByRole('button',{name:'Parry',exact:true}).click();await p.waitForFunction(sequence=>snapshot.save.battle.turns.sequence>sequence,sequence);
 await command({type:'Freeze'});const parried=JSON.stringify((await read()).save.battle);
 await command({type:'Turn',actor,sequence,kind:'Parry'});assert(JSON.stringify((await read()).save.battle)===parried,'duplicate parry mutated battle');
 assert((await read()).save.battle.turns.reserves[actor]>0,'reserve missing');
 const live=JSON.stringify((await read()).save.battle);await command({type:'Replay',index:0});await command({type:'Step'});
 assert(JSON.stringify((await read()).save.battle)===live,'replay changed live battle');await command({type:'Replay',index:null});
 await p.evaluate(()=>{window.realSetItem=Storage.prototype.setItem;Storage.prototype.setItem=()=>{throw new Error('Simulated quota');};});await command({type:'Select',id:2});
 assert((await p.locator('#storage-status').textContent()).includes('Autosave failed'),'save failure hidden');await p.evaluate(()=>Storage.prototype.setItem=window.realSetItem);
 // Preserve old declarations, without reinterpreting them as a new battle.
 await p.evaluate(()=>localStorage.setItem('zemeroth-rolemaster.skirmish.v1','legacy-declarations'));
 await p.reload();await p.waitForFunction(()=>typeof snapshot!=='undefined'&&snapshot?.save?.battle?.turns);
 assert((await p.locator('#storage-status').textContent()).includes('preserved'),'legacy warning absent');
 assert(await p.evaluate(()=>localStorage.getItem('zemeroth-rolemaster.skirmish.v1'))==='legacy-declarations','legacy save changed');
 for(let scenario=0;scenario<3;scenario++){
  await command({type:'Restart',scenario,seed:2026});await command({type:'Freeze'});
  const result=await p.evaluate(async()=>{
   const read=()=>JSON.parse(new TextDecoder().decode(new Uint8Array(wasm_exports.memory.buffer,wasm_exports.rm_snapshot_ptr(),wasm_exports.rm_snapshot_len())));
   const wait=()=>new Promise(r=>requestAnimationFrame(r));
   const c=async value=>{const old=read().revision;send(value);while(read().revision===old)await wait();return read();};
   const dist=(a,b)=>(Math.abs(a.q-b.q)+Math.abs(a.r-b.r)+Math.abs(a.q+a.r-b.q-b.r))/2,key=p=>`${p.q},${p.r}`;
   for(let tick=0;tick<3500;tick++){
    let b=read().save.battle;if(b.finished)return {round:b.round,winner:b.winner};
    const turn=b.turns,f=b.fighters.find(f=>f.id===turn.active),active=f=>!f.dead&&!f.disabling&&f.damage<f.max_hits;
    if(b.resolving||f.team===1){await c({type:'Step'});continue;}
    const target=b.fighters.filter(t=>t.team!==f.team&&active(t)).sort((a,z)=>dist(f.pos,a.pos)-dist(f.pos,z.pos)||a.id-z.id)[0];
    await c({type:'Select',id:f.id});
    let kind='Attack',spell=null;const has=k=>f.conditions.some(c=>c.starts<=b.round&&c.effect.kind===k),w=f.weapons[f.weapon];
    if(!target)kind='Wait';
    else if(has('prone'))kind='StandUp';
    else if(f.weapon_recovery?.[f.weapon])kind='RecoverWeapon';
    else if(f.broken_weapons?.includes(f.weapon))kind=f.weapons.some((w,i)=>!f.broken_weapons.includes(i))?'ChangeWeapon':'Wait';
    else if(has('mustParry')||has('noAttack'))kind=w.reload===0&&!has('noParry')?'Parry':'Wait';
    else if(w.reload&&f.reload_left)kind='Reload';
    else if(f.spells.includes('ShockBoltI')&&f.pp>=2&&dist(f.pos,target.pos)*5<=100){kind='Cast';spell='ShockBoltI';}
    else if(dist(f.pos,target.pos)*5>w.range){
     kind='Wait';
     if(turn.movement_remaining>=5){
      const walls=new Set(b.walls.map(key)),occupied=new Set(b.fighters.filter(t=>t.id!==f.id&&active(t)).map(t=>key(t.pos)));
      const seen=new Set([key(f.pos)]),queue=[{pos:f.pos,path:[]}];let route=[];
      while(queue.length){const n=queue.shift();if(dist(n.pos,target.pos)===1){route=n.path;break;}for(const [q,r] of [[1,0],[1,-1],[0,-1],[-1,0],[-1,1],[0,1]]){const p={q:n.pos.q+q,r:n.pos.r+r},k=key(p);if(dist(p,{q:0,r:0})>b.radius||seen.has(k)||walls.has(k)||occupied.has(k))continue;seen.add(k);queue.push({pos:p,path:[...n.path,p]});}}
      if(route.length){await c({type:'Destination',...route[Math.min(route.length,Math.floor(turn.movement_remaining/5))-1]});kind='Move';}
     }
    }
    if(target&&['Attack','Cast'].includes(kind)){await c({type:'ChooseAction',kind,spell});await c({type:'Target',id:target.id});}
    const result=await c({type:'Turn',actor:f.id,sequence:turn.sequence,kind,spell});if(result.error)throw new Error(result.error);
    await c({type:'Freeze'});
   }
   throw new Error('battle exceeded 3500 transitions');
  });
  assert(result.round>1,`scenario ${scenario} never fought`);
 }
 await command({type:'Restart',scenario:1,seed:2026});await command({type:'Freeze'});
 await p.setViewportSize({width:1280,height:800});await p.screenshot({path:'output/playwright/desktop.png'});
 await p.setViewportSize({width:360,height:640});await p.screenshot({path:'output/playwright/mobile.png'});
 const other=await context.newPage();await other.goto(base);await other.waitForFunction(()=>typeof snapshot!=='undefined'&&snapshot?.save?.battle);
 await other.evaluate(()=>send({type:'Select',id:3}));await p.waitForFunction(()=>document.querySelector('#storage-status').textContent.includes('Another tab'));
 assert(await p.locator('[data-action=Attack]').isDisabled(),'stale tab can act');
 assert(errors.length===0,errors.join('\n'));await context.close();return {passed:true,scenarios:3,viewports:5,checks:'tap movement, targeting, duplicate commands, exact mid-turn reload, replay, parry, failed save, legacy saves, stale tabs, complete battles'};
}

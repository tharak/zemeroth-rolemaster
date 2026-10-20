async page => {
 const context=await page.context().browser().newContext({viewport:{width:1280,height:800},hasTouch:true,reducedMotion:'reduce'});
 const p=await context.newPage();const errors=[];p.on('pageerror',e=>errors.push(e.message));
 const assert=(v,m)=>{if(!v)throw Error(m)};
 await p.goto(page.url());await p.waitForFunction(()=>typeof snapshot!=='undefined'&&snapshot?.interaction);
 const read=()=>p.evaluate(()=>JSON.parse(new TextDecoder().decode(new Uint8Array(wasm_exports.memory.buffer,wasm_exports.rm_snapshot_ptr(),wasm_exports.rm_snapshot_len()))));
 const command=async c=>{const rev=(await read()).revision;await p.evaluate(c=>send(c),c);await p.waitForFunction(rev=>snapshot.revision>rev,rev);return read()};
 await command({type:'Freeze'});
 const seed=structuredClone((await read()).save),b=seed.battle;
 const actor=b.fighters.find(f=>f.id===1),ally=b.fighters.find(f=>f.id===2),enemy=b.fighters.find(f=>f.id===11);
 actor.pos={q:0,r:0};ally.pos={q:0,r:1};enemy.pos={q:1,r:0};actor.spells=['HealingI','Blur','ShockBoltI'];actor.max_pp=20;actor.pp=20;
 b.turns.active=actor.id;b.turns.position=b.turns.order.indexOf(actor.id);b.turns.main_available=true;b.turns.movement_remaining=25;b.resolving=false;seed.selected=actor.id;
 const reset=async()=>{const s=await command({type:'Restore',save:seed});assert(!s.error,s.error);return s;};
 const point=async pos=>{const box=await p.locator('#glcanvas').boundingBox(),size=Math.max(10,Math.min(box.width/18,box.height/13));return {x:box.x+box.width/2+size*1.73205*(pos.q+pos.r/2),y:box.y+box.height/2+size*1.5*pos.r*.8125};};
 const click=async(pos,touch=false)=>{const rev=(await read()).revision,pt=await point(pos);if(touch)await p.touchscreen.tap(pt.x,pt.y);else await p.mouse.click(pt.x,pt.y);await p.waitForFunction(rev=>snapshot.revision>rev,rev);return read();};
 let s=await reset();const before=JSON.stringify(s.save.battle);
 s=await click(enemy.pos);assert(s.interaction.preview?.kind==='Target','enemy did not preview');assert(s.save.selected===actor.id,'enemy replaced actor');assert(JSON.stringify(s.save.battle)===before,'preview consumed combat state');
 // Multiple copies of the same confirmation can only execute once.
 const pt=await point(enemy.pos),box=await p.locator('#glcanvas').boundingBox();
 await p.evaluate(c=>{send(c);send(c);send(c);},{type:'BoardClick',revision:s.revision,x:(pt.x-box.x)/box.width,y:(pt.y-box.y)/box.height});
 await p.waitForFunction(seq=>snapshot.save.battle.turns.sequence>seq,s.save.battle.turns.sequence);
 await command({type:'Freeze'});s=await read();assert(s.save.battle.turns.sequence===b.turns.sequence+1,'repeated confirmation executed more than once');assert(!s.save.battle.turns.main_available,'attack did not consume action');
 await reset();await click(ally.pos);assert((await read()).save.selected===ally.id,'ally not inspectable');await click(actor.pos);assert((await read()).interaction.reachable.length>0,'active click lacks reachable hexes');
 await p.getByRole('button',{name:'Cast',exact:true}).click();await p.waitForFunction(()=>snapshot.interaction.action==='Cast');
 s=await click(ally.pos,true);assert(s.save.selected===actor.id&&s.interaction.preview?.id===ally.id,'friendly spell did not target ally');
 const pp=s.save.battle.fighters.find(f=>f.id===actor.id).pp;s=await click(ally.pos,true);await command({type:'Freeze'});assert(s.save.battle.fighters.find(f=>f.id===actor.id).pp<pp,'second tap did not cast');
 await reset();await p.getByRole('button',{name:'Cast',exact:true}).click();await p.waitForFunction(()=>snapshot.interaction.action==='Cast');await p.locator('#spell').selectOption('Blur');await p.waitForFunction(()=>snapshot.interaction.spell==='Blur');
 assert((await read()).interaction.targets.join(',')===String(actor.id),'Blur did not restrict target to self');await click(actor.pos);s=await click(actor.pos);await command({type:'Freeze'});assert(!s.save.battle.turns.main_available,'self cast did not end action');
 s=await reset();const to=s.interaction.reachable[0];await click(to);await p.keyboard.press('Escape');await p.waitForFunction(()=>snapshot.interaction.preview===null);
 await click(to);await p.reload();await p.waitForFunction(()=>typeof snapshot!=='undefined'&&snapshot?.paused);assert((await read()).interaction.preview===null,'reload armed old preview');await click(to);assert((await read()).save.battle.turns.movement_remaining===25,'first click after reload moved');
 await p.keyboard.press('Escape');await p.waitForFunction(()=>snapshot.interaction.preview===null);
 await p.locator('#keyboard-controls summary').click();await p.locator('#destination').selectOption(`${to.q},${to.r}`);await p.waitForFunction(()=>snapshot.interaction.preview?.kind==='Move');await p.locator('#destination').press('Enter');await p.waitForFunction(()=>snapshot.save.battle.turns.movement_remaining<25);await command({type:'Freeze'});
 await reset();await p.locator('#keyboard-controls summary').click();await p.setViewportSize({width:1280,height:800});await p.screenshot({path:'output/playwright/direct-desktop.png'});await p.setViewportSize({width:360,height:640});await p.screenshot({path:'output/playwright/direct-mobile.png'});
 assert(errors.length===0,errors.join('\n'));await context.close();return {passed:true,checks:'mouse targeting, repeated confirmations, ally inspection, touch healing, self casting, Escape, disarmed reload, keyboard movement'};
}

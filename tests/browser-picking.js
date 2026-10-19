async page => {
 for(const mobile of [false,true]){
  const context=await page.context().browser().newContext({viewport:mobile?{width:360,height:640}:{width:1280,height:800},isMobile:mobile,hasTouch:mobile,deviceScaleFactor:mobile?2:1});
  const p=await context.newPage();await p.goto('http://127.0.0.1:8022');await p.waitForFunction(()=>snapshot?.save.battle);
  const pick=async(q,r,body=false)=>{
   const box=await p.locator('canvas').boundingBox(),size=Math.max(10,Math.min(box.width/18,box.height/13));
   const position={x:box.width/2+size*1.73205*(q+r/2),y:box.height/2+size*1.5*r*.8125-(body?size*.9:0)};
   if(mobile)await p.locator('canvas').tap({position});else await p.locator('canvas').click({position});
  };
  await pick(0,0);await p.waitForFunction(()=>snapshot.save.destination?.q===0&&snapshot.save.destination?.r===0);
  if(await p.locator('#action').inputValue()!=='Move')throw new Error('Hex click did not select Move');
  if(await p.locator('#destination-label').getAttribute('open')!==null)throw new Error('Coordinate menu should stay collapsed');
  await p.locator('#declare').click();
  await p.waitForFunction(()=>snapshot.save.draft.actions.some(a=>a.action.Move?.path.at(-1)?.q===0&&a.action.Move.path.at(-1).r===0));
  await p.locator('#clear').click();
  await p.locator('#pick-target').click();
  const enemy=await p.evaluate(()=>snapshot.save.battle.fighters.find(f=>f.id===12).pos);
  await pick(enemy.q,enemy.r,true);await p.waitForFunction(()=>snapshot.save.target===12);
  if(await p.evaluate(()=>snapshot.save.selected)!==1)throw new Error('Enemy click changed actor');
  await p.locator('#pick-select').click();
  const cleric=await p.evaluate(()=>snapshot.save.battle.fighters.find(f=>f.id===2).pos);
  await pick(cleric.q,cleric.r,true);await p.waitForFunction(()=>snapshot.save.selected===2);
  await p.locator('#action').selectOption('Cast');await p.locator('#spell').selectOption('HealingI');
  const ally=await p.evaluate(()=>snapshot.save.battle.fighters.find(f=>f.id===1).pos);
  await pick(ally.q,ally.r,true);await p.waitForFunction(()=>snapshot.save.target===1);
  if(await p.evaluate(()=>snapshot.save.selected)!==2)throw new Error('Friendly targeting changed caster');
  if(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw new Error('Horizontal overflow');
  await p.screenshot({path:mobile?'output/playwright/mobile-picking.png':'output/playwright/desktop-picking.png'});
  await context.close();
 }
 return {passed:true,checks:'desktop mouse, mobile touch DPR2, destination without coordinates, sprite targeting, friendly healing target'};
}

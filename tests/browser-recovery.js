async page => {
 const context=await page.context().browser().newContext({viewport:{width:360,height:640}});
 const p=await context.newPage();
 await p.goto('http://127.0.0.1:8022');await p.waitForFunction(()=>snapshot?.save.battle);
 const command=async value=>{
  const old=await p.evaluate(()=>snapshot.revision);
  await p.evaluate(value=>send(value),value);
  await p.waitForFunction(old=>snapshot.revision>old,old);
 };
 // Restore a valid saved fumble outcome, then exercise the public controls.
 const save=await p.evaluate(()=>structuredClone(snapshot.save));
 save.battle.fighters[0].weapon_recovery={'0':2};
 await command({type:'Restore',save});
 await p.locator('#action').selectOption('RecoverWeapon');
 await p.locator('#declare').click();
 await p.waitForFunction(()=>snapshot.save.draft.actions.some(a=>a.action==='RecoverWeapon'));
 if(await p.locator('#activity').inputValue()!=='100')throw new Error('Recovery must use 100% activity');
 await command({type:'Commit'});await command({type:'Freeze'});
 for(let i=0;i<30&&await p.evaluate(()=>snapshot.save.battle.resolving);i++)await command({type:'Step'});
 const left=await p.evaluate(()=>snapshot.save.battle.fighters[0].weapon_recovery[0]);
 if(left!==1)throw new Error('Recovery did not consume exactly one round');
 await p.reload();await p.waitForFunction(()=>snapshot?.save.battle);
 if(await p.evaluate(()=>snapshot.save.battle.fighters[0].weapon_recovery[0])!==1)throw new Error('Recovery progress lost on reload');
 if(!await p.locator('#stats').textContent().then(t=>t.includes('Recovery: 1 rounds')))throw new Error('Missing recovery status');
 await context.close();return {passed:true,checks:'recovery control, activity cost, progress, reload persistence'};
}

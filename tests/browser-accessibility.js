async page => {
 const context=await page.context().browser().newContext({viewport:{width:360,height:640},isMobile:true,hasTouch:true,deviceScaleFactor:2});
 const p=await context.newPage();
 await p.goto('http://127.0.0.1:8022');await p.waitForFunction(()=>snapshot?.save.battle);
 const box=await p.locator('canvas').boundingBox();await p.locator('canvas').tap({position:{x:box.width/2,y:box.height/2}});
 await p.waitForFunction(()=>snapshot.save.destination?.q===0&&snapshot.save.destination?.r===0);
 await p.locator('#action').selectOption('Move');await p.locator('#destination-label summary').click();await p.locator('#destination').selectOption('-1,0');await p.waitForFunction(()=>snapshot.save.destination?.q===-1);
 await p.locator('#action').selectOption('React');await p.locator('#declare').click();await p.locator('#commit').click();
 await p.waitForFunction(()=>snapshot.save.battle.awaiting_react===1);
 if(!await p.locator('#react-target-select').isVisible())throw new Error('React target inaccessible');
 await p.locator('#react-target-select').selectOption('11');await p.locator('#react-target').click();await p.waitForFunction(()=>!snapshot.save.battle.awaiting_react);
 await p.addStyleTag({content:'aside button,aside input,aside select,aside summary{font-size:24px}'});
 if(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw new Error('Enlarged text causes horizontal overflow');
 await p.locator('#pause').scrollIntoViewIfNeeded();
 await context.close();return {passed:true,checks:'mobile touch, keyboard destination selector, paused React selection, enlarged text'};
}

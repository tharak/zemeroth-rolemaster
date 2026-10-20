/* Selection/persistence only: the Rust core authorizes movement, actions and dice. */
'use strict';
const $=id=>document.getElementById(id);
const storageKey='zemeroth-rolemaster.skirmish.v2';
const legacyKey='zemeroth-rolemaster.skirmish.v1';
const tabId=crypto.randomUUID();
let snapshot=null,lastRevision=-1,restored=false,stale=false,lastSerialized='',selected=null;
const labels={HealingI:'Healing I',HealingIII:'Healing III',BlessI:'Bless I',Blur:'Blur',ShockBoltI:'Shock Bolt I',JoltsI:'Jolts I',MinorPain:'Minor Pain'};
function send(command){
 if(stale){$('storage-status').textContent='Another tab updated this battle. Reload this tab before continuing.';return;}
 if(typeof wasm_exports==='undefined'||!wasm_exports.rm_alloc)return;
 const bytes=new TextEncoder().encode(JSON.stringify(command)),ptr=wasm_exports.rm_alloc(bytes.length);
 if(!ptr){$('error').hidden=false;$('error').textContent='Command exceeds the supported save size.';return;}
 new Uint8Array(wasm_exports.memory.buffer,ptr,bytes.length).set(bytes);wasm_exports.rm_command(ptr,bytes.length);
}
function element(tag,text,cls){const el=document.createElement(tag);if(text!==undefined)el.textContent=text;if(cls)el.className=cls;return el;}
let action='Attack',inputPending=false;
function interact(command){if(inputPending||stale||!snapshot)return;inputPending=true;send(command);}
function act(kind){
 if(inputPending||!snapshot||snapshot.replay!==null)return;
 const b=snapshot.save.battle,t=b.turns;
 inputPending=true;
 send({type:'Turn',actor:t.active,sequence:t.sequence,kind,spell:$('spell').value||null});
 document.querySelectorAll('#actions button').forEach(el=>el.disabled=true);
}
function chooseAction(kind){interact({type:'ChooseAction',kind,spell:kind==='Cast'?($('spell').value||null):null});}
for(const button of document.querySelectorAll('[data-action]'))button.onclick=()=>['Attack','Cast'].includes(button.dataset.action)?chooseAction(button.dataset.action):act(button.dataset.action);
$('spell').onchange=()=>chooseAction('Cast');
let pointerStart=null;
$('glcanvas').addEventListener('pointerdown',e=>{if(e.isPrimary&&e.button===0)pointerStart={x:e.clientX,y:e.clientY};});
$('glcanvas').addEventListener('pointercancel',()=>pointerStart=null);
$('glcanvas').addEventListener('pointerup',e=>{
 if(!e.isPrimary||!pointerStart)return;const start=pointerStart;pointerStart=null;
 if(Math.hypot(e.clientX-start.x,e.clientY-start.y)>12)return;
 const rect=$('glcanvas').getBoundingClientRect();interact({type:'BoardClick',x:(e.clientX-rect.left)/rect.width,y:(e.clientY-rect.top)/rect.height,revision:snapshot?.revision});
});
$('menu-button').onclick=()=>{const open=$('setup').hidden;$('setup').hidden=!open;$('menu-button').setAttribute('aria-expanded',String(open));if(open)$('scenario').focus();};
$('restart').onclick=()=>{const seed=Number($('seed').value);if(!Number.isSafeInteger(seed)||seed<1||seed>4294967295){$('error').hidden=false;$('error').textContent='Seed must be an integer between 1 and 4294967295.';return;}send({type:'Restart',scenario:Number($('scenario').value),seed});$('setup').hidden=true;$('menu-button').setAttribute('aria-expanded','false');};
$('destination').onchange=()=>{if($('destination').value){const [q,r]=$('destination').value.split(',').map(Number);interact({type:'Destination',q,r});}};
$('target').onchange=()=>{if($('target').value)interact({type:'Target',id:Number($('target').value)});};
$('keyboard-fighter').onchange=()=>interact({type:'Select',id:Number($('keyboard-fighter').value)});
document.addEventListener('keydown',e=>{if(e.key==='Escape'){e.preventDefault();interact({type:'Cancel'});}else if(e.key==='Enter'&&(e.target===$('glcanvas')||e.target.closest('#keyboard-controls'))){e.preventDefault();interact({type:'Confirm'});}});
$('pause').onclick=()=>send({type:'Pause'});$('step').onclick=()=>send({type:'Step'});$('speed').onchange=()=>send({type:'Speed',seconds:Number($('speed').value)});
$('replay-frame').oninput=()=>send({type:'Replay',index:Number($('replay-frame').value)});$('close-replay').onclick=()=>send({type:'Replay',index:null});
window.addEventListener('storage',event=>{if(event.key===storageKey){try{const next=event.newValue?JSON.parse(event.newValue):null;if(!next||next.tab!==tabId){send({type:'Freeze'});stale=true;$('storage-status').textContent='Another tab updated this battle. Reload to use its latest save.';document.querySelectorAll('button,select,input').forEach(el=>el.disabled=true);}}catch{}}});
function render(s){
 const save=s.save,b=save.battle,t=b.turns,f=b.fighters.find(f=>f.id===save.selected),active=b.fighters.find(f=>f.id===t.active);
 const locked=stale||s.replay!==null||b.finished||b.resolving||active.team!==0||f.id!==t.active;
 $('round').textContent=b.finished?(b.winner===0?'Victory':b.winner===null?'Draw':'Defeat'):`Round ${b.round} · ${active.name}${b.resolving?' · playback':''}`;
 $('map-caption').textContent=s.scenarios[save.scenario].name+' · 5-foot hexes';
 $('error').hidden=!s.error;$('error').textContent=s.error;
 $('fighter-name').textContent=f.name;$('status').textContent=f.dead?'Dead':f.damage>=f.max_hits?'Unconscious':f.disabling?'Disabled':'Level '+f.level;
 $('stats').replaceChildren(...[`HP ${Math.max(0,f.max_hits-f.damage)}/${f.max_hits}`,`PP ${f.pp}/${f.max_pp}`,`AT ${f.armor}`,`OB ${f.weapons[f.weapon].ob}`,`DB ${f.db}`,f.weapons[f.weapon].name,`Parry reserve ${t.reserves[f.id]||0}`,...((f.broken_weapons||[]).includes(f.weapon)?['Weapon broken']:[]),...(f.weapon_recovery?.[f.weapon]?['Recovery: '+f.weapon_recovery[f.weapon]+' actions']:[]),`Reload ${f.reload_left} units`].map(text=>element('span',text)));
 $('condition-text').textContent=[f.equipment.join(', ')||'No special armor equipment',...f.conditions.map(c=>`${c.effect.kind}: ${c.effect.roundsLeft??'ongoing'} rounds`)].join(' · ');
 $('keyboard-fighter').replaceChildren(...b.fighters.map(f=>{const op=element('option',f.name+(f.id===t.active?' · ACTIVE':''));op.value=f.id;return op;}));$('keyboard-fighter').value=save.selected;
 $('initiative').replaceChildren(...t.order.map((id,index)=>{const fighter=b.fighters.find(f=>f.id===id),li=element('li',`${fighter.name} · ${b.initiative[id]}${id===t.active?' · ACTIVE':''}${t.reserves[id]?' · Parry '+t.reserves[id]:''}`);li.className=index<t.position?'completed':id===t.active?'active':'';if(id===t.active)li.setAttribute('aria-current','step');return li;}));
 $('turn-title').textContent=`${active.name}’s turn`;
 $('turn-budget').textContent=`${t.movement_remaining} feet remaining · ${t.main_available?'One action available':'Action complete'}${f.id!==t.active?' · Inspecting '+f.name+'; select the active fighter to act.':''}`;
 action=s.interaction.action;
 $('spell-label').hidden=action!=='Cast';
 if(selected!==f.id){selected=f.id;$('spell').replaceChildren(...f.spells.map(sp=>{const op=element('option',labels[sp]);op.value=sp;return op;}));}
 if(s.interaction.spell)$('spell').value=s.interaction.spell;
 for(const button of document.querySelectorAll('[data-action="Attack"],[data-action="Cast"]'))button.setAttribute('aria-pressed',String(button.dataset.action===action));
 const targetOptions=[element('option','Choose a highlighted target')];targetOptions[0].value='';
 for(const id of s.interaction.targets){const unit=b.fighters.find(f=>f.id===id),op=element('option',unit.name);op.value=id;targetOptions.push(op);}
 $('target').replaceChildren(...targetOptions);$('target').value=s.interaction.preview?.kind==='Target'?save.target:'';
 const options=[element('option','Choose a highlighted hex')];options[0].value='';
 for(const to of s.interaction.reachable){const op=element('option',`(${to.q}, ${to.r})`);op.value=`${to.q},${to.r}`;options.push(op);}
 $('destination').replaceChildren(...options);$('destination').value=s.interaction.preview?.kind==='Move'?`${save.destination.q},${save.destination.r}`:'';
 const preview=s.interaction.preview;
 $('board-feedback').textContent=preview?.kind==='Move'?`Move ${preview.feet} feet: click the marked hex again or press Enter to confirm.`:preview?.kind==='Target'?`${action} ${b.fighters.find(f=>f.id===preview.id)?.name}: click again or press Enter to confirm.`:locked?'Click your active fighter when playback finishes.':'Click a blue hex to preview movement, or a highlighted target to preview your action. Click again to confirm. Escape cancels.';
 for(const el of document.querySelectorAll('#actions button,#actions select'))el.disabled=locked;
 $('destination').disabled=locked;$('target').disabled=locked;
 for(const button of document.querySelectorAll('[data-action]')){
  const kind=button.dataset.action,w=f.weapons[f.weapon];
  button.hidden=kind==='Cast'&&!f.spells.length||kind==='Reload'&&(!w.reload||!f.reload_left)||kind==='RecoverWeapon'&&!f.weapon_recovery?.[f.weapon]||kind==='StandUp'&&!f.conditions.some(c=>c.effect.kind==='prone')||kind==='ChangeWeapon'&&f.weapons.length<2;
 }
 $('actions').hidden=b.finished||s.replay!==null;
 $('playback').hidden=b.finished||s.replay!==null;$('pause').textContent=s.paused?'Resume':'Pause';
 $('outcome').hidden=!b.finished;$('outcome').textContent=b.winner===0?'Victory — the field is yours.':b.winner===null?'Draw — both sides fell.':'Defeat — your party has fallen.';
 $('log-count').textContent=`(${b.events.length})`;
 $('events').replaceChildren(...b.events.slice(-100).reverse().map(e=>element('li',`R${e.round} · ${e.text}${e.dice.length?' · dice '+e.dice.join(', '):''}`)));
 $('replay-frame').max=save.history.length-1;
 if(s.replay!==null){$('replay-frame').value=s.replay;$('replay-caption').textContent=save.history[s.replay]?.event?.text||'Initial deployment';}else{$('replay-caption').textContent=`${save.history.length} recorded frames. Replay never rolls dice or changes the live battle.`;}
}
function poll(){
 try{
  if(typeof wasm_exports!=='undefined'&&wasm_exports.rm_snapshot_len){const len=wasm_exports.rm_snapshot_len();if(len){const s=JSON.parse(new TextDecoder().decode(new Uint8Array(wasm_exports.memory.buffer,wasm_exports.rm_snapshot_ptr(),len)));
   if(!restored){restored=true;send({type:'Motion',reduced:matchMedia('(prefers-reduced-motion: reduce)').matches});try{const stored=localStorage.getItem(storageKey);if(localStorage.getItem(legacyKey))$('storage-status').textContent='Your older battle is preserved separately. Battles with declarations must be restarted under the new turn rules.';if(stored){const record=JSON.parse(stored);send({type:'Restore',save:record.save});lastRevision=s.revision;requestAnimationFrame(poll);return;}}catch(error){$('storage-status').textContent='Saved battle could not be loaded: '+error.message;}}
   if(s.revision!==lastRevision){lastRevision=s.revision;snapshot=s;inputPending=false;render(s);const serialized=JSON.stringify(s.save);if(!stale&&serialized!==lastSerialized){try{localStorage.setItem(storageKey,JSON.stringify({tab:tabId,save:s.save}));lastSerialized=serialized;if($('storage-status').textContent.startsWith('Autosave failed'))$('storage-status').textContent='';}catch(error){$('storage-status').textContent='Autosave failed. Keep this tab open; your current battle is still in memory. '+error.message;}}}
  }}
 }catch(error){$('error').hidden=false;$('error').textContent='Game interface error: '+error.message;}
 requestAnimationFrame(poll);
}
requestAnimationFrame(poll);

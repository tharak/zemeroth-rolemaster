/* UI and persistence only. Combat rules, dice and AI execute in the Rust module. */
'use strict';
const $=id=>document.getElementById(id);
const storageKey='zemeroth-rolemaster.skirmish.v1';
const tabId=crypto.randomUUID();
let snapshot=null,lastRevision=-1,restored=false,stale=false,lastSerialized='',selected=null;
const labels={HealingI:'Healing I',HealingIII:'Healing III',BlessI:'Bless I',Blur:'Blur',ShockBoltI:'Shock Bolt I',JoltsI:'Jolts I',MinorPain:'Minor Pain'};
function send(command){
 if(stale){$('storage-status').textContent='Another tab updated this battle. Reload this tab before continuing.';return;}
 if(typeof wasm_exports==='undefined'||!wasm_exports.rm_alloc)return;
 const bytes=new TextEncoder().encode(JSON.stringify(command));const ptr=wasm_exports.rm_alloc(bytes.length);
 if(!ptr){$('error').hidden=false;$('error').textContent='Command exceeds the supported save size.';return;}
 new Uint8Array(wasm_exports.memory.buffer,ptr,bytes.length).set(bytes);wasm_exports.rm_command(ptr,bytes.length);
}
function element(tag,text,cls){const el=document.createElement(tag);if(text!==undefined)el.textContent=text;if(cls)el.className=cls;return el;}
function describe(a){const kind=typeof a.action==='string'?a.action:Object.keys(a.action)[0];const details=typeof a.action==='object'?a.action[kind]:{};return `${a.phase} · ${a.activity}% · ${kind}${details.spell?' '+labels[details.spell]:''}${details.target?' → #'+details.target:''}${details.path?' · '+details.path.length*5+' ft':''}`;}
function actionHelp(){const kind=$('action').value;$('spell-label').hidden=!['Prepare','Cast'].includes(kind);$('destination-label').hidden=!['Move','Disengage'].includes(kind);const values={Press:100,React:100,Melee:100,Missile:60,Move:$('phase').value==='Snap'?20:$('phase').value==='Normal'?50:80,Disengage:25,Prepare:90,Cast:$('spell').value==='Blur'?10:75,Reload:50,ChangeWeapon:50,Wait:0};$('activity').value=values[kind];$('action-help').textContent=({Move:'Tap an empty hex on the battlefield. The dotted route is checked against your activity budget.',Disengage:'Choose an empty hex within 10 feet; costs 25% activity.',Prepare:'Spend 90% preparing this spell. Cast it in a later round to reduce casting penalties.',Cast:'Healing and blessings require a friendly target. Blur targets yourself. Offensive spells need an enemy and clear line of sight.',Reload:'Shortbow reload costs 50% activity. It must finish before firing.',ChangeWeapon:'Change to the next weapon for 50% activity.'})[kind]||'Choose an enemy. Parry trades offensive bonus for defense against that enemy.';}
for(const id of ['action','phase','spell'])$(id).addEventListener('change',actionHelp);
$('menu-button').onclick=()=>{const open=$('setup').hidden;$('setup').hidden=!open;$('menu-button').setAttribute('aria-expanded',String(open));if(open)$('scenario').focus();};
$('restart').onclick=()=>{const seed=Number($('seed').value);if(!Number.isSafeInteger(seed)||seed<1||seed>4294967295){$('error').hidden=false;$('error').textContent='Seed must be an integer between 1 and 4294967295.';return;}send({type:'Restart',scenario:Number($('scenario').value),seed});$('setup').hidden=true;$('menu-button').setAttribute('aria-expanded','false');};
$('destination').onchange=()=>{if($('destination').value){const [q,r]=$('destination').value.split(',').map(Number);send({type:'Destination',q,r});}};
$('target').onchange=()=>send({type:'Target',id:Number($('target').value)});
$('declare').onclick=()=>send({type:'Declare',phase:$('phase').value,activity:Number($('activity').value),kind:$('action').value,spell:$('spell').value||null,parry:Number($('parry').value)});
$('react-target').onclick=()=>send({type:'ReactChoice',target:Number($('react-target-select').value)});$('react-wait').onclick=()=>send({type:'ReactChoice',target:null});
$('clear').onclick=()=>send({type:'Clear'});$('commit').onclick=()=>send({type:'Commit'});
$('pause').onclick=()=>send({type:'Pause'});$('step').onclick=()=>send({type:'Step'});$('speed').onchange=()=>send({type:'Speed',seconds:Number($('speed').value)});
$('replay-frame').oninput=()=>send({type:'Replay',index:Number($('replay-frame').value)});
$('close-replay').onclick=()=>send({type:'Replay',index:null});
window.addEventListener('storage',event=>{if(event.key===storageKey&&event.newValue){try{const next=JSON.parse(event.newValue);if(next.tab!==tabId){send({type:'Freeze'});stale=true;$('storage-status').textContent='Another tab updated this battle. Reload to use its latest save.';document.querySelectorAll('aside button,aside select,aside input').forEach(el=>el.disabled=true);}}catch{}}});
function render(s){
 const save=s.save,b=save.battle;const f=b.fighters.find(f=>f.id===save.selected);
 $('round').textContent=b.finished?(b.winner===0?'Victory':'Defeat'):`Round ${b.round} · ${b.resolving?(b.queue[b.cursor]?.phase||'Cleanup'):'Declarations'}`;
 $('map-caption').textContent=s.scenarios[save.scenario].name+' · 5-foot hexes';
 $('error').hidden=!s.error;$('error').textContent=s.error;
 $('fighter-name').textContent=f.name;$('status').textContent=f.dead?'Dead':f.damage>=f.max_hits?'Unconscious':f.disabling?'Disabled':'Level '+f.level;
 $('stats').replaceChildren(...[`HP ${Math.max(0,f.max_hits-f.damage)}/${f.max_hits}`,`PP ${f.pp}/${f.max_pp}`,`AT ${f.armor}`,`OB ${f.weapons[f.weapon].ob}`,`DB ${f.db}`,f.weapons[f.weapon].name,`Reload ${f.reload_left}%`].map(t=>element('span',t)));
 $('condition-text').textContent=[f.equipment.join(', ')||'No special armor equipment',f.preparation?`${labels[f.preparation.spell]}: ${f.preparation.rounds} preparation rounds`:'No spell prepared',...f.conditions.map(c=>`${c.effect.kind}: ${c.effect.roundsLeft??'ongoing'} rounds${c.effect.amount?' ('+c.effect.amount+')':''}`)].join(' · ');
 $('roster').replaceChildren(...b.fighters.filter(f=>f.team===0).map(f=>{const button=element('button',f.name);button.setAttribute('aria-pressed',String(f.id===save.selected));button.append(element('small',`${Math.max(0,f.max_hits-f.damage)}/${f.max_hits} HP`));button.onclick=()=>send({type:'Select',id:f.id});return button;}));
 if(selected!==f.id){selected=f.id;$('spell').replaceChildren(...f.spells.map(sp=>{const op=element('option',labels[sp]);op.value=sp;return op;}));$('parry').value=save.draft.parry[f.id]?.amount||0;actionHelp();}
 const signature=b.fighters.map(f=>`${f.id}:${f.damage}:${f.dead}`).join('|');
 if($('target').dataset.signature!==signature){$('target').replaceChildren(...b.fighters.map(t=>{const op=element('option',`#${t.id} ${t.name} · ${Math.max(0,t.max_hits-t.damage)} HP`);op.value=t.id;return op;}));$('target').dataset.signature=signature;}
 $('target').value=save.target;
 const mapSignature=`${b.round}:${save.selected}:${b.cursor}:${save.scenario}`;
 if($('destination').dataset.signature!==mapSignature){
  const options=[element('option','Choose a destination')];options[0].value='';
  for(let r=-b.radius;r<=b.radius;r++)for(let q=-b.radius;q<=b.radius;q++){
   if((Math.abs(q)+Math.abs(r)+Math.abs(q+r))/2>b.radius||b.walls.some(p=>p.q===q&&p.r===r)||b.fighters.some(u=>!u.dead&&u.damage<u.max_hits&&u.pos.q===q&&u.pos.r===r))continue;
   const distance=(Math.abs(q-f.pos.q)+Math.abs(r-f.pos.r)+Math.abs(q+r-f.pos.q-f.pos.r))/2*5;
   const op=element('option',`(${q}, ${r}) · ${distance} ft from ${f.name}`);op.value=`${q},${r}`;options.push(op);
  }
  $('destination').replaceChildren(...options);$('destination').dataset.signature=mapSignature;
 }
 $('destination').value=save.destination?`${save.destination.q},${save.destination.r}`:'';

 $('plan').replaceChildren(...save.draft.actions.filter(a=>a.actor===f.id).map(a=>element('p',describe(a))));
 const total=save.draft.actions.filter(a=>a.actor===f.id).reduce((n,a)=>n+a.activity,0);$('plan').append(element('p',`${total}% declared · ${100-total}% unused${save.destination?` · Destination (${save.destination.q}, ${save.destination.r})`:''}`));
 $('reaction').hidden=!b.awaiting_react;if(b.awaiting_react){$('react-target-select').replaceChildren(...b.fighters.filter(t=>t.team!==b.fighters.find(f=>f.id===b.awaiting_react).team&&!t.dead&&t.damage<t.max_hits).map(t=>{const op=element('option',`#${t.id} ${t.name}`);op.value=t.id;return op;}));if([...$('react-target-select').options].some(o=>o.value==save.target))$('react-target-select').value=save.target;}
 $('declarations').hidden=b.resolving||b.finished||s.replay!==null;$('playback').hidden=!b.resolving||s.replay!==null;$('pause').textContent=s.paused?'Resume':'Pause';
 $('outcome').hidden=!b.finished;$('outcome').textContent=b.winner===0?'Victory — the field is yours.':b.winner===null?'Draw — both sides fell.':'Defeat — your party has fallen.';
 $('log-count').textContent=`(${b.events.length})`;
 $('events').replaceChildren(...b.events.slice(-100).reverse().map(e=>element('li',`R${e.round}${e.phase?' '+e.phase:''} · ${e.text}${e.dice.length?' · dice '+e.dice.join(', '):''}`)));
 $('replay-frame').max=save.history.length-1;
 if(s.replay!==null){$('replay-frame').value=s.replay;$('replay-caption').textContent=save.history[s.replay]?.event?.text||'Initial deployment';}else{$('replay-caption').textContent=`${save.history.length} recorded frames. Replay never rolls dice or changes the live battle.`;}
}
function poll(){
 try{
  if(typeof wasm_exports!=='undefined'&&wasm_exports.rm_snapshot_len){const len=wasm_exports.rm_snapshot_len();if(len){const s=JSON.parse(new TextDecoder().decode(new Uint8Array(wasm_exports.memory.buffer,wasm_exports.rm_snapshot_ptr(),len)));
   if(!restored){restored=true;send({type:"Motion",reduced:matchMedia("(prefers-reduced-motion: reduce)").matches});try{const stored=localStorage.getItem(storageKey);if(stored){const record=JSON.parse(stored);send({type:'Restore',save:record.save});lastRevision=s.revision;requestAnimationFrame(poll);return;}}catch(error){$('storage-status').textContent='Saved battle could not be loaded: '+error.message;}}
   if(s.revision!==lastRevision){lastRevision=s.revision;snapshot=s;render(s);const serialized=JSON.stringify(s.save);if(!stale&&serialized!==lastSerialized){try{localStorage.setItem(storageKey,JSON.stringify({tab:tabId,save:s.save}));lastSerialized=serialized;if($("storage-status").textContent.startsWith("Autosave failed"))$("storage-status").textContent="";}catch(error){$('storage-status').textContent='Autosave failed. Keep this tab open; your current battle is still in memory. '+error.message;}}}
  }}
 }catch(error){$('error').hidden=false;$('error').textContent='Game interface error: '+error.message;}
 requestAnimationFrame(poll);
}
requestAnimationFrame(poll);

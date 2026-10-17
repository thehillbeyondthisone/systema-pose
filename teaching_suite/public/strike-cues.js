import * as THREE from 'three';
import {detectMotionStrikes} from './strike-estimates.mjs';

const NOTE='Teaching illustration · intensity is chosen, not measured force.';
const MAX_CUES=100;
const LIMBS=[['left_wrist','Left hand'],['right_wrist','Right hand'],['left_foot','Left foot'],['right_foot','Right foot']];
const JOINT_LABELS={pelvis:'Pelvis',left_hip:'Left hip',right_hip:'Right hip',spine1:'Lower torso',
  left_knee:'Left knee',right_knee:'Right knee',spine2:'Middle torso',left_ankle:'Left ankle',right_ankle:'Right ankle',
  spine3:'Upper chest',left_foot:'Left foot',right_foot:'Right foot',neck:'Neck',left_collar:'Left collarbone',
  right_collar:'Right collarbone',head:'Head',left_shoulder:'Left shoulder',right_shoulder:'Right shoulder',
  left_elbow:'Left elbow',right_elbow:'Right elbow',left_wrist:'Left wrist',right_wrist:'Right wrist'};
const COLORS=['#ffe59a','#ffd06c','#ffad50','#ff884b','#ff6058'];
export const strikeConfidenceLabel=value=>value>=.6?'Moderate confidence':'Low confidence';
const clamp=(value,low,high)=>Math.min(high,Math.max(low,value));
const isObject=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const finite=value=>typeof value==='number'&&Number.isFinite(value);
const safeName=value=>typeof value==='string'&&value.trim().length>0&&value.length<=80&&!/[\u0000-\u001f\u007f]/.test(value);
let instanceCount=0;

function clipIdentity(motion){
  return {sourceSha256:motion.sourceSha256,sourceStart:motion.sourceStart,sourceEnd:motion.sourceEnd,
    fps:motion.fps,frameCount:motion.frames.length};
}

/** Validate imported/local data against this exact source and clip. Returns plain copied data. */
export function validateStrikeCueDocument(document,motion){
  const identity=clipIdentity(motion);
  if(!isObject(document)||document.schemaVersion!==1)throw Error('Choose a version 1 strike cue JSON file.');
  if(Object.entries(identity).some(([key,value])=>document[key]!==value))throw Error('These cues belong to a different source clip.');
  if(!Array.isArray(document.cues)||document.cues.length>MAX_CUES)throw Error(`A clip can contain up to ${MAX_CUES} cues.`);
  const people=new Set(motion.people.map(person=>String(person.id))), ids=new Set();
  const joints=new Set(motion.jointNames), limbs=new Set(LIMBS.map(([joint])=>joint));
  const cues=document.cues.map(cue=>{
    if(!isObject(cue)||typeof cue.id!=='string'||!/^[a-zA-Z0-9_-]{1,80}$/.test(cue.id)||ids.has(cue.id))throw Error('Each cue needs a unique valid ID.');
    if(!safeName(cue.name))throw Error('Cue names must be 1–80 printable characters.');
    if(!Number.isInteger(cue.frame)||cue.frame<0||cue.frame>=identity.frameCount)throw Error('A cue placement frame is outside this clip.');
    if(typeof cue.strikerId!=='string'||typeof cue.targetId!=='string'||!people.has(cue.strikerId)||!people.has(cue.targetId)||cue.strikerId===cue.targetId)throw Error('Choose two different participants in this clip.');
    if(!limbs.has(cue.limb)||!joints.has(cue.limb)||!joints.has(cue.targetJoint))throw Error('A cue names an unavailable body joint.');
    if(!Array.isArray(cue.offset)||cue.offset.length!==3||!cue.offset.every(value=>finite(value)&&Math.abs(value)<=2))throw Error('Target offsets must be between −2 and 2 metres.');
    if(!Number.isInteger(cue.intensity)||cue.intensity<1||cue.intensity>5)throw Error('Visual emphasis must be an integer from 1 to 5.');
    if(!finite(cue.duration)||cue.duration<0.3||cue.duration>1.5)throw Error('Cue duration must be between 0.3 and 1.5 seconds.');
    ids.add(cue.id);
    return {id:cue.id,name:cue.name.trim(),frame:cue.frame,strikerId:cue.strikerId,limb:cue.limb,
      targetId:cue.targetId,targetJoint:cue.targetJoint,offset:[...cue.offset],intensity:cue.intensity,duration:cue.duration};
  });
  return {schemaVersion:1,...identity,cues};
}

function element(tag,className,text){
  const node=document.createElement(tag);
  if(className)node.className=className;
  if(text!==undefined)node.textContent=text;
  return node;
}
function button(text,action,className=''){
  const node=element('button',className,text);node.type='button';node.addEventListener('click',action);return node;
}

/** Frame-driven teaching overlays; neither authored cues nor estimates modify captured movement. */
export class StrikeCues{
  constructor({world,motion,storageKey='systema-strike-cues-v1',onSeek=()=>{},onPlayPreview=()=>{},onChange=()=>{},resolveTargetPoint=null,container}={}){
    if(!world||!motion?.frames?.length||!motion?.people?.length||!motion?.jointNames?.length)throw Error('Strike cues need a reconstructed scene.');
    if(typeof motion.sourceSha256!=='string'||!/^[a-f0-9]{64}$/i.test(motion.sourceSha256))throw Error('Strike cues need the source fingerprint.');
    this.motion=motion;this.identity=clipIdentity(motion);this.onSeek=onSeek;this.onPlayPreview=onPlayPreview;this.onChange=onChange;
    this.storageKey=`${storageKey}:${Object.values(this.identity).join(':')}`;
    this.frame=0;this.enabled=true;this.cues=[];this.editingId=null;this.visuals=new Map();this.highlights=new Map();
    this.estimatedEnabled=true;this.estimatedVisuals=new Map();this.activeEstimates=[];this.resolveTargetPoint=resolveTargetPoint;
    try{this.estimates=detectMotionStrikes(motion);this.estimateError='';}
    catch{this.estimates=[];this.estimateError='Motion estimates are unavailable for this clip.';}
    this.lastOptions={visibleIds:new Set(motion.people.map(person=>String(person.id))),xray:false};
    this.group=new THREE.Group();this.group.name='Authored strike teaching illustrations';this.group.userData.figureOverlay=true;world.add(this.group);
    this.estimatedGroup=new THREE.Group();this.estimatedGroup.name='Motion-estimated strike highlights';
    this.estimatedGroup.userData.figureOverlay=true;this.estimatedGroup.userData.motionStrikeOverlay=true;world.add(this.estimatedGroup);
    this.prefix=instanceCount++?'strikeCue'+instanceCount:'strikeCue';
    this.loadStatus='';
    try{
      const saved=localStorage.getItem(this.storageKey);
      if(saved)this.cues=validateStrikeCueDocument(JSON.parse(saved),motion).cues;
    }catch{this.loadStatus='Saved cues could not be read. You can import a previously exported file.';}
    if(container)this.mount(container);
  }

  mount(container){
    this.container=container;container.replaceChildren();
    const root=element('div','strike-cues');this.root=root;container.append(root);
    this.mountEstimates(root);
    root.append(element('p','strike-note',NOTE));
    const controls=element('div','strike-controls');
    const enabledLabel=element('label','strike-toggle');
    this.enabledInput=element('input');this.enabledInput.type='checkbox';this.enabledInput.id=this.prefix+'Enabled';this.enabledInput.checked=this.enabled;
    this.enabledInput.addEventListener('change',()=>{this.enabled=this.enabledInput.checked;this.changed();});
    enabledLabel.append(this.enabledInput,document.createTextNode(' Show strike illustrations'));
    controls.append(enabledLabel,button('Create cue at this frame',()=>this.startNew()));
    controls.lastChild.id=this.prefix+'New';root.append(controls);
    this.frameLabel=element('p','strike-current-frame');root.append(this.frameLabel);
    this.form=element('form','strike-form');this.form.hidden=true;
    this.form.addEventListener('submit',event=>{event.preventDefault();this.saveEditor();});
    this.formHeading=element('h3','strike-form-title','New strike illustration');this.form.append(this.formHeading);
    const grid=element('div','strike-grid');this.form.append(grid);this.fields={};
    const addField=(key,label,type,options=[])=>{
      const wrapper=element('label','strike-field'),text=element('span','',label);
      const control=element(type==='select'?'select':'input');control.id=this.prefix+key;control.name=key;control.required=true;
      if(type!=='select')control.type=type;
      for(const [value,labelText] of options){const option=element('option','',labelText);option.value=value;control.append(option);}
      wrapper.append(text,control);grid.append(wrapper);this.fields[key]=control;return control;
    };
    const participants=this.motion.people.map(person=>[String(person.id),person.name||`Participant ${person.id}`]);
    addField('Name','Cue name','text').maxLength=80;
    const placement=addField('Frame','Placement frame','number');placement.min='0';placement.max=String(this.identity.frameCount-1);placement.step='1';
    addField('Striker','Striking participant','select',participants);
    addField('Limb','Striking limb','select',LIMBS.filter(([joint])=>this.motion.jointNames.includes(joint)));
    addField('Target','Target participant','select',participants);
    addField('Joint','Target body region','select',this.motion.jointNames.map(joint=>[joint,JOINT_LABELS[joint]||joint]));
    this.fields.Striker.addEventListener('change',()=>this.refreshTargetOptions());
    const intensity=addField('Intensity','Visual emphasis','range');intensity.min='1';intensity.max='5';intensity.step='1';
    this.intensityOutput=element('output','strike-emphasis');this.intensityOutput.htmlFor=intensity.id;
    intensity.parentElement.append(this.intensityOutput);
    intensity.addEventListener('input',()=>this.updateIntensityLabel());
    const duration=addField('Duration','Duration (seconds)','number');duration.min='0.3';duration.max='1.5';duration.step='0.1';
    const offsetDetails=element('details','strike-offsets'),offsetSummary=element('summary','','Adjust target placement');
    offsetDetails.append(offsetSummary,element('p','strike-help','Optional offset from the selected joint, in scene metres.'));
    const offsets=element('div','strike-grid');offsetDetails.append(offsets);
    for(const axis of ['X','Y','Z']){
      const label=element('label','strike-field'),input=element('input');
      input.type='number';input.min='-2';input.max='2';input.step='0.01';input.value='0';input.required=true;input.id=this.prefix+'Offset'+axis;
      label.append(element('span','',`${axis} offset (m)`),input);offsets.append(label);this.fields['Offset'+axis]=input;
    }
    this.form.append(offsetDetails,element('p','strike-help','Placement is your chosen teaching moment. Arrows and pulses illustrate it; the captured motion stays unchanged.'));
    const editorActions=element('div','strike-actions');
    this.saveButton=element('button','','Save cue');this.saveButton.type='submit';this.saveButton.id=this.prefix+'Save';
    const preview=button('Preview illustration',()=>this.previewEditor());preview.id=this.prefix+'Preview';
    const cancel=button('Cancel',()=>this.closeEditor());cancel.id=this.prefix+'Cancel';editorActions.append(this.saveButton,preview,cancel);
    this.form.append(editorActions);root.append(this.form);
    this.list=element('ol','strike-list');this.list.setAttribute('aria-label','Saved strike illustrations');root.append(this.list);
    this.empty=element('p','strike-empty','No strike illustrations yet. Pause at a teaching moment, then create a cue.');root.append(this.empty);
    const fileActions=element('div','strike-actions');
    const exportButton=button('Export cues',()=>this.export());exportButton.id=this.prefix+'Export';
    const importLabel=element('label','strike-import','Import cues '),importInput=element('input');
    importInput.type='file';importInput.accept='.json,application/json';importInput.id=this.prefix+'Import';
    importInput.addEventListener('change',async()=>{const file=importInput.files?.[0];if(file)await this.import(file);importInput.value='';});
    importLabel.append(importInput);fileActions.append(exportButton,importLabel);root.append(fileActions);
    this.status=element('p','strike-status');this.status.id=this.prefix+'Status';this.status.setAttribute('role','status');this.status.setAttribute('aria-live','polite');root.append(this.status);
    this.renderList();this.update(this.frame,this.lastOptions);
    if(this.loadStatus)this.message(this.loadStatus);
    return this;
  }

  mountEstimates(root){
    const section=element('section','strike-estimates');section.setAttribute('aria-label','Likely strikes from captured motion');
    const header=element('div','strike-estimate-header');header.append(element('h3','','Likely strike estimates'));
    const toggle=element('label','strike-estimate-toggle');
    this.estimatedInput=element('input');this.estimatedInput.type='checkbox';this.estimatedInput.id=this.prefix+'EstimatedEnabled';this.estimatedInput.checked=this.estimatedEnabled;
    this.estimatedInput.addEventListener('change',()=>{this.estimatedEnabled=this.estimatedInput.checked;this.changed();});
    toggle.append(this.estimatedInput,document.createTextNode(' Highlight likely strikes'));header.append(toggle);section.append(header);
    section.append(element('p','strike-estimate-summary','Motion-based candidates may include blocks or grabs. Relative motion intensity is not measured force; contact is unverified.'));
    this.estimateStatus=element('p','strike-estimate-status');this.estimateStatus.id=this.prefix+'EstimatedStatus';
    this.estimateStatus.textContent=this.estimateError||`${this.estimates.length} possible strike${this.estimates.length===1?'':'s'} · scrub, jump or replay slowly.`;
    this.estimatedCurrent=element('p','strike-estimate-current');this.estimatedCurrent.id=this.prefix+'EstimatedCurrent';
    this.estimatedCurrent.setAttribute('aria-live','polite');this.estimatedCurrent.setAttribute('aria-atomic','true');
    this.estimatedList=element('ol','strike-estimate-list');this.estimatedList.id=this.prefix+'EstimatedList';
    this.estimatedList.setAttribute('aria-label','Motion-estimated strike moments');
    this.estimateItems=new Map();
    for(const event of this.estimates){
      const item=element('li','strike-estimate-item');item.dataset.estimateId=event.id;item.dataset.frame=String(event.frame);
      const copy=element('div','strike-item-copy'),limb=LIMBS.find(([joint])=>joint===event.limb)?.[1]||JOINT_LABELS[event.limb]||event.limb;
      const region=event.region||JOINT_LABELS[event.targetJoint]||event.targetJoint;
      const heading=element('strong','',`${limb} → ${region}`),intensity=element('span','strike-estimate-intensity',`${event.intensity}/5 relative`);
      intensity.style.setProperty('--strike-intensity-color',COLORS[event.intensity-1]);
      intensity.setAttribute('aria-label',`Estimated relative intensity ${event.intensity} of 5`);
      const confidence=strikeConfidenceLabel(event.confidence);
      copy.append(heading,element('span','strike-estimate-meta',`${this.sourceTime(event.frame)} · ${this.personName(event.strikerId)} → ${this.personName(event.targetId)}`),
        element('span','strike-estimate-confidence',`${confidence}${event.uncertainty?' · '+event.uncertainty:''}`),intensity);
      const actions=element('div','strike-actions strike-estimate-actions');
      const jump=button('Jump',()=>{this.onSeek(event.frame);this.changed();});
      jump.setAttribute('aria-label',`Jump to estimated ${limb.toLowerCase()} strike at ${this.sourceTime(event.frame)}`);
      const replay=button('Replay slowly',()=>{
        this.estimatedEnabled=true;this.estimatedInput.checked=true;
        this.onPlayPreview({startFrame:event.startFrame,endFrame:event.endFrame,playbackRate:.25,estimated:true});this.changed();
      });
      replay.setAttribute('aria-label',`Replay estimated ${limb.toLowerCase()} strike at ${this.sourceTime(event.frame)} slowly`);
      actions.append(jump,replay);item.append(copy,actions);this.estimatedList.append(item);this.estimateItems.set(event.id,item);
    }
    if(!this.estimates.length)this.estimatedList.hidden=true;
    section.append(this.estimateStatus,this.estimatedCurrent,this.estimatedList);root.append(section);
  }
  personName(id){const person=this.motion.people.find(person=>String(person.id)===String(id));return person?.name||`Participant ${id}`;}
  refreshParticipantNames(){
    for(const key of ['Striker','Target'])for(const option of this.fields?.[key]?.options||[])option.textContent=this.personName(option.value);
    for(const event of this.estimates){
      const item=this.estimateItems?.get(event.id),meta=item?.querySelector('.strike-estimate-meta');
      if(meta)meta.textContent=`${this.sourceTime(event.frame)} · ${this.personName(event.strikerId)} → ${this.personName(event.targetId)}`;
    }
    this.renderList();
  }
  getActiveEstimates(){return [...this.activeEstimates];}
  personAt(frame,id){return this.motion.frames[clamp(Math.round(frame),0,this.identity.frameCount-1)]?.people.find(person=>String(person.id)===String(id));}
  pointAt(frame,id,joint){
    const point=this.personAt(frame,id)?.xyz?.[this.motion.jointNames.indexOf(joint)];
    return Array.isArray(point)&&point.length===3&&point.every(Number.isFinite)?new THREE.Vector3(...point):null;
  }
  estimateLanding(event){
    const segment=event.targetSegment;
    if(segment){
      const a=this.pointAt(this.frame,event.targetId,segment.start||segment[0]),b=this.pointAt(this.frame,event.targetId,segment.end||segment[1]);
      if(a&&b)return a.lerp(b,clamp(event.targetFraction??segment.fraction??.5,0,1)).add(new THREE.Vector3(...(event.surfaceOffset||[0,0,0])));
    }
    return this.pointAt(this.frame,event.targetId,event.targetJoint)?.add(new THREE.Vector3(...(event.offset||[0,0,0])))||null;
  }
  createEstimatedVisual(event){
    const group=new THREE.Group();group.name=`Estimated strike ${event.id}`;group.userData.estimateId=event.id;
    const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.BufferAttribute(new Float32Array(65*3),3));
    const trajectory=new THREE.Line(geometry,new THREE.LineBasicMaterial({transparent:true,opacity:.8,depthWrite:false}));trajectory.name='Captured limb trajectory';
    const ring=new THREE.Mesh(new THREE.TorusGeometry(1,.045,8,40),new THREE.MeshBasicMaterial({transparent:true,depthWrite:false,side:THREE.DoubleSide}));ring.name='Estimated landing ring';
    const pulse=new THREE.Mesh(new THREE.SphereGeometry(1,16,10),new THREE.MeshBasicMaterial({transparent:true,opacity:.12,depthWrite:false}));pulse.name='Relative intensity pulse';
    const bead=new THREE.Mesh(new THREE.SphereGeometry(1,12,8),new THREE.MeshBasicMaterial({transparent:true,depthWrite:false}));bead.name='Captured striking limb';
    group.add(trajectory,ring,pulse,bead);this.estimatedGroup.add(group);
    const visual={group,trajectory,ring,pulse,bead,event};this.estimatedVisuals.set(event.id,visual);return visual;
  }
  refreshEstimatedLandings(){
    for(const event of this.activeEstimates){
      const visual=this.estimatedVisuals.get(event.id);if(!visual?.group.visible)continue;
      let resolved=null;
      if(typeof this.resolveTargetPoint==='function'){
        try{resolved=this.resolveTargetPoint(event,this.frame);}catch{/* Fall back to captured target anatomy. */}
      }
      const asVector=value=>value?.isVector3?value.clone():Array.isArray(value)&&value.length===3&&value.every(Number.isFinite)?new THREE.Vector3(...value):null;
      const point=asVector(resolved?.point)||asVector(resolved)||this.estimateLanding(event);
      if(!point){visual.ring.visible=false;visual.pulse.visible=false;continue;}
      const normal=asVector(resolved?.normal)||visual.bead.position.clone().sub(point);
      if(normal.lengthSq()<1e-8)normal.set(0,0,1);normal.normalize();
      visual.ring.visible=true;visual.pulse.visible=true;visual.ring.position.copy(point);visual.pulse.position.copy(point);
      visual.ring.lookAt(point.clone().add(normal));visual.group.userData.landingPoint=point.toArray();
      visual.group.userData.landingResolved=Boolean(resolved);visual.group.userData.frame=this.frame;
    }
  }
  updateEstimates(ids){
    this.estimatedGroup.visible=this.estimatedEnabled;this.activeEstimates=[];
    for(const visual of this.estimatedVisuals.values())visual.group.visible=false;
    if(this.estimatedEnabled){
      for(const event of this.estimates){
        if(this.frame<event.startFrame||this.frame>event.endFrame||!ids.has(String(event.strikerId))||!ids.has(String(event.targetId)))continue;
        const source=this.pointAt(this.frame,event.strikerId,event.limb),landing=this.estimateLanding(event);if(!source||!landing)continue;
        this.activeEstimates.push(event);const visual=this.estimatedVisuals.get(event.id)||this.createEstimatedVisual(event);visual.group.visible=true;
        const color=COLORS[event.intensity-1],since=(this.frame-event.frame)/this.identity.fps;
        // A frame-based pulse gives the same contact emphasis while paused, scrubbing or replaying.
        const emphasis=Math.exp(-Math.pow(since/.13,2)),radius=.055+event.intensity*.013;
        visual.ring.scale.setScalar(radius*(1+emphasis*.55));visual.ring.material.opacity=.45+emphasis*.5;
        visual.pulse.scale.setScalar(radius*(.7+emphasis*.55));visual.pulse.material.opacity=.045+emphasis*.17;
        visual.bead.position.copy(source);visual.bead.scale.setScalar(.017+event.intensity*.003);visual.bead.material.opacity=.75;
        const points=[],first=event.startFrame,last=Math.min(this.frame,event.endFrame),step=Math.max(1,Math.ceil((last-first)/64));
        for(let sample=first;sample<=last;sample+=step){const point=this.pointAt(sample,event.strikerId,event.limb);if(point)points.push(point);else points.length=0;}
        if(points.length&&points[points.length-1].distanceToSquared(source)>1e-12)points.push(source);
        const array=visual.trajectory.geometry.attributes.position.array;
        points.slice(-65).forEach((point,index)=>point.toArray(array,index*3));
        visual.trajectory.geometry.setDrawRange(0,Math.min(65,points.length));visual.trajectory.geometry.attributes.position.needsUpdate=true;
        visual.trajectory.geometry.computeBoundingSphere();visual.trajectory.visible=points.length>1;
        visual.group.traverse(object=>{if(object.material){object.material.color?.set(color);object.material.depthTest=true;object.material.depthWrite=false;object.renderOrder=4;}});
        for(const [id,jointName,role] of [[event.strikerId,event.limb,'striker'],[event.targetId,event.targetJoint,'target']]){
          const joint=this.motion.jointNames.indexOf(jointName);if(joint<0)continue;
          if((this.highlights.get(String(id))?.intensity||0)<=event.intensity)this.highlights.set(String(id),{joint,jointName,intensity:event.intensity,color,role,estimated:true});
        }
      }
    }
    this.refreshEstimatedLandings();
    for(const [id,item] of this.estimateItems||[]){const active=this.activeEstimates.some(event=>event.id===id);item.classList.toggle('active',active);if(active)item.setAttribute('aria-current','true');else item.removeAttribute('aria-current');}
    if(this.estimatedCurrent){
      const event=this.activeEstimates.reduce((best,event)=>!best||Math.abs(event.frame-this.frame)<Math.abs(best.frame-this.frame)?event:best,null);
      const text=!this.estimatedEnabled?'Motion highlights off.':event?`Likely ${event.region||JOINT_LABELS[event.targetJoint]||event.targetJoint} strike · ${event.intensity}/5 relative intensity${this.activeEstimates.length>1?` · ${this.activeEstimates.length} nearby moments`:''}`:'Scrub to a listed moment to see the estimated landing.';
      if(this.estimatedCurrent.textContent!==text)this.estimatedCurrent.textContent=text;
      this.estimatedCurrent.dataset.activeCount=String(this.activeEstimates.length);this.estimatedCurrent.dataset.frame=String(this.frame);
      this.estimatedCurrent.dataset.estimateId=event?.id||'';this.estimatedCurrent.dataset.intensity=event?String(event.intensity):'';
    }
  }
  sourceTime(frame){return (this.identity.sourceStart+frame/this.identity.fps).toFixed(2)+'s';}
  message(text){if(this.status)this.status.textContent=text;}
  document(cues=this.cues){return {schemaVersion:1,...this.identity,cues};}
  persist(){
    try{localStorage.setItem(this.storageKey,JSON.stringify(this.document()));return true;}
    catch{this.message('Changes are available in this session, but browser storage failed. Export cues to keep a copy.');return false;}
  }
  changed(){this.update(this.frame,this.lastOptions);this.onChange();}
  refreshTargetOptions(){
    const target=this.fields.Target,striker=this.fields.Striker.value;
    for(const option of target.options)option.disabled=option.value===striker;
    if(target.value===striker)target.value=[...target.options].find(option=>!option.disabled)?.value||'';
  }
  updateIntensityLabel(){
    const value=this.fields.Intensity.value;this.intensityOutput.value=`${value} / 5 · chosen visual emphasis`;
    this.fields.Intensity.setAttribute('aria-valuetext',`${value} of 5, chosen visual emphasis, not measured force`);
  }
  startNew(){
    if(this.cues.length>=MAX_CUES){this.message(`This clip already has ${MAX_CUES} cues. Delete one before adding another.`);return;}
    if(this.motion.people.length<2){this.message('Strike illustrations need two participants.');return;}
    const first=String(this.motion.people[0].id),second=String(this.motion.people[1].id);
    this.openEditor({name:`Illustration ${this.cues.length+1}`,frame:this.frame,strikerId:first,limb:'right_wrist',
      targetId:second,targetJoint:this.motion.jointNames.includes('spine3')?'spine3':this.motion.jointNames[0],offset:[0,0,0],intensity:3,duration:0.8});
  }
  openEditor(cue){
    if(this.previewCue){this.previewCue=null;this.changed();}
    this.editingId=cue.id||null;this.form.hidden=false;
    this.formHeading.textContent=this.editingId?'Edit strike illustration':'New strike illustration';
    this.saveButton.textContent=this.editingId?'Update cue':'Save cue';
    const values={Name:cue.name,Frame:cue.frame,Striker:cue.strikerId,Limb:cue.limb,Target:cue.targetId,
      Joint:cue.targetJoint,Intensity:cue.intensity,Duration:cue.duration,OffsetX:cue.offset[0],OffsetY:cue.offset[1],OffsetZ:cue.offset[2]};
    for(const [key,value] of Object.entries(values))this.fields[key].value=String(value);
    this.refreshTargetOptions();this.updateIntensityLabel();this.fields.Name.focus();
  }
  closeEditor(){
    this.form.hidden=true;this.editingId=null;
    this.clearPreview();
  }
  clearPreview(){if(this.previewCue){this.previewCue=null;this.changed();}}
  readEditor(){
    const fields=this.fields;
    const cue={id:this.editingId||`cue_${globalThis.crypto?.randomUUID?.()||Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,10)}`,
      name:fields.Name.value.trim(),frame:Number(fields.Frame.value),strikerId:fields.Striker.value,limb:fields.Limb.value,
      targetId:fields.Target.value,targetJoint:fields.Joint.value,offset:['X','Y','Z'].map(axis=>Number(fields['Offset'+axis].value)),
      intensity:Number(fields.Intensity.value),duration:Number(fields.Duration.value)};
    return validateStrikeCueDocument(this.document([cue]),this.motion).cues[0];
  }
  saveEditor(){
    if(!this.form.reportValidity())return;
    try{
      const cue=this.readEditor(),index=this.cues.findIndex(item=>item.id===cue.id);
      if(index<0){if(this.cues.length>=MAX_CUES)throw Error(`This clip already has ${MAX_CUES} cues.`);this.cues.push(cue);}
      else this.cues[index]=cue;
      this.cues.sort((a,b)=>a.frame-b.frame);const saved=this.persist();this.closeEditor();this.renderList();this.changed();
      if(saved)this.message(`Saved “${cue.name}” in this browser. Export to share or back up your cues.`);
    }catch(error){this.message(error.message);}
  }
  previewEditor(){
    if(!this.form.reportValidity())return;
    try{
      // Unsaved drafts use a temporary overlay and never enter the saved cue list.
      const cue=this.readEditor();this.previewCue=cue;this.enabled=true;if(this.enabledInput)this.enabledInput.checked=true;
      this.preview(cue);this.changed();this.message('Previewing your illustration. Save the cue to keep it.');
    }catch(error){this.message(error.message);}
  }
  cueWindow(cue){
    const length=cue.duration*this.identity.fps;
    return {startFrame:Math.max(0,Math.floor(cue.frame-length*.65)),endFrame:Math.min(this.identity.frameCount-1,Math.ceil(cue.frame+length*.35))};
  }
  preview(cue){
    this.enabled=true;if(this.enabledInput)this.enabledInput.checked=true;
    this.onPlayPreview({...this.cueWindow(cue)});
  }
  renderList(){
    if(!this.list)return;this.list.replaceChildren();this.empty.hidden=this.cues.length>0;
    for(const cue of this.cues){
      const item=element('li','strike-item'),copy=element('div','strike-item-copy');
      const striker=this.motion.people.find(person=>String(person.id)===cue.strikerId),target=this.motion.people.find(person=>String(person.id)===cue.targetId);
      copy.append(element('strong','',cue.name),element('span','strike-item-meta',`${this.sourceTime(cue.frame)} · ${LIMBS.find(([joint])=>joint===cue.limb)?.[1]} → ${JOINT_LABELS[cue.targetJoint]||cue.targetJoint} · emphasis ${cue.intensity}/5`),
        element('span','strike-item-people',`${striker?.name||cue.strikerId} → ${target?.name||cue.targetId}`));
      const actions=element('div','strike-actions');
      const jump=button('Jump',()=>{this.previewCue=null;this.onSeek(cue.frame);});jump.setAttribute('aria-label',`Jump to ${cue.name}`);
      const preview=button('Preview',()=>{this.previewCue=null;this.preview(cue);this.changed();});preview.setAttribute('aria-label',`Preview ${cue.name}`);
      const edit=button('Edit',()=>this.openEditor(cue));edit.setAttribute('aria-label',`Edit ${cue.name}`);
      const remove=button('Delete',()=>{
        this.cues=this.cues.filter(item=>item.id!==cue.id);if(this.previewCue?.id===cue.id)this.previewCue=null;
        if(this.editingId===cue.id)this.closeEditor();const saved=this.persist();this.renderList();this.changed();
        if(saved)this.message(`Deleted “${cue.name}”.`);
      });remove.setAttribute('aria-label',`Delete ${cue.name}`);
      actions.append(jump,preview,edit,remove);item.append(copy,actions);item.dataset.cueId=cue.id;this.list.append(item);
    }
  }
  export(){
    const blob=new Blob([JSON.stringify(this.document(),null,2)+'\n'],{type:'application/json'}),url=URL.createObjectURL(blob);
    const link=element('a');link.href=url;link.download=`systema-strike-cues-${this.identity.sourceSha256.slice(0,12)}-${this.identity.sourceStart}-${this.identity.sourceEnd}.json`;
    document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
    this.message(`Exported ${this.cues.length} cue${this.cues.length===1?'':'s'} for this source clip.`);
  }
  async import(file){
    try{
      if(file.size>1024*1024)throw Error('Cue files must be smaller than 1 MB.');
      const imported=validateStrikeCueDocument(JSON.parse(await file.text()),this.motion).cues;
      // Merge by cue ID so importing an edited export updates it without silently removing other cues.
      const merged=new Map(this.cues.map(cue=>[cue.id,cue]));for(const cue of imported)merged.set(cue.id,cue);
      if(merged.size>MAX_CUES)throw Error(`Import would exceed this clip’s ${MAX_CUES}-cue limit.`);
      this.cues=[...merged.values()].sort((a,b)=>a.frame-b.frame);this.previewCue=null;this.closeEditor();
      const saved=this.persist();this.renderList();this.changed();
      if(saved)this.message(`Imported ${imported.length} cue${imported.length===1?'':'s'} and saved them in this browser.`);
    }catch(error){this.message(error instanceof SyntaxError?'This file is not valid JSON.':error.message);}
  }

  createVisual(id){
    const group=new THREE.Group();group.name=`Teaching cue ${id}`;
    const trajectory=new THREE.Line(new THREE.BufferGeometry(),new THREE.LineBasicMaterial({transparent:true,opacity:.8,depthWrite:false}));
    trajectory.geometry.setAttribute('position',new THREE.BufferAttribute(new Float32Array(33*3),3));
    const ring=new THREE.Mesh(new THREE.TorusGeometry(1,.035,8,40),new THREE.MeshBasicMaterial({transparent:true,depthWrite:false}));
    const pulse=new THREE.Mesh(new THREE.SphereGeometry(1,16,10),new THREE.MeshBasicMaterial({transparent:true,opacity:.1,depthWrite:false}));
    const bead=new THREE.Mesh(new THREE.SphereGeometry(1,12,8),new THREE.MeshBasicMaterial({transparent:true,depthWrite:false}));
    const arrow=new THREE.ArrowHelper(new THREE.Vector3(0,1,0),new THREE.Vector3(),.15,0xffad50,.07,.05);
    arrow.line.material.transparent=true;arrow.line.material.depthWrite=false;arrow.cone.material.transparent=true;arrow.cone.material.depthWrite=false;
    group.add(trajectory,ring,pulse,bead,arrow);this.group.add(group);
    const visual={group,trajectory,ring,pulse,bead,arrow};this.visuals.set(id,visual);return visual;
  }
  disposeVisual(visual){
    this.group.remove(visual.group);visual.group.traverse(object=>{object.geometry?.dispose();
      if(Array.isArray(object.material))object.material.forEach(material=>material.dispose());else object.material?.dispose();});
  }
  getHighlight(personId){return this.highlights.get(String(personId))||null;}
  tick(){/* All effects follow the selected video frame, including when playback is paused. */}
  update(frame,{visibleIds=this.lastOptions.visibleIds,xray=false}={}){
    this.frame=clamp(Math.round(Number(frame)||0),0,this.identity.frameCount-1);
    const ids=visibleIds instanceof Set?new Set([...visibleIds].map(String)):new Set((visibleIds||[]).map(String));
    this.lastOptions={visibleIds:ids,xray:Boolean(xray)};this.highlights.clear();this.group.visible=this.enabled;
    this.updateEstimates(ids);
    if(this.frameLabel)this.frameLabel.textContent=`Current frame ${this.frame} · source ${this.sourceTime(this.frame)}`;
    if(this.previewCue){
      const range=this.cueWindow(this.previewCue);
      if(this.frame<range.startFrame||this.frame>range.endFrame)this.previewCue=null;
    }
    const allCues=this.previewCue?[...this.cues.filter(cue=>cue.id!==this.previewCue.id),this.previewCue]:this.cues;
    const retained=new Set(allCues.map(cue=>cue.id));
    for(const [id,visual] of this.visuals){visual.group.visible=false;if(!retained.has(id)){this.disposeVisual(visual);this.visuals.delete(id);}}
    if(!this.enabled)return;
    const people=new Map((this.motion.frames[this.frame]?.people||[]).map(person=>[String(person.id),person]));
    for(const cue of allCues){
      const {startFrame,endFrame}=this.cueWindow(cue);
      if(this.frame<startFrame||this.frame>endFrame||!ids.has(cue.strikerId)||!ids.has(cue.targetId))continue;
      const striker=people.get(cue.strikerId),target=people.get(cue.targetId);
      const sourceJoint=this.motion.jointNames.indexOf(cue.limb),targetJoint=this.motion.jointNames.indexOf(cue.targetJoint);
      const sourceXYZ=striker?.xyz?.[sourceJoint],targetXYZ=target?.xyz?.[targetJoint];
      if(!sourceXYZ?.every(Number.isFinite)||!targetXYZ?.every(Number.isFinite))continue;
      const start=new THREE.Vector3(...sourceXYZ),end=new THREE.Vector3(...targetXYZ).add(new THREE.Vector3(...cue.offset));
      const direction=end.clone().sub(start),length=direction.length();if(length<.005)continue;
      const visual=this.visuals.get(cue.id)||this.createVisual(cue.id);visual.group.visible=true;
      const color=COLORS[cue.intensity-1],progress=(this.frame-startFrame)/Math.max(1,endFrame-startFrame);
      const impact=(cue.frame-startFrame)/Math.max(1,endFrame-startFrame),travel=clamp(progress/Math.max(.01,impact),0,1);
      const curveControl=start.clone().lerp(end,.5).add(new THREE.Vector3(0,-Math.min(.18,length*.1),0));
      const curve=new THREE.QuadraticBezierCurve3(start,curveControl,end),array=visual.trajectory.geometry.attributes.position.array;
      for(let index=0;index<=32;index++){const point=curve.getPoint(index/32);point.toArray(array,index*3);}
      visual.trajectory.geometry.attributes.position.needsUpdate=true;visual.trajectory.geometry.computeBoundingSphere();
      const radius=.045+cue.intensity*.016,impactPulse=progress>=impact?Math.sin(clamp((progress-impact)/Math.max(.01,1-impact),0,1)*Math.PI):0;
      visual.ring.position.copy(end);visual.ring.lookAt(start);visual.ring.scale.setScalar(radius*(1+impactPulse*.65));
      visual.ring.material.opacity=.65+impactPulse*.35;
      visual.pulse.position.copy(end);visual.pulse.scale.setScalar(radius*(.75+impactPulse*.7));visual.pulse.material.opacity=.08+impactPulse*.17;
      visual.bead.position.copy(curve.getPoint(travel));visual.bead.scale.setScalar(.012+cue.intensity*.004);visual.bead.material.opacity=travel<1?1:.25;
      const tipDirection=end.clone().sub(curve.getPoint(.93)).normalize(),arrowLength=Math.min(.18,length*.3);
      visual.arrow.position.copy(end).addScaledVector(tipDirection,-arrowLength);visual.arrow.setDirection(tipDirection);visual.arrow.setLength(arrowLength,Math.min(.07+cue.intensity*.005,arrowLength*.6),.035+cue.intensity*.004);visual.arrow.setColor(color);
      visual.group.traverse(object=>{
        if(object.material){object.material.color?.set(color);object.material.depthTest=!xray;object.material.depthWrite=false;object.renderOrder=xray?1003:3;}
      });
      for(const [id,joint,jointName,role] of [[cue.strikerId,sourceJoint,cue.limb,'striker'],[cue.targetId,targetJoint,cue.targetJoint,'target']]){
        if((this.highlights.get(id)?.intensity||0)<=cue.intensity)this.highlights.set(id,{joint,jointName,intensity:cue.intensity,color,role});
      }
    }
  }
  dispose(){
    for(const visual of this.visuals.values())this.disposeVisual(visual);this.visuals.clear();
    for(const visual of this.estimatedVisuals.values())visual.group.traverse(object=>{object.geometry?.dispose();object.material?.dispose();});
    this.estimatedVisuals.clear();this.activeEstimates=[];this.estimatedGroup.removeFromParent();this.group.removeFromParent();this.container?.replaceChildren();
  }
}

import * as THREE from 'three';
import {OrbitControls} from './vendor/three/OrbitControls.js';
import {findBoneContacts} from './contact_geometry.mjs';
import {StudioEnvironment} from './studio-environment.js';
import {StudioLighting} from './studio-lighting.js';
import {FigureRig} from './figure-rig.js';
import {StrikeCues,strikeConfidenceLabel} from './strike-cues.js';
import {resolveStrikeLanding} from './strike-placement.js';
import {ModelLibrary} from './model-library.js';
import {ContactShadows} from './contact-shadows.js';
let studioEnvironment=null;
let studioLighting=null;
let contactShadows=null;
let modelLibrary=null, modelsRestoring=true;
let refreshFigureChoices=()=>{};
let strikeCues=null, teachingPreviewEnd=null, figureStorageKey='';
let strikeAnchorsReady=false;
let characterNamesKey='';
const figureStyles={skeleton:'Line skeleton',bones:'Solid skeleton',mannequin:'Rigged mannequin',dummy:'Training dummy'};
let figureSettings={defaultStyle:'mannequin',participants:{}};
const isModelStyle=value=>typeof value==='string'&&/^model:[a-zA-Z0-9_-]{1,100}$/.test(value);
const validStyle=value=>Object.hasOwn(figureStyles,value)||isModelStyle(value);
const selectedStyle=id=>figureSettings.participants[String(id)]||figureSettings.defaultStyle;
function effectiveStyle(id){const value=selectedStyle(id);return isModelStyle(value)&&!modelLibrary?.hasReady(value.slice(6))?'mannequin':value;}

const $=id=>document.getElementById(id), video=$('sceneVideo'), scrub=$('sceneScrub');
function toggleDebug(open=$('debugMenu').hidden){
  $('debugMenu').hidden=!open;$('debugToggle').setAttribute('aria-expanded',String(open));
  if(!open&&contactSettings.enabled){$('contactEffects').checked=false;changeContactSettings();}
  (open?$('debugClose'):$('debugToggle')).focus({preventScroll:true});
}
$('debugToggle').addEventListener('click',()=>toggleDebug());
$('debugClose').addEventListener('click',()=>toggleDebug(false));
document.addEventListener('keydown',event=>{
  if(event.repeat||event.ctrlKey||event.metaKey||event.altKey||event.shiftKey||event.target.closest('input,textarea,select,[contenteditable]'))return;
  if(event.key==='`'||event.code==='Backquote'){event.preventDefault();toggleDebug();}
  else if(event.key==='Escape'&&!$('debugMenu').hidden){event.preventDefault();toggleDebug(false);}
});
const palette=['#ffc45f','#7bc7ed','#bda4ee','#94d8b8','#f29d91','#dfc688'];
let motion=null, frame=0, renderer, world, camera, orbit, objects=new Map(), center, extent=4;
let contactMarkers, markerPool=[], contactSettings={enabled:false,radius:0.02};
let displayedFrameSignature='';
let sourceFollowing=false;
// Keep normal depth testing within the characters. Drawing the foreground in
// a second pass lets it show through the room without turning overlapping body
// surfaces into a camera-dependent stack of transparent meshes.
function renderSceneFrame(){
  studioLighting?.sync(studioEnvironment);
  if(!(studioEnvironment?.ready&&studioEnvironment?.visible&&studioEnvironment?.xray)){
    renderer.render(world,camera);return;
  }
  const foreground=world.children.filter(child=>child.userData.figureOverlay);
  const foregroundVisibility=foreground.map(child=>child.visible);
  const environment=world.children.filter(child=>!child.isLight&&!child.userData.figureOverlay);
  const environmentVisibility=environment.map(child=>child.visible);
  const background=world.background,autoClear=renderer.autoClear;
  try{
    foreground.forEach(child=>{child.visible=false;});
    renderer.render(world,camera);
    foreground.forEach((child,index)=>{child.visible=foregroundVisibility[index];});
    environment.forEach(child=>{child.visible=false;});
    renderer.autoClear=false;world.background=null;renderer.clearDepth();
    renderer.render(world,camera);
  }finally{
    foreground.forEach((child,index)=>{child.visible=foregroundVisibility[index];});
    environment.forEach((child,index)=>{child.visible=environmentVisibility[index];});
    renderer.autoClear=autoClear;world.background=background;
  }
}
let sourceAspect=16/9;
const sourceRotation=new THREE.Matrix4();
function hasSourceCamera(){
  const data=motion?.camera;
  return Boolean(data?.Rcw?.length===frameCount&&data?.Tcw?.length===frameCount&&
    Number.isFinite(data.img_focal)&&data.img_focal>0&&data.img_center?.length===2&&data.img_center.every(value=>Number.isFinite(value)&&value>0));
}
function setCameraButtons(name){
  document.querySelectorAll('[data-camera]').forEach(button=>{
    const active=button.dataset.camera===name;button.classList.toggle('active',active);button.setAttribute('aria-pressed',String(active));
  });
  $('orbitStage').dataset.cameraMode=name||'orbit';
}
function updateCameraProjection(){
  camera.aspect=sourceAspect;
  if(sourceFollowing&&hasSourceCamera()){
    const data=motion.camera,[cx,cy]=data.img_center,focal=data.img_focal;
    const width=data.imageWidth||data.img_width||data.width||cx*2,height=data.imageHeight||data.img_height||data.height||cy*2;
    camera.fov=THREE.MathUtils.radToDeg(2*Math.atan(height/(2*focal)));
    camera.updateProjectionMatrix();
    // Preserve the reconstruction intrinsics, including a noncentral principal point.
    const projection=camera.projectionMatrix.elements;
    projection[0]=2*focal/width;projection[5]=2*focal/height;
    projection[8]=1-2*cx/width;projection[9]=2*cy/height-1;
    camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
  }else camera.updateProjectionMatrix();
}
function followSourceCamera(){
  if(!sourceFollowing||!hasSourceCamera())return;
  const r=motion.camera.Rcw[frame],t=motion.camera.Tcw[frame];
  // Rcw maps world coordinates to the CV camera (+Y down, +Z forward).
  // Three uses +Y up and looks along -Z, so its pose is Rcw.T * diag(1,-1,-1).
  camera.position.set(-(r[0][0]*t[0]+r[1][0]*t[1]+r[2][0]*t[2]),
    -(r[0][1]*t[0]+r[1][1]*t[1]+r[2][1]*t[2]),-(r[0][2]*t[0]+r[1][2]*t[1]+r[2][2]*t[2]));
  sourceRotation.set(r[0][0],-r[1][0],-r[2][0],0,r[0][1],-r[1][1],-r[2][1],0,
    r[0][2],-r[1][2],-r[2][2],0,0,0,0,1);
  camera.up.set(0,1,0);camera.quaternion.setFromRotationMatrix(sourceRotation);
  camera.updateMatrixWorld(true);updateCameraProjection();
  orbit.target.copy(camera.position).add(new THREE.Vector3(0,0,-Math.max(2,extent/2)).applyQuaternion(camera.quaternion));
  renderer.domElement.dataset.sourceCameraFrame=String(frame);
}
function resizeSceneCanvas(){
  const stage=$('orbitStage'),width=stage.clientWidth,height=stage.clientHeight;
  if(!renderer||!width||!height)return;
  const fittedWidth=Math.min(width,height*sourceAspect),fittedHeight=fittedWidth/sourceAspect;
  renderer.setSize(Math.max(1,Math.round(fittedWidth)),Math.max(1,Math.round(fittedHeight)),false);
  renderer.domElement.style.width=`${fittedWidth}px`;renderer.domElement.style.height=`${fittedHeight}px`;
  updateCameraProjection();
}
const contactStorageKey='systema-contact-effects-v1';
try{
  const saved=JSON.parse(localStorage.getItem(contactStorageKey));
  if(saved && [0.02,0.035,0.05].includes(saved.radius))contactSettings.radius=saved.radius;
}catch{}
$('contactEffects').checked=contactSettings.enabled;
$('boneThickness').value=String(contactSettings.radius);
$('boneThickness').disabled=!contactSettings.enabled;
$('contactDetails').open=contactSettings.enabled;
function changeContactSettings(){
  contactSettings={enabled:$('contactEffects').checked,radius:Number($('boneThickness').value)};
  $('boneThickness').disabled=!contactSettings.enabled;
  try{localStorage.setItem(contactStorageKey,JSON.stringify(contactSettings));}catch{}
  showFrame(frame);
}
$('contactEffects').addEventListener('change',changeContactSettings);
$('boneThickness').addEventListener('change',changeContactSettings);
const site=window.SystemaSite;
let sourceStart=18, sourceEnd=30, fps=30, frameCount=360, siteLesson=null;
const sceneStorageKey='systema-scene-view-v1';
let sceneView=innerWidth<=600?'scene':'compare';
try{const saved=localStorage.getItem(sceneStorageKey);if(['scene','video','compare'].includes(saved))sceneView=saved;}catch{}
function fitSceneViewports(){
  const main=document.querySelector('.scene-main');
  if(!matchMedia('(min-width:901px) and (min-height:580px)').matches){
    main.style.removeProperty('--scene-stage-height');return;
  }
  const grid=$('sceneGrid');
  const toolbarHeight=Math.max(...[...grid.querySelectorAll('.view-toolbar')]
    .filter(toolbar=>toolbar.getClientRects().length).map(toolbar=>toolbar.getBoundingClientRect().height));
  const available=innerHeight-(grid.getBoundingClientRect().top+scrollY)-toolbarHeight-$('sceneTransport').offsetHeight-30;
  main.style.setProperty('--scene-stage-height',`${Math.max(200,Math.min(620,Math.floor(available)))}px`);
}
function applySceneView(value){
  sceneView=value;
  $('scenePanel').hidden=value==='video';$('sceneFootagePanel').hidden=value==='scene';
  $('sceneDetailsPanel').hidden=value==='video';
  document.querySelector('.viewer-sync-label').hidden=value!=='compare'||!motion;
  $('orbitHelp').hidden=value==='video';$('sceneGrid').classList.toggle('single-view',value!=='compare');
  document.querySelectorAll('[data-scene-view]').forEach(button=>{
    const active=button.dataset.sceneView===value;button.classList.toggle('active',active);button.setAttribute('aria-pressed',String(active));
  });
  try{localStorage.setItem(sceneStorageKey,value);}catch{}
  fitSceneViewports();
}
document.querySelectorAll('[data-scene-view]').forEach(button=>button.addEventListener('click',()=>applySceneView(button.dataset.sceneView)));
document.querySelectorAll('.lesson-return').forEach(link=>link.addEventListener('click',()=>{link.href=site&&siteLesson ? site.link('lesson.html',siteLesson.id,frame) : `/?demo=1&frame=${frame}`;}));
applySceneView(sceneView);
window.addEventListener('resize',fitSceneViewports);
const layoutObserver=new ResizeObserver(fitSceneViewports);
document.querySelectorAll('.scene-heading,.scene-view-controls,.scene-grid .view-toolbar,#sceneTransport').forEach(element=>layoutObserver.observe(element));
const entryFrame=Number(new URLSearchParams(location.search).get('frame'));
if(!site&&Number.isInteger(entryFrame)&&entryFrame>=0&&entryFrame<frameCount){
  if(video.readyState>=1)seek(entryFrame);
  else video.addEventListener('loadedmetadata',()=>seek(entryFrame),{once:true});
}

function sceneUnavailable(){
  applySceneView('video');
  $('contactEffects').disabled=true;$('boneThickness').disabled=true;
  $('contactStatus').textContent='Contact effects need a reconstructed 3D scene.';
  document.querySelectorAll('[data-scene-view]').forEach(button=>{button.disabled=button.dataset.sceneView!=='video';});
}

function showFrame(index){
  if(teachingPreviewEnd!==null&&index>=teachingPreviewEnd){
    index=teachingPreviewEnd;video.pause();
    if(video.currentTime>index/fps+1/fps)video.currentTime=index/fps;
  }
  frame=Math.max(0,Math.min(frameCount-1,index));scrub.value=frame;
  $('sceneTime').textContent=`${(sourceStart+frame/fps).toFixed(3)}s`;
  scrub.setAttribute('aria-valuetext',`${(sourceStart+frame/fps).toFixed(3)} source seconds`);
  if(!motion)return;
  followSourceCamera();
  const signature=JSON.stringify([frame,contactSettings,figureSettings,studioEnvironment?.ready&&studioEnvironment?.visible,studioEnvironment?.xray,[...objects.values()].map(object=>object.checkbox.checked)]);
  if(signature===displayedFrameSignature)return;
  displayedFrameSignature=signature;
  const xray=Boolean(studioEnvironment?.ready&&studioEnvironment?.visible&&studioEnvironment?.xray);
  strikeAnchorsReady=false;
  strikeCues?.update(frame,{visibleIds:new Set([...objects].filter(([,object])=>object.checkbox.checked).map(([id])=>id)),xray});
  for(const object of objects.values())object.group.visible=false;
  for(const person of motion.frames[frame].people){
    const object=objects.get(String(person.id));if(!object)continue;
    object.group.visible=object.checkbox.checked;
    // Tracking confidence belongs in the quality label. Abruptly changing the
    // skin's opacity on overlap flags made complete figures blink and switch
    // between Three's opaque/transparent render queues during playback.
    const opacity=1;
    object.bones.material.opacity=opacity;object.joints.material.opacity=opacity;
    const positions=[];
    for(const [a,b] of motion.edges)positions.push(...person.xyz[a],...person.xyz[b]);
    object.bones.geometry.attributes.position.array.set(positions);
    object.bones.geometry.attributes.position.needsUpdate=true;
    object.bones.geometry.computeBoundingSphere();
    object.joints.geometry.attributes.position.array.set(person.xyz.flat());
    object.joints.geometry.attributes.position.needsUpdate=true;
    object.joints.geometry.computeBoundingSphere();
    let style=effectiveStyle(person.id);
    const customId=isModelStyle(style)?style.slice(6):null;
    let customRig=null;
    for(const rig of object.customRigs.values())rig.group.visible=false;
    if(customId){
      try{
        if(!object.customRigs.has(customId)){
          const rig=modelLibrary.get(customId).createInstance({jointNames:motion.jointNames,edges:motion.edges,color:object.color});
          object.customRigs.set(customId,rig);object.group.add(rig.group);
        }
        customRig=object.customRigs.get(customId);
      }catch(error){
        figureSettings.participants[String(person.id)]='mannequin';style='mannequin';
        modelLibrary.setStatus(`This model could not be animated: ${error.message}`,true);
        queueMicrotask(()=>refreshFigureChoices());
      }
    }
    const builtinRig=style==='mannequin'||style==='dummy';
    const rigged=builtinRig||Boolean(customRig);
    object.activeRigged=rigged;
    const solidVisible=!rigged&&(style==='bones'||contactSettings.enabled);
    object.bones.visible=!rigged&&!solidVisible;object.joints.visible=!rigged&&!solidVisible;
    object.solid.visible=solidVisible||contactSettings.enabled;
    const radius=contactSettings.enabled?contactSettings.radius:.014;
    object.rig.group.visible=builtinRig;
    const highlight=strikeCues?.getHighlight(person.id);
    if(builtinRig){
      object.rig.setStyle(style);
      object.rig.update(person.xyz,{color:object.color,opacity,xray:false,highlightJoint:highlight?.joint,intensity:(highlight?.intensity||0)/5});
    }
    if(customRig){
      customRig.group.visible=true;
      customRig.update(person.xyz,{opacity,xray:false,highlightJoint:highlight?.joint,intensity:(highlight?.intensity||0)/5});
      object.customUpdates.set(customId,(object.customUpdates.get(customId)||0)+1);
    }
    object.bones.material.depthTest=true;object.joints.material.depthTest=true;
    object.bones.renderOrder=0;object.joints.renderOrder=0;
    for(const mesh of [...object.solidBones,...object.solidJoints]){
      mesh.renderOrder=rigged&&contactSettings.enabled?1002:0;
      mesh.material.depthTest=true;mesh.material.depthWrite=true;
    }
    for(let bone=0;bone<motion.edges.length;bone++){
      const [a,b]=motion.edges[bone], start=new THREE.Vector3(...person.xyz[a]), end=new THREE.Vector3(...person.xyz[b]);
      const delta=end.clone().sub(start), mesh=object.solidBones[bone], length=delta.length();
      mesh.position.copy(start).add(end).multiplyScalar(.5);
      mesh.scale.set(radius,length,radius);
      mesh.visible=!rigged&&length>1e-8;
      if(length>1e-8)mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0),delta.divideScalar(length));
      mesh.material.color.set(object.color);mesh.material.opacity=opacity;
    }
    person.xyz.forEach((xyz,joint)=>{
      const mesh=object.solidJoints[joint];mesh.position.set(...xyz);mesh.scale.setScalar(radius);
      mesh.visible=!rigged;
      mesh.material.color.set(object.color);mesh.material.opacity=opacity;
    });
  }
  strikeAnchorsReady=true;
  strikeCues?.refreshEstimatedLandings();
  const activeEstimates=strikeCues?.getActiveEstimates()||[];
  const nearestEstimate=activeEstimates.reduce((best,event)=>!best||Math.abs(event.frame-frame)<Math.abs(best.frame-frame)?event:best,null);
  $('strikeEstimateHud').hidden=!nearestEstimate;
  if(nearestEstimate){
    $('strikeEstimateLabel').textContent=`Likely ${nearestEstimate.region.toLowerCase()} strike`;
    $('strikeEstimateIntensity').textContent=`Relative intensity ${nearestEstimate.intensity}/5 · ${strikeConfidenceLabel(nearestEstimate.confidence).toLowerCase()}`;
  }
  const people=motion.frames[frame].people;
  contactShadows?.update(people,new Set([...objects].filter(([,object])=>object.group.visible).map(([id])=>id)));
  const gaps=people.filter(p=>p.sourceBoxInterpolated).length;
  const overlap=people.some(p=>p.overlappingSourceBoxes?.length);
  const missing=motion.people.length-people.length;
  const quality=gaps?`${gaps} pose${gaps===1?'':'s'} uses an interpolated tracking box. Check the footage; contact is unverified.`:overlap?'People overlap in the footage. Poses may follow the wrong limbs; contact is unverified.':'Depth and contact are estimates. Compare the poses with the footage.';
  $('frameQuality').textContent=quality+(missing?` ${missing} participant${missing===1?' has':'s have'} no captured pose at this moment.`:'');
  showContacts();
  renderer.domElement.dataset.figureStyles=JSON.stringify(Object.fromEntries([...objects.keys()].map(id=>[id,effectiveStyle(id)])));
  renderer.domElement.dataset.rigCount=String([...objects].filter(([id,object])=>object.group.visible&&(['mannequin','dummy'].includes(effectiveStyle(id))||isModelStyle(effectiveStyle(id)))).length);
  const customUpdates=Object.fromEntries([...objects].filter(([id,object])=>object.group.visible&&isModelStyle(effectiveStyle(id))).map(([id,object])=>[id,{modelId:effectiveStyle(id).slice(6),lastUpdate:object.customUpdates.get(effectiveStyle(id).slice(6))||0}]));
  renderer.domElement.dataset.customModelCount=String(Object.keys(customUpdates).length);
  renderer.domElement.dataset.customModelUpdates=JSON.stringify(customUpdates);
  renderer.domElement.dataset.strikeCueCount=String(strikeCues?.group.children.filter(child=>child.visible).length||0);
  renderer.domElement.dataset.estimatedStrikeCount=String(activeEstimates.length);
}
function showContacts(){
  contactMarkers.visible=contactSettings.enabled;
  markerPool.forEach(marker=>{marker.visible=false;});
  $('contactList').replaceChildren();
  const visible=motion.frames[frame].people.filter(person=>objects.get(String(person.id))?.checkbox.checked);
  const contacts=contactSettings.enabled ? findBoneContacts(visible,motion.edges,contactSettings.radius) : [];
  $('contactStatus').dataset.count=String(contacts.length);
  $('contactStatus').dataset.frame=String(frame);
  $('contactStatus').textContent=!contactSettings.enabled ? 'Turn on contact effects to highlight intersecting 3D bones.'
    : contacts.length ? `${contacts.length} intersecting bone pair${contacts.length===1?'':'s'} at this moment.`
    : 'No bone intersections between the visible participants at this moment.';
  const clusters=[], pairs=new Map();
  for(const contact of contacts){
    for(const [id,bone] of [[contact.personA,contact.boneA],[contact.personB,contact.boneB]]){
      const object=objects.get(id);object.solidBones[bone].material.color.set('#ffe17a');object.solidBones[bone].visible=true;
      motion.edges[bone].forEach(joint=>{object.solidJoints[joint].material.color.set('#ffe17a');object.solidJoints[joint].visible=true;});
    }
    const key=contact.personA+':'+contact.personB;
    pairs.set(key,(pairs.get(key)||0)+1);
    if(!clusters.some(other=>other.personA===contact.personA && other.personB===contact.personB &&
        Math.hypot(...other.point.map((value,axis)=>value-contact.point[axis]))<contactSettings.radius*2))clusters.push(contact);
  }
  clusters.forEach((contact,index)=>{
    if(!markerPool[index]){
      const marker=new THREE.Mesh(new THREE.SphereGeometry(1,12,8),new THREE.MeshBasicMaterial({color:'#ffad42',transparent:true,opacity:.45,depthWrite:false}));
      contactMarkers.add(marker);markerPool.push(marker);
    }
    const marker=markerPool[index];marker.renderOrder=studioEnvironment?.xray?1001:0;marker.material.depthTest=!(studioEnvironment?.ready&&studioEnvironment?.visible&&studioEnvironment?.xray);marker.visible=true;marker.position.set(...contact.point);marker.scale.setScalar(contactSettings.radius*1.8);
  });
  for(const [pair,count] of pairs){
    const names=pair.split(':').map(id=>motion.people.find(person=>String(person.id)===id).name);
    const item=document.createElement('li');item.textContent=`${names.join(' ↔ ')} · ${count} bone pair${count===1?'':'s'}`;
    $('contactList').append(item);
  }
}
function clearTeachingPreview(){teachingPreviewEnd=null;$('scenePlaybackScope').textContent='Full clip';$('sceneFullPlayback').hidden=true;}
function seek(index){clearTeachingPreview();video.pause();video.currentTime=Math.max(0,Math.min(frameCount-1,index))/fps;showFrame(index);}
$('sceneFullPlayback').addEventListener('click',()=>{clearTeachingPreview();video.play().catch(()=>{$('sceneStatus').textContent='Tap Play to continue the footage.';});});
scrub.addEventListener('input',()=>seek(Number(scrub.value)));
$('scenePrevious').addEventListener('click',()=>seek(frame-1));
$('sceneNext').addEventListener('click',()=>seek(frame+1));
$('sceneSpeed').addEventListener('change',()=>video.playbackRate=Number($('sceneSpeed').value));
video.addEventListener('timeupdate',()=>showFrame(Math.floor(video.currentTime*fps+0.001)));
video.addEventListener('seeked',()=>showFrame(Math.floor(video.currentTime*fps+0.001)));
$('scenePlay').addEventListener('click',async()=>{
  if(!video.paused){video.pause();return;}
  if(teachingPreviewEnd===null||frame>=teachingPreviewEnd)clearTeachingPreview();
  try{if(video.ended)seek(0);await video.play();}catch{$('sceneStatus').textContent='Tap Play again to start the footage.';}
});
function playbackIcon(){
  const playing=!video.paused&&!video.ended;
  $('scenePlay').innerHTML=playing
    ? '<svg class="control-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14M16 5v14" stroke-width="3"/></svg>'
    : '<svg class="control-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m8 5 11 7-11 7Z" fill="currentColor" stroke="none"/></svg>';
  const label=playing?'Pause movement':'Play movement';
  $('scenePlay').setAttribute('aria-label',label);$('scenePlay').title=label;
}
function audioIcon(){
  const muted=video.muted||video.volume===0;
  $('sceneMute').innerHTML=muted
    ? '<svg class="control-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m11 5-6 4H2v6h3l6 4Zm5 4 6 6m0-6-6 6"/></svg>'
    : '<svg class="control-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m11 5-6 4H2v6h3l6 4Zm4 3a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/></svg>';
  const label=muted?'Unmute source audio':'Mute source audio';
  $('sceneMute').setAttribute('aria-label',label);$('sceneMute').setAttribute('aria-pressed',String(muted));$('sceneMute').title=label;
}
$('sceneMute').addEventListener('click',()=>{
  if(video.muted||video.volume===0){video.muted=false;if(video.volume===0)video.volume=1;}
  else video.muted=true;
});
video.addEventListener('play',playbackIcon);
video.addEventListener('pause',playbackIcon);
video.addEventListener('ended',playbackIcon);
video.addEventListener('volumechange',audioIcon);
function showVideoError(){
  $('sceneStatus').textContent='Source footage could not load. Reload the lesson to try again.';
  $('sceneStatus').classList.remove('ready');
}
video.addEventListener('error',showVideoError);
playbackIcon();audioIcon();
document.addEventListener('keydown',event=>{
  if(video.readyState<1||/INPUT|TEXTAREA|SELECT|BUTTON|A|SUMMARY/.test(document.activeElement?.tagName))return;
  if(event.code==='Space'){event.preventDefault();$('scenePlay').click();}
  if(event.code==='ArrowLeft'||event.code==='ArrowRight'){
    event.preventDefault();$(event.code==='ArrowLeft'?'scenePrevious':'sceneNext').click();
  }
});
function sync(){if(!video.paused)showFrame(Math.floor(video.currentTime*fps+0.001));requestAnimationFrame(sync);}sync();

function preset(name){
  if(name==='source'&&hasSourceCamera()){
    // Flush an unfinished orbit gesture before applying the exact tracked pose.
    const damping=orbit.enableDamping;orbit.enableDamping=false;orbit.update();orbit.enableDamping=damping;
    sourceFollowing=true;followSourceCamera();setCameraButtons('source');return;
  }
  sourceFollowing=false;camera.fov=48;updateCameraProjection();
  const bounds=new THREE.Box3();
  for(const person of motion.frames[frame].people)for(const xyz of person.xyz)bounds.expandByPoint(new THREE.Vector3(...xyz));
  const focus=bounds.isEmpty()?center:bounds.getCenter(new THREE.Vector3());
  const size=bounds.isEmpty()?extent:Math.max(2,bounds.getSize(new THREE.Vector3()).length());
  const distance=size*1.25;
  camera.up.set(0,1,0);orbit.target.copy(focus);
  if(name==='side')camera.position.copy(focus).add(new THREE.Vector3(distance,0.3*size,0));
  else if(name==='overhead'){camera.position.copy(focus).add(new THREE.Vector3(0,distance,0.001));camera.up.set(0,0,-1);}
  else camera.position.copy(focus).add(new THREE.Vector3(0,0.2*size,distance));
  camera.lookAt(focus);orbit.update();
  setCameraButtons(name);
}
function validate(data){
  if(data.coordinateSpace!=='world-3d'||data.units!=='model-meters'||data.upAxis!=='y')throw Error('Unsupported scene coordinates.');
  if(data.sourceStart!==sourceStart||data.sourceEnd!==sourceEnd||Math.abs(data.fps-fps)>0.001||data.frames.length!==frameCount)throw Error('Scene timing does not match this clip.');
  if(!data.people.length||!data.jointNames.length)throw Error('No reconstructed participants are available.');
  const ids=new Set(data.people.map(p=>String(p.id))), count=data.jointNames.length;
  if(ids.size!==data.people.length)throw Error('Duplicate participant identities.');
  if(!data.edges.every(e=>e.length===2&&e.every(i=>Number.isInteger(i)&&i>=0&&i<count)))throw Error('Invalid skeleton topology.');
  for(let i=0;i<data.frames.length;i++){
    if(data.frames[i].frame!==i)throw Error('Scene frames are out of order.');
    const seen=new Set();
    for(const p of data.frames[i].people){
      if(!ids.has(String(p.id))||seen.has(String(p.id))||p.xyz.length!==count||!p.xyz.every(v=>v.length===3&&v.every(Number.isFinite)))throw Error('Invalid reconstructed joint data.');
      seen.add(String(p.id));
    }
  }
}
async function load(){
  try{
    if(site){
      siteLesson=await site.lesson();
      sourceStart=siteLesson.sourceStart;sourceEnd=siteLesson.sourceEnd;fps=siteLesson.fps;
      frameCount=Math.ceil((sourceEnd-sourceStart)*fps-1e-7);scrub.max=String(frameCount-1);
      document.querySelector('h1').textContent=siteLesson.title;
      document.querySelector('.lesson-heading .eyebrow').textContent=`${siteLesson.category.toUpperCase()} · 3D SCENE`;
      document.querySelectorAll('.lesson-return').forEach(link=>{link.href=site.link('lesson.html',siteLesson.id);});
      video.src=siteLesson.video;
      if(Number.isInteger(entryFrame)&&entryFrame>=0&&entryFrame<frameCount){
        if(video.readyState>=1)seek(entryFrame);
        else video.addEventListener('loadedmetadata',()=>seek(entryFrame),{once:true});
      }
      if(!siteLesson.scene)throw Error('This clip has 2D motion only. Return to the lesson to study it.');
    }
    const response=await fetch(site?siteLesson.scene:'/3d-pilot/scene.json',{cache:'no-store'});
    if(response.status===404){$('sceneStatus').textContent='The shared 3D reconstruction is not ready yet. You can review the current footage here.';sceneUnavailable();return;}
    if(!response.ok)throw Error('Scene could not be loaded.');
    const data=await response.json();validate(data);
    const manifest=await (await fetch(site?siteLesson.manifest:'/3d-pilot/manifest.json',{cache:'no-store'})).json();
    if(data.sourceSha256!==manifest.sha256)throw Error('Scene and footage do not match.');
    const expected=manifest.reconstruction?.expectedParticipants;
    if(Number.isInteger(expected)&&data.people.length!==expected)throw Error(`The scene is being extended to all ${expected} participants.`);
    motion=data;
    characterNamesKey=`systema-character-names-v1:${data.sourceSha256}`;
    let names={};try{const saved=JSON.parse(localStorage.getItem(characterNamesKey));if(saved&&typeof saved==='object'&&!Array.isArray(saved))names=saved;}catch{}
    for(const person of motion.people){
      person.originalName=person.name;
      const alias=names[String(person.id)];
      if(typeof alias==='string'&&alias.trim()&&alias.length<=48&&!/[\u0000-\u001f\u007f]/.test(alias))person.name=alias.trim();
    }
    figureStorageKey=`systema-figures-v1:${data.sourceSha256}`;
    try{
      const saved=JSON.parse(localStorage.getItem(figureStorageKey));
      if(saved&&validStyle(saved.defaultStyle)&&saved.participants&&typeof saved.participants==='object'){
        figureSettings={defaultStyle:saved.defaultStyle,participants:Object.fromEntries(Object.entries(saved.participants).filter(([id,style])=>data.people.some(person=>String(person.id)===id)&&validStyle(style)))};
      }
    }catch{}
    if(motion.camera?.img_center?.every(value=>Number.isFinite(value)&&value>0))sourceAspect=motion.camera.img_center[0]/motion.camera.img_center[1];
    const stage=$('orbitStage');world=new THREE.Scene();world.background=new THREE.Color('#142234');
    studioLighting=new StudioLighting(world);
    contactShadows=new ContactShadows({world,motion});
    contactMarkers=new THREE.Group();contactMarkers.userData.figureOverlay=true;world.add(contactMarkers);
    renderer=new THREE.WebGLRenderer({antialias:false});renderer.setPixelRatio(Math.min(devicePixelRatio,2));
    renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1;
    camera=new THREE.PerspectiveCamera(48,1,0.01,1000);stage.append(renderer.domElement);
    orbit=new OrbitControls(camera,renderer.domElement);orbit.enableDamping=true;
    orbit.addEventListener('start',()=>{sourceFollowing=false;setCameraButtons(null);});
    const bounds=new THREE.Box3();
    for(const f of motion.frames)for(const p of f.people)for(const xyz of p.xyz)bounds.expandByPoint(new THREE.Vector3(...xyz));
    if(bounds.isEmpty())throw Error('Scene contains no visible joints.');
    center=bounds.getCenter(new THREE.Vector3());extent=Math.max(2,bounds.getSize(new THREE.Vector3()).length());
    const grid=new THREE.GridHelper(Math.ceil(extent*3),Math.ceil(extent*3),'#537087','#2d4054');grid.position.set(center.x,0,center.z);world.add(grid);
    const cylinderGeometry=new THREE.CylinderGeometry(1,1,1,10), sphereGeometry=new THREE.SphereGeometry(1,12,8);
    for(let index=0;index<motion.people.length;index++){
      const person=motion.people[index], color=person.color||palette[index%palette.length], group=new THREE.Group();
      group.userData.figureOverlay=true;
      const bones=new THREE.LineSegments(new THREE.BufferGeometry(),new THREE.LineBasicMaterial({color,transparent:true}));
      const joints=new THREE.Points(new THREE.BufferGeometry(),new THREE.PointsMaterial({color,size:0.035,transparent:true}));
      bones.geometry.setAttribute('position',new THREE.BufferAttribute(new Float32Array(motion.edges.length*6),3));
      joints.geometry.setAttribute('position',new THREE.BufferAttribute(new Float32Array(motion.jointNames.length*3),3));
      group.add(bones,joints);world.add(group);
      const solid=new THREE.Group(), solidBones=[], solidJoints=[];
      for(const edge of motion.edges){
        const mesh=new THREE.Mesh(cylinderGeometry,new THREE.MeshBasicMaterial({color,transparent:true}));solid.add(mesh);solidBones.push(mesh);
      }
      for(const joint of motion.jointNames){
        const mesh=new THREE.Mesh(sphereGeometry,new THREE.MeshBasicMaterial({color,transparent:true}));solid.add(mesh);solidJoints.push(mesh);
      }
      group.add(solid);
      const rig=new FigureRig({jointNames:motion.jointNames,edges:motion.edges,color});group.add(rig.group);
      const label=document.createElement('label'), checkbox=document.createElement('input');checkbox.type='checkbox';checkbox.checked=true;
      label.className='check';label.style.setProperty('--participant-color',color);
      const key=document.createElement('span');key.className='participant-key';key.setAttribute('aria-hidden','true');
      const visibleName=document.createElement('span');visibleName.textContent=person.name;visibleName.dataset.participantName=String(person.id);
      label.append(checkbox,key,visibleName);$('scenePeople').append(label);
      checkbox.addEventListener('change',()=>showFrame(frame));objects.set(String(person.id),{group,bones,joints,checkbox,solid,solidBones,solidJoints,color,rig,customRigs:new Map(),customUpdates:new Map()});
      const styleLabel=document.createElement('div'),select=document.createElement('select');
      styleLabel.className='figure-person';styleLabel.style.setProperty('--participant-color',color);
      const name=document.createElement('input');name.type='text';name.value=person.name;name.maxLength=48;
      name.className='character-name';name.dataset.characterName=String(person.id);name.setAttribute('aria-label',`Name for character ${person.id}`);name.title='Rename character';
      name.addEventListener('change',()=>{
        person.name=name.value.replace(/[\u0000-\u001f\u007f]/g,'').trim().slice(0,48)||person.originalName;name.value=person.name;
        visibleName.textContent=person.name;select.setAttribute('aria-label',`Figure style for ${person.name}`);
        try{localStorage.setItem(characterNamesKey,JSON.stringify(Object.fromEntries(motion.people.map(person=>[String(person.id),person.name]))));$('characterNameStatus').textContent='Character names saved in this browser.';}
        catch{$('characterNameStatus').textContent='Names changed for this tab. Browser storage is unavailable.';}
        modelLibrary?.refreshParticipantNames();strikeCues?.refreshParticipantNames();showContacts();
      });
      name.addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();name.blur();}else if(event.key==='Escape'){name.value=person.name;name.blur();}});
      select.id=`figure-style-${person.id}`;select.setAttribute('aria-label',`Figure style for ${person.name}`);
      for(const [value,title] of Object.entries(figureStyles))select.add(new Option(title,value));
      select.value=effectiveStyle(person.id);
      select.addEventListener('change',()=>{figureSettings.participants[String(person.id)]=select.value;updateFigureStyles();});
      styleLabel.append(name,select);$('figurePeople').append(styleLabel);
    }
    function updateFigureStyles(){
      const values=[...$('figurePeople').querySelectorAll('select')].map(select=>select.value);
      $('figureStyle').value=values.every(value=>value===values[0])?values[0]:'mixed';
      try{localStorage.setItem(figureStorageKey,JSON.stringify(figureSettings));}catch{}
      displayedFrameSignature='';showFrame(frame);
    }
    function refreshModelChoices(event={}){
      if(event.id&&['remove','mapping','settings'].includes(event.type)){
        for(const object of objects.values()){
          object.customRigs.get(event.id)?.dispose();object.customRigs.delete(event.id);object.customUpdates.delete(event.id);
        }
      }
      for(const key of Object.keys(figureStyles))if(isModelStyle(key))delete figureStyles[key];
      for(const [id,asset] of modelLibrary.assets)if(modelLibrary.hasReady(id))figureStyles['model:'+id]=asset.name;
      if(!modelsRestoring){
        if(!Object.hasOwn(figureStyles,figureSettings.defaultStyle))figureSettings.defaultStyle='mannequin';
        for(const [id,style] of Object.entries(figureSettings.participants))if(!Object.hasOwn(figureStyles,style))figureSettings.participants[id]='mannequin';
      }
      for(const [id] of objects){
        const select=$(`figure-style-${id}`);select.replaceChildren();
        for(const [value,title] of Object.entries(figureStyles))select.add(new Option(title,value));
        select.value=effectiveStyle(id);
      }
      const all=$('figureStyle');all.replaceChildren();
      for(const [value,title] of Object.entries(figureStyles))all.add(new Option(title,value));
      const mixed=new Option('Individual styles','mixed');mixed.disabled=true;all.add(mixed);
      updateFigureStyles();
    }
    refreshFigureChoices=refreshModelChoices;
    modelLibrary=new ModelLibrary({container:$('modelLibrary'),uploadContainer:$('debugModels'),motion,
      onChange:event=>refreshModelChoices(event),
      onApply:(id,participantId)=>{
        if(!modelLibrary.hasReady(id))return;
        if(participantId!=null&&participantId!=='all')figureSettings.participants[String(participantId)]='model:'+id;
        else figureSettings={defaultStyle:'model:'+id,participants:{}};
        refreshModelChoices();
        return participantId!=null&&participantId!=='all'?effectiveStyle(participantId)==='model:'+id:[...objects.keys()].every(personId=>effectiveStyle(personId)==='model:'+id);
      }});
    $('figureStyle').disabled=false;
    $('figureStyle').addEventListener('change',()=>{
      figureSettings={defaultStyle:$('figureStyle').value,participants:{}};
      for(const select of $('figurePeople').querySelectorAll('select'))select.value=figureSettings.defaultStyle;
      updateFigureStyles();
    });
    strikeCues=new StrikeCues({world,motion,storageKey:`systema-strikes-v1:${location.pathname}:${motion.sourceSha256}`,container:$('strikeCueEditor'),
      resolveTargetPoint:(event,selectedFrame)=>strikeAnchorsReady?resolveStrikeLanding(event,{target:objects.get(String(event.targetId)),source:objects.get(String(event.strikerId)),frame:selectedFrame}):null,
      onSeek:seek,onChange:()=>{displayedFrameSignature='';showFrame(frame);},
      onPlayPreview:({startFrame,endFrame,playbackRate,estimated=false})=>{
        seek(startFrame);teachingPreviewEnd=endFrame;
        if([.25,.5,1].includes(playbackRate)){video.playbackRate=playbackRate;$('sceneSpeed').value=String(playbackRate);}
        $('scenePlaybackScope').textContent=estimated?'Estimated strike replay':'Strike preview';$('sceneFullPlayback').hidden=false;
        video.play().catch(()=>{$('sceneStatus').textContent='Tap Play to preview this strike.';});
      }});
    strikeCues.group.userData.figureOverlay=true;
    updateFigureStyles();
    new ResizeObserver(resizeSceneCanvas).observe(stage);resizeSceneCanvas();
    $('emptyScene').hidden=true;
    for(const button of document.querySelectorAll('[data-camera]')){
      button.disabled=button.dataset.camera==='source'&&!hasSourceCamera();button.addEventListener('click',()=>preset(button.dataset.camera));
    }
    $('resetCamera').disabled=false;$('resetCamera').addEventListener('click',()=>preset(hasSourceCamera()?'source':'front'));
    preset(hasSourceCamera()?'source':'front');showFrame(frame);
    $('sceneStatus').textContent=hasSourceCamera()?(motion.roomCalibration?.id?'Studio camera matched to the footage. Figure depth and scale remain estimates.':'Estimated source camera ready. Compare the 3D motion with the footage; depth and scale remain estimates.'):'3D estimates ready. Compare depth and contact with the footage.';$('sceneStatus').classList.add('ready');
    if(video.error)showVideoError();
    applySceneView(sceneView);
    function render(){if(!sourceFollowing)orbit.update();renderSceneFrame();requestAnimationFrame(render);}render();
    const configUrl=site?siteLesson.environment:'studio/environment.json';
    if(configUrl){
      studioEnvironment=new StudioEnvironment({world,renderer,camera,orbit,canvas:renderer.domElement,grid,motion,configUrl,onChange:()=>showFrame(frame)});
    }else{
      $('studioStatus').textContent='This lesson has no registered studio scan.';
      $('studioRetry').hidden=true;
    }
    modelLibrary.restore().catch(error=>modelLibrary.setStatus(`Saved models could not be restored: ${error.message}`,true)).finally(()=>{modelsRestoring=false;refreshModelChoices();});
  }catch(error){motion=null;$('sceneStatus').textContent=`Scene unavailable: ${error.message}`;$('emptyScene').hidden=false;sceneUnavailable();}
}
load();

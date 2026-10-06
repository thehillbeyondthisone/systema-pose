import * as THREE from 'three';
import {OrbitControls} from './vendor/three/OrbitControls.js';
import {findBoneContacts} from './contact_geometry.mjs';

const $=id=>document.getElementById(id), video=$('sceneVideo'), scrub=$('sceneScrub');
const palette=['#ffc45f','#7bc7ed','#bda4ee','#94d8b8','#f29d91','#dfc688'];
let motion=null, frame=0, renderer, world, camera, orbit, objects=new Map(), center, extent=4;
let contactMarkers, markerPool=[], contactSettings={enabled:false,radius:0.02};
let displayedFrameSignature='';
const contactStorageKey='systema-contact-effects-v1';
try{
  const saved=JSON.parse(localStorage.getItem(contactStorageKey));
  if(saved && typeof saved.enabled==='boolean' && [0.02,0.035,0.05].includes(saved.radius))contactSettings=saved;
}catch{}
$('contactEffects').checked=contactSettings.enabled;
$('boneThickness').value=String(contactSettings.radius);
$('boneThickness').disabled=!contactSettings.enabled;
function changeContactSettings(){
  contactSettings={enabled:$('contactEffects').checked,radius:Number($('boneThickness').value)};
  $('boneThickness').disabled=!contactSettings.enabled;
  try{localStorage.setItem(contactStorageKey,JSON.stringify(contactSettings));}catch{}
  showFrame(frame);
}
$('contactEffects').addEventListener('change',changeContactSettings);
$('boneThickness').addEventListener('change',changeContactSettings);
const sourceStart=18, fps=30;
const sceneStorageKey='systema-scene-view-v1';
let sceneView=innerWidth<=600?'scene':'compare';
try{const saved=localStorage.getItem(sceneStorageKey);if(['scene','video','compare'].includes(saved))sceneView=saved;}catch{}
function applySceneView(value){
  sceneView=value;
  $('scenePanel').hidden=value==='video';$('sceneFootagePanel').hidden=value==='scene';
  $('orbitHelp').hidden=value==='video';$('sceneGrid').classList.toggle('single-view',value!=='compare');
  document.querySelectorAll('[data-scene-view]').forEach(button=>{
    const active=button.dataset.sceneView===value;button.classList.toggle('active',active);button.setAttribute('aria-pressed',String(active));
  });
  try{localStorage.setItem(sceneStorageKey,value);}catch{}
}
document.querySelectorAll('[data-scene-view]').forEach(button=>button.addEventListener('click',()=>applySceneView(button.dataset.sceneView)));
document.querySelectorAll('.lesson-return').forEach(link=>link.addEventListener('click',()=>{link.href=`/?demo=1&frame=${frame}`;}));
applySceneView(sceneView);
const entryFrame=Number(new URLSearchParams(location.search).get('frame'));
if(Number.isInteger(entryFrame)&&entryFrame>=0&&entryFrame<=359){
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
  frame=Math.max(0,Math.min(359,index));scrub.value=frame;
  $('sceneTime').textContent=`${(sourceStart+frame/fps).toFixed(3)}s`;
  if(!motion)return;
  const signature=JSON.stringify([frame,contactSettings,[...objects.values()].map(object=>object.checkbox.checked)]);
  if(signature===displayedFrameSignature)return;
  displayedFrameSignature=signature;
  for(const object of objects.values())object.group.visible=false;
  for(const person of motion.frames[frame].people){
    const object=objects.get(String(person.id));if(!object)continue;
    object.group.visible=object.checkbox.checked;
    const opacity=person.sourceBoxInterpolated ? .35 : person.overlappingSourceBoxes?.length ? .65 : 1;
    object.bones.material.opacity=opacity;object.joints.material.opacity=opacity;
    const positions=[];
    for(const [a,b] of motion.edges)positions.push(...person.xyz[a],...person.xyz[b]);
    object.bones.geometry.attributes.position.array.set(positions);
    object.bones.geometry.attributes.position.needsUpdate=true;
    object.bones.geometry.computeBoundingSphere();
    object.joints.geometry.attributes.position.array.set(person.xyz.flat());
    object.joints.geometry.attributes.position.needsUpdate=true;
    object.joints.geometry.computeBoundingSphere();
    object.bones.visible=!contactSettings.enabled;object.joints.visible=!contactSettings.enabled;
    object.solid.visible=contactSettings.enabled;
    for(let bone=0;bone<motion.edges.length;bone++){
      const [a,b]=motion.edges[bone], start=new THREE.Vector3(...person.xyz[a]), end=new THREE.Vector3(...person.xyz[b]);
      const delta=end.clone().sub(start), mesh=object.solidBones[bone], length=delta.length();
      mesh.position.copy(start).add(end).multiplyScalar(.5);
      mesh.scale.set(contactSettings.radius,length,contactSettings.radius);
      mesh.visible=length>1e-8;
      if(mesh.visible)mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0),delta.divideScalar(length));
      mesh.material.color.set(object.color);mesh.material.opacity=opacity;
    }
    person.xyz.forEach((xyz,joint)=>{
      const mesh=object.solidJoints[joint];mesh.position.set(...xyz);mesh.scale.setScalar(contactSettings.radius);
      mesh.material.color.set(object.color);mesh.material.opacity=opacity;
    });
  }
  const people=motion.frames[frame].people;
  const gaps=people.filter(p=>p.sourceBoxInterpolated).length;
  const overlap=people.some(p=>p.overlappingSourceBoxes?.length);
  $('frameQuality').textContent=gaps?`${gaps} pose${gaps===1?'':'s'} uses an interpolated tracking box. Faded poses need source review; contact is unverified.`:overlap?'People overlap in the footage. Faded poses may follow the wrong limbs; contact is unverified.':'Depth and contact are estimates. Compare the poses with the footage.';
  showContacts();
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
      const object=objects.get(id);object.solidBones[bone].material.color.set('#ffe17a');
      motion.edges[bone].forEach(joint=>object.solidJoints[joint].material.color.set('#ffe17a'));
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
    const marker=markerPool[index];marker.visible=true;marker.position.set(...contact.point);marker.scale.setScalar(contactSettings.radius*1.8);
  });
  for(const [pair,count] of pairs){
    const names=pair.split(':').map(id=>motion.people.find(person=>String(person.id)===id).name);
    const item=document.createElement('li');item.textContent=`${names.join(' ↔ ')} · ${count} bone pair${count===1?'':'s'}`;
    $('contactList').append(item);
  }
}
function seek(index){video.pause();video.currentTime=Math.max(0,Math.min(359,index))/fps;showFrame(index);}
scrub.addEventListener('input',()=>seek(Number(scrub.value)));
$('scenePrevious').addEventListener('click',()=>seek(frame-1));
$('sceneNext').addEventListener('click',()=>seek(frame+1));
$('sceneSpeed').addEventListener('change',()=>video.playbackRate=Number($('sceneSpeed').value));
video.addEventListener('timeupdate',()=>showFrame(Math.floor(video.currentTime*fps+0.001)));
video.addEventListener('seeked',()=>showFrame(Math.floor(video.currentTime*fps+0.001)));
$('scenePlay').addEventListener('click',async()=>{
  if(!video.paused){video.pause();return;}
  try{if(video.ended)seek(0);await video.play();}catch{$('sceneStatus').textContent='Tap Play again to start the footage.';}
});
video.addEventListener('play',()=>{$('scenePlay').textContent='Ⅱ';$('scenePlay').setAttribute('aria-label','Pause movement');});
video.addEventListener('pause',()=>{$('scenePlay').textContent='▶';$('scenePlay').setAttribute('aria-label','Play movement');});
function sync(){if(!video.paused)showFrame(Math.floor(video.currentTime*fps+0.001));requestAnimationFrame(sync);}sync();

function preset(name){
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
  document.querySelectorAll('[data-camera]').forEach(button=>{
    const active=button.dataset.camera===name;button.classList.toggle('active',active);button.setAttribute('aria-pressed',String(active));
  });
}
function validate(data){
  if(data.coordinateSpace!=='world-3d'||data.units!=='model-meters'||data.upAxis!=='y')throw Error('Unsupported scene coordinates.');
  if(data.sourceStart!==18||data.sourceEnd!==30||Math.abs(data.fps-30)>0.001||data.frames.length!==360)throw Error('Scene timing does not match this clip.');
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
    const response=await fetch('/3d-pilot/scene.json',{cache:'no-store'});
    if(response.status===404){$('sceneStatus').textContent='The shared 3D reconstruction is not ready yet. You can review the current footage here.';sceneUnavailable();return;}
    if(!response.ok)throw Error('Scene could not be loaded.');
    const data=await response.json();validate(data);
    const manifest=await (await fetch('/3d-pilot/manifest.json',{cache:'no-store'})).json();
    if(data.sourceSha256!==manifest.sha256)throw Error('Scene and footage do not match.');
    const expected=manifest.reconstruction?.expectedParticipants;
    if(Number.isInteger(expected)&&data.people.length!==expected)throw Error(`The scene is being extended to all ${expected} participants.`);
    motion=data;
    const stage=$('orbitStage');world=new THREE.Scene();world.background=new THREE.Color('#142234');
    contactMarkers=new THREE.Group();world.add(contactMarkers);
    renderer=new THREE.WebGLRenderer({antialias:true});renderer.setPixelRatio(Math.min(devicePixelRatio,2));
    camera=new THREE.PerspectiveCamera(48,1,0.01,1000);stage.append(renderer.domElement);
    orbit=new OrbitControls(camera,renderer.domElement);orbit.enableDamping=true;
    orbit.addEventListener('start',()=>document.querySelectorAll('[data-camera]').forEach(button=>{button.classList.remove('active');button.setAttribute('aria-pressed','false');}));
    const bounds=new THREE.Box3();
    for(const f of motion.frames)for(const p of f.people)for(const xyz of p.xyz)bounds.expandByPoint(new THREE.Vector3(...xyz));
    if(bounds.isEmpty())throw Error('Scene contains no visible joints.');
    center=bounds.getCenter(new THREE.Vector3());extent=Math.max(2,bounds.getSize(new THREE.Vector3()).length());
    const grid=new THREE.GridHelper(Math.ceil(extent*3),Math.ceil(extent*3),'#537087','#2d4054');grid.position.set(center.x,0,center.z);world.add(grid);
    const cylinderGeometry=new THREE.CylinderGeometry(1,1,1,10), sphereGeometry=new THREE.SphereGeometry(1,12,8);
    for(let index=0;index<motion.people.length;index++){
      const person=motion.people[index], color=person.color||palette[index%palette.length], group=new THREE.Group();
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
      const label=document.createElement('label'), checkbox=document.createElement('input');checkbox.type='checkbox';checkbox.checked=true;
      label.className='check';label.style.setProperty('--participant-color',color);
      const key=document.createElement('span');key.className='participant-key';key.setAttribute('aria-hidden','true');
      label.append(checkbox,key,document.createTextNode(person.name));$('scenePeople').append(label);
      checkbox.addEventListener('change',()=>showFrame(frame));objects.set(String(person.id),{group,bones,joints,checkbox,solid,solidBones,solidJoints,color});
    }
    new ResizeObserver(()=>{const width=stage.clientWidth,height=stage.clientHeight;if(!width||!height)return;renderer.setSize(width,height,false);camera.aspect=width/height;camera.updateProjectionMatrix();}).observe(stage);
    $('emptyScene').hidden=true;
    for(const button of document.querySelectorAll('[data-camera]')){button.disabled=false;button.addEventListener('click',()=>preset(button.dataset.camera));}
    $('resetCamera').disabled=false;$('resetCamera').addEventListener('click',()=>preset('front'));
    preset('front');showFrame(frame);
    $('sceneStatus').textContent='Shared 3D estimates are ready to examine. Compare depth and contact with the original footage.';$('sceneStatus').classList.add('ready');
    function render(){orbit.update();renderer.render(world,camera);requestAnimationFrame(render);}render();
  }catch(error){motion=null;$('sceneStatus').textContent=`Scene unavailable: ${error.message}`;$('emptyScene').hidden=false;sceneUnavailable();}
}
load();

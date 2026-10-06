import * as THREE from 'three';
import {OrbitControls} from './vendor/three/OrbitControls.js';

const $=id=>document.getElementById(id), video=$('sceneVideo'), scrub=$('sceneScrub');
const palette=['#ffc45f','#7bc7ed','#bda4ee','#94d8b8','#f29d91','#dfc688'];
let motion=null, frame=0, renderer, world, camera, orbit, objects=new Map(), center, extent=4;
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
  document.querySelectorAll('[data-scene-view]').forEach(button=>{button.disabled=button.dataset.sceneView!=='video';});
}

function showFrame(index){
  frame=Math.max(0,Math.min(359,index));scrub.value=frame;
  $('sceneTime').textContent=`${(sourceStart+frame/fps).toFixed(3)}s`;
  if(!motion)return;
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
  }
  const people=motion.frames[frame].people;
  const gaps=people.filter(p=>p.sourceBoxInterpolated).length;
  const overlap=people.some(p=>p.overlappingSourceBoxes?.length);
  $('frameQuality').textContent=gaps?`${gaps} pose${gaps===1?'':'s'} uses an interpolated tracking box. Faded poses need source review; contact is unverified.`:overlap?'People overlap in the footage. Faded poses may follow the wrong limbs; contact is unverified.':'Depth and contact are estimates. Compare the poses with the footage.';
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
    renderer=new THREE.WebGLRenderer({antialias:true});renderer.setPixelRatio(Math.min(devicePixelRatio,2));
    camera=new THREE.PerspectiveCamera(48,1,0.01,1000);stage.append(renderer.domElement);
    orbit=new OrbitControls(camera,renderer.domElement);orbit.enableDamping=true;
    orbit.addEventListener('start',()=>document.querySelectorAll('[data-camera]').forEach(button=>{button.classList.remove('active');button.setAttribute('aria-pressed','false');}));
    const bounds=new THREE.Box3();
    for(const f of motion.frames)for(const p of f.people)for(const xyz of p.xyz)bounds.expandByPoint(new THREE.Vector3(...xyz));
    if(bounds.isEmpty())throw Error('Scene contains no visible joints.');
    center=bounds.getCenter(new THREE.Vector3());extent=Math.max(2,bounds.getSize(new THREE.Vector3()).length());
    const grid=new THREE.GridHelper(Math.ceil(extent*3),Math.ceil(extent*3),'#537087','#2d4054');grid.position.set(center.x,0,center.z);world.add(grid);
    for(let index=0;index<motion.people.length;index++){
      const person=motion.people[index], color=person.color||palette[index%palette.length], group=new THREE.Group();
      const bones=new THREE.LineSegments(new THREE.BufferGeometry(),new THREE.LineBasicMaterial({color,transparent:true}));
      const joints=new THREE.Points(new THREE.BufferGeometry(),new THREE.PointsMaterial({color,size:0.035,transparent:true}));
      bones.geometry.setAttribute('position',new THREE.BufferAttribute(new Float32Array(motion.edges.length*6),3));
      joints.geometry.setAttribute('position',new THREE.BufferAttribute(new Float32Array(motion.jointNames.length*3),3));
      group.add(bones,joints);world.add(group);
      const label=document.createElement('label'), checkbox=document.createElement('input');checkbox.type='checkbox';checkbox.checked=true;
      label.className='check';label.style.setProperty('--participant-color',color);
      const key=document.createElement('span');key.className='participant-key';key.setAttribute('aria-hidden','true');
      label.append(checkbox,key,document.createTextNode(person.name));$('scenePeople').append(label);
      checkbox.addEventListener('change',()=>showFrame(frame));objects.set(String(person.id),{group,bones,joints,checkbox});
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

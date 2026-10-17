// Real GLB file uploads, captured-motion playback, local persistence and safe rejection.
const {chromium}=require(process.env.SYSTEMA_PLAYWRIGHT||'C:/Users/thefo/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const ROOT=path.resolve(__dirname,'..'),OUT=path.join(ROOT,'outputs/custom-models');
const PYTHON=process.env.SYSTEMA_PYTHON||'C:/Users/thefo/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe';
const BASE=process.env.SYSTEMA_TEST_URL||'http://127.0.0.1:8787/release-custom-models-20261017/';
const report={base:BASE,checks:[],errors:[],failed:[],requests:[]};
fs.mkdirSync(OUT,{recursive:true});
const pass=message=>{report.checks.push(message);console.log('PASS '+message);};
let server,browser;

function makeGLB(source,{names=source.names,staticMesh=false,external=false}={}){
 const segments=[],views=[],accessors=[];let byteLength=0;
 function accessor(array,type,componentType,components,{target,minmax=false}={}){
  const bytes=Buffer.from(array.buffer,array.byteOffset,array.byteLength),padding=(4-byteLength%4)%4;
  if(padding){segments.push(Buffer.alloc(padding));byteLength+=padding;}
  const view=views.push({buffer:0,byteOffset:byteLength,byteLength:bytes.length,...(target?{target}:{})})-1;
  segments.push(bytes);byteLength+=bytes.length;
  const entry={bufferView:view,componentType,count:array.length/components,type};
  if(minmax){entry.min=Array(components).fill(Infinity);entry.max=Array(components).fill(-Infinity);
   for(let i=0;i<array.length;i++) {const c=i%components;entry.min[c]=Math.min(entry.min[c],array[i]);entry.max[c]=Math.max(entry.max[c],array[i]);}}
  return accessors.push(entry)-1;
 }
 const attributes={
  POSITION:accessor(new Float32Array(source.position),'VEC3',5126,3,{target:34962,minmax:true}),
  NORMAL:accessor(new Float32Array(source.normal),'VEC3',5126,3,{target:34962}),
  COLOR_0:accessor(new Float32Array(source.color),'VEC3',5126,3,{target:34962}),
 };
 if(!staticMesh){
  attributes.JOINTS_0=accessor(new Uint16Array(source.skinIndex),'VEC4',5123,4,{target:34962});
  attributes.WEIGHTS_0=accessor(new Float32Array(source.skinWeight),'VEC4',5126,4,{target:34962});
 }
 const indices=accessor(new Uint16Array(source.index),'SCALAR',5123,1,{target:34963});
 const inverseBindMatrices=staticMesh?null:accessor(new Float32Array(source.inverses.flat()),'MAT4',5126,16);
 const meshIndex=source.names.length+1;
 const nodes=[{name:'Uploaded teaching character',children:[1,meshIndex]},...source.names.map((name,i)=>({name:names[i],matrix:source.matrices[i],children:source.parents.flatMap((parent,j)=>parent===i?[j+1]:[])})),{name:'Uploaded skinned body',mesh:0,...(!staticMesh?{skin:0}:{})}];
 if(staticMesh)nodes[0].children=[meshIndex];
 const gltf={asset:{version:'2.0',generator:'Systema Pose real-upload verification fixture'},scene:0,scenes:[{nodes:[0]}],nodes,
  meshes:[{primitives:[{attributes,indices,material:0,mode:4}]}],materials:[{pbrMetallicRoughness:{baseColorFactor:[1,1,1,1],roughnessFactor:.7,metallicFactor:0},doubleSided:true}],
  ...(!staticMesh?{skins:[{joints:source.names.map((_,i)=>i+1),inverseBindMatrices,skeleton:1}]}:{}),
  accessors,bufferViews:views,buffers:[{byteLength,...(external?{uri:'https://models.example.test/private-character.bin'}:{})}]};
 const rawJSON=Buffer.from(JSON.stringify(gltf)),json=Buffer.concat([rawJSON,Buffer.alloc((4-rawJSON.length%4)%4,32)]);
 const binary=Buffer.concat([...segments,Buffer.alloc((4-byteLength%4)%4)]),header=Buffer.alloc(12),jh=Buffer.alloc(8),bh=Buffer.alloc(8);
 header.writeUInt32LE(0x46546c67,0);header.writeUInt32LE(2,4);header.writeUInt32LE(12+8+json.length+8+binary.length,8);
 jh.writeUInt32LE(json.length,0);jh.writeUInt32LE(0x4e4f534a,4);bh.writeUInt32LE(binary.length,0);bh.writeUInt32LE(0x004e4942,4);
 return Buffer.concat([header,jh,json,bh,binary]);
}

(async()=>{
 try{
  if(!process.env.SYSTEMA_TEST_URL){
   let active=false;try{active=(await fetch(BASE+'catalog.json')).ok;}catch{}
   if(!active){
    server=spawn(PYTHON,[path.join(ROOT,'work/preview_pages.py'),'--port','8787','--directory',path.join(ROOT,'work')],{windowsHide:true,stdio:'ignore'});
    for(let attempt=0;attempt<50;attempt++){try{if((await fetch(BASE+'catalog.json')).ok)break;}catch{}await new Promise(resolve=>setTimeout(resolve,100));}
   }
  }
  browser=await chromium.launch({channel:'msedge',headless:true});
  const context=await browser.newContext({viewport:{width:1440,height:1100},acceptDownloads:true});
  const page=await context.newPage();
  const observe=target=>{
   target.on('pageerror',error=>report.errors.push(error.message));
   target.on('response',response=>{if(response.status()>=400&&!response.url().endsWith('favicon.ico'))report.failed.push(response.url());});
   target.on('request',request=>report.requests.push({method:request.method(),url:request.url()}));
  };observe(page);
  // Read-only test instrumentation: exercise the real file inputs and viewer,
  // then inspect the actual rendered instances rather than a mock rig.
  await page.route(new URL('scene.js',BASE).href,async route=>{
   const response=await route.fetch();
   await route.fulfill({response,body:(await response.text())+'\nwindow.__systemaModelTest=()=>({objects,motion,frame,camera,THREE});'});
  });
  await page.goto(BASE+'scene.html?clip=multiple-attackers&frame=60');
  const ready=async(target=page)=>{
   await target.waitForFunction(()=>document.getElementById('studioStatus')?.dataset.state==='ready'&&document.getElementById('sceneVideo').readyState>=2&&document.getElementById('modelUpload')&&!document.getElementById('modelUpload').disabled,null,{timeout:60000});
   await target.locator('#modelDetails').evaluate(details=>details.open=true);
  };
  await ready();
  const source=await page.evaluate(async()=>{
   const {FigureRig}=await import(new URL('./figure-rig.js',location.href));
   const rig=new FigureRig({color:'#7adbc5'});rig.group.updateMatrixWorld(true);
   const geometry=rig.geometry;
   return {names:rig.jointNames,parents:rig.parents,matrices:rig.bones.map(bone=>bone.matrix.toArray()),inverses:rig.skeleton.boneInverses.map(matrix=>matrix.toArray()),
    ...Object.fromEntries(['position','normal','color','skinIndex','skinWeight'].map(name=>[name,Array.from(geometry.attributes[name].array)])),index:Array.from(geometry.index.array)};
  });
  assert.equal(source.names.length,22);assert(source.position.length>3000);assert(Math.max(...source.index)<65536);
  const mixamo=['Hips','LeftUpLeg','RightUpLeg','Spine','LeftLeg','RightLeg','Spine1','LeftFoot','RightFoot','Spine2','LeftToeBase','RightToeBase','Neck','LeftShoulder','RightShoulder','Head','LeftArm','RightArm','LeftForeArm','RightForeArm','LeftHand','RightHand'].map(name=>'mixamorig:'+name);
  const unknown=source.names.map((_,i)=>`Joint_${String(i+1).padStart(2,'0')}`);
  const fixtures={canonical:['Coastal Rig.glb',makeGLB(source)],mixamo:['Mixamo Rig.glb',makeGLB(source,{names:mixamo})],manual:['Manual Rig.glb',makeGLB(source,{names:unknown})],static:['Static Model.glb',makeGLB(source,{staticMesh:true})],external:['External Model.glb',makeGLB(source,{external:true})],malformed:['Broken Model.glb',Buffer.from('Not a binary glTF model')]};
  for(const fixture of Object.values(fixtures)){fixture[0]=path.join(OUT,fixture[0]);fs.writeFileSync(fixture[0],fixture[1]);}
  pass('Self-contained GLB fixtures contain the real 22-bone, weighted FigureRig mesh');
  const canvas=page.locator('#orbitStage canvas'),upload=page.locator('#modelUpload');
  const card=label=>page.locator('.model-card').filter({hasText:label});
  const modelCount=async n=>page.waitForFunction(n=>Number(document.querySelector('#orbitStage canvas').dataset.customModelCount)===n,n,{timeout:30000});
  const style=async id=>`model:${await card(id).getAttribute('data-model-id')}`;
  const uploadModel=async(key,label)=>{await upload.setInputFiles(fixtures[key][0]);await card(label).waitFor();return card(label);};
  const canonical=await uploadModel('canonical','Coastal Rig');
  await canonical.locator('[data-model-readiness="ready"]').waitFor();
  const canonicalStyle=await style('Coastal Rig');
  await canonical.locator('[data-model-participant]').selectOption('1');
  await canonical.locator('[data-model-action="apply-person"]').click();await modelCount(1);
  assert.equal(await page.locator('#figure-style-1').inputValue(),canonicalStyle);
  assert.equal(await page.locator('#figure-style-2').inputValue(),'mannequin');
  const initialUpdates=JSON.parse(await canvas.getAttribute('data-custom-model-updates'));
  await page.locator('#scenePlay').click();
  await page.waitForFunction(initial=>{const current=JSON.parse(document.querySelector('#orbitStage canvas').dataset.customModelUpdates||'{}');return current['1']?.lastUpdate>initial;},initialUpdates['1'].lastUpdate,{timeout:15000});
  pass('A real uploaded GLB auto-maps and follows captured motion for one participant');
  const videoState=()=>page.locator('#sceneVideo').evaluate(video=>({time:video.currentTime,paused:video.paused,muted:video.muted,volume:video.volume,rate:video.playbackRate}));
  const before=await videoState();
  const second=await uploadModel('mixamo','Mixamo Rig');await second.locator('[data-model-readiness="ready"]').waitFor();
  const mixamoStyle=await style('Mixamo Rig');
  await second.locator('[data-model-action="apply-all"]').click();await modelCount(4);
  const after=await videoState();
  assert(!after.paused);assert(after.time>=before.time-.05,'Upload/swap must not seek back');
  assert.deepEqual([after.muted,after.volume,after.rate],[before.muted,before.volume,before.rate]);
  assert.equal(await page.locator('#figureStyle').inputValue(),mixamoStyle);
  await page.locator('#figure-style-1').selectOption(canonicalStyle);
  assert.equal(await page.locator('#figureStyle').inputValue(),'mixed');
  assert.equal(await page.locator('#figure-style-2').inputValue(),mixamoStyle);
  assert.equal(await page.locator('#sceneVideo').evaluate(video=>video.paused),false);
  await page.locator('#scenePlay').click();
  pass('Mixamo bones auto-map; models swap for everyone or one person during uninterrupted audio/video playback');
  await page.locator('#sceneScrub').evaluate(input=>{input.value='150';input.dispatchEvent(new Event('input'));});
  await modelCount(4);
  report.renderedInstances=await page.evaluate(()=>{
   const {objects,motion,frame,camera,THREE}=window.__systemaModelTest(),rigs=[],rows=[];
   camera.updateMatrixWorld(true);
   for(const person of motion.frames[frame].people){
    const object=objects.get(String(person.id)),rig=[...object.customRigs.values()].find(candidate=>candidate.group.visible);
    if(!rig)throw Error(`No visible custom rig for participant ${person.id}`);
    if(rigs.some(previous=>previous.skeleton===rig.skeleton||previous.bones.some(bone=>rig.bones.includes(bone))))throw Error('Participants share live skeleton bones');
    rigs.push(rig);rig.group.updateWorldMatrix(true,true);
    const pelvis=new THREE.Vector3(...person.xyz[motion.jointNames.indexOf('pelvis')]);
    const pelvisError=rig.group.getWorldPosition(new THREE.Vector3()).distanceTo(pelvis);
    if(pelvisError>1e-7)throw Error(`Participant ${person.id} moved away from captured pelvis by ${pelvisError}`);
    const box=new THREE.Box3(),projected=new THREE.Box3(),point=new THREE.Vector3();let vertices=0;
    for(const mesh of rig.meshes)for(let i=0;i<mesh.geometry.attributes.position.count;i++){
     mesh.getVertexPosition(i,point).applyMatrix4(mesh.matrixWorld);
     if(!point.toArray().every(Number.isFinite))throw Error('Non-finite skinned vertex');
     box.expandByPoint(point);projected.expandByPoint(point.clone().project(camera));vertices++;
    }
    rows.push({id:person.id,pelvisError,vertices,worldBounds:[box.min.toArray(),box.max.toArray()],projectedBounds:[projected.min.toArray(),projected.max.toArray()],poseValid:rig.group.userData.customFigure.poseValid});
   }
   return rows;
  });
  assert.equal(report.renderedInstances.length,4);assert(report.renderedInstances.every(row=>row.poseValid&&row.vertices>1000));
  pass('All four actual rendered meshes have independent skeletons, finite deformed vertices and the correct captured pelvis at frame150');
  await page.screenshot({path:path.join(OUT,'uploaded-models-desktop.png'),fullPage:true});
  await page.reload();await ready();
  await card('Coastal Rig').waitFor();await card('Mixamo Rig').waitFor();await modelCount(4);
  assert.equal(await page.locator('#figure-style-1').inputValue(),canonicalStyle);
  assert.equal(await page.locator('#figure-style-2').inputValue(),mixamoStyle);
  pass('IndexedDB restores uploaded GLB files and participant assignments after reload');
  const manual=await uploadModel('manual','Manual Rig');
  await manual.locator('[data-model-readiness="missing"]').waitFor();
  await manual.locator('.model-mapping').evaluate(details=>details.open=true);
  for(let i=0;i<source.names.length;i++)await manual.locator(`[data-source-joint="${source.names[i]}"]`).selectOption(unknown[i]);
  await manual.locator('[data-model-action="save-mapping"]').click();
  await manual.locator('[data-model-readiness="ready"]').waitFor();
  const manualStyle=await style('Manual Rig');
  await manual.locator('[data-model-participant]').selectOption('3');
  await manual.locator('[data-model-action="apply-person"]').click();await modelCount(4);
  await manual.locator('.model-calibration').evaluate(details=>details.open=true);
  await manual.locator('[data-model-setting="scaleMultiplier"]').fill('0.9');
  await manual.locator('[data-model-setting="yawDegrees"]').fill('20');
  await manual.locator('[data-model-action="save-settings"]').click();
  await manual.locator('.model-calibration .model-status').filter({hasText:'Fit updated.'}).waitFor();
  pass('An unfamiliar bone naming scheme can be manually mapped, fitted and applied immediately');
  for(const [key,pattern] of [['static',/skin|rig|bone/i],['malformed',/GLB|glTF|binary|header|file/i],['external',/external|self.contained|embedded/i]]){
   const previous=await page.locator('.model-card').count();
   await upload.setInputFiles(fixtures[key][0]);
   await page.waitForFunction(({pattern,filename})=>{
    const status=document.getElementById('modelStatus');
    return !document.getElementById('modelUpload').disabled&&status.dataset.kind==='error'&&status.textContent.includes(filename)&&new RegExp(pattern,'i').test(status.textContent);
   },{pattern:pattern.source,filename:path.basename(fixtures[key][0])},{timeout:15000});
   assert.equal(await page.locator('.model-card').count(),previous,`${key} must not enter the library`);
  }
  pass('Static, malformed and externally linked GLB files are rejected without disturbing working models');
  await card('Mixamo Rig').locator('[data-model-action="remove"]').click();
  await card('Mixamo Rig').waitFor({state:'detached'});await modelCount(2);
  await page.waitForFunction(()=>document.getElementById('modelStatus').textContent.includes('Mixamo Rig removed.'));
  assert.equal(await page.locator('#figure-style-2').inputValue(),'mannequin');
  assert.equal(await page.locator('#figure-style-4').inputValue(),'mannequin');
  assert.equal(await page.locator('#figure-style-1').inputValue(),canonicalStyle);
  await page.reload();await ready();await card('Coastal Rig').waitFor();await card('Manual Rig').waitFor();await modelCount(2);
  assert.equal(await card('Mixamo Rig').count(),0);
  assert.equal(await page.locator('#figure-style-3').inputValue(),manualStyle);
  assert.equal(await card('Manual Rig').locator('[data-model-setting="scaleMultiplier"]').inputValue(),'0.9');
  assert.equal(await card('Manual Rig').locator('[data-model-setting="yawDegrees"]').inputValue(),'20');
  pass('Removing a model safely falls back to mannequin and persists removal, manual mapping and fit');
  for(const width of [390,768]){
   await page.setViewportSize({width,height:width===390?844:1024});
   await page.locator('[data-scene-view="scene"]').click();
   assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Model controls must fit the viewport');
   assert(await upload.isVisible(),'Upload remains accessible on mobile');
  }
  await page.screenshot({path:path.join(OUT,'uploaded-models-tablet.png'),fullPage:true});
  const transientContext=await browser.newContext({viewport:{width:1280,height:900}});
  await transientContext.addInitScript(()=>Object.defineProperty(window,'indexedDB',{get:()=>undefined,configurable:true}));
  const transientPage=await transientContext.newPage();observe(transientPage);
  await transientPage.goto(BASE+'scene.html?clip=multiple-attackers&frame=150');await ready(transientPage);
  await transientPage.locator('#modelUpload').setInputFiles(fixtures.canonical[0]);
  await transientPage.locator('.model-card [data-model-readiness="ready"]').waitFor();
  await transientPage.locator('.model-card [data-model-action="apply-all"]').click();
  await transientPage.waitForFunction(()=>document.querySelector('#orbitStage canvas').dataset.customModelCount==='4');
  assert.match(await transientPage.locator('#modelStatus').textContent(),/browser storage is unavailable|this tab only/i);
  await transientContext.close();
  pass('With IndexedDB unavailable, an uploaded model still works for the tab and clearly reports temporary storage');
  const origin=new URL(BASE).origin;
  assert.deepEqual(report.requests.filter(request=>!['GET','HEAD'].includes(request.method)),[],'Model bytes must never be sent to a server');
  assert.deepEqual(report.requests.filter(request=>/^https?:/.test(request.url)&&new URL(request.url).origin!==origin),[],'GLB imports must never fetch external dependencies');
  assert.deepEqual(report.errors,[]);assert.deepEqual(report.failed,[]);
  pass('Mobile controls fit; GLB files remain local with no POST requests, external fetches or JavaScript/network failures');
 }finally{
  fs.writeFileSync(path.join(OUT,'verification.json'),JSON.stringify(report,null,2));
  if(browser)await browser.close();if(server)server.kill();
 }
})().catch(error=>{console.error(error);process.exitCode=1;});

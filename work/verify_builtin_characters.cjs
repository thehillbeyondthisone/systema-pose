// Exercise the shipped GLBs, real captured motion, character controls and persistence.
const {chromium}=require(process.env.SYSTEMA_PLAYWRIGHT||'C:/Users/thefo/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const ROOT=path.resolve(__dirname,'..'),OUT=path.join(ROOT,'outputs/builtin-characters');
const PYTHON=process.env.SYSTEMA_PYTHON||'C:/Users/thefo/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe';
const BASE=process.env.SYSTEMA_TEST_URL||'http://127.0.0.1:8788/release-builtins-final-20261017/';
// Optional read-only override verifies newly prepared character files against
// an existing release build, without copying into that parent-owned build.
const CHARACTER_SOURCE=process.env.SYSTEMA_TEST_CHARACTERS?path.resolve(process.env.SYSTEMA_TEST_CHARACTERS):null;
const report={base:BASE,checks:[],errors:[],failed:[],requests:[],models:[],renderedInstances:[]};
if(CHARACTER_SOURCE)report.characterSource=CHARACTER_SOURCE;
fs.mkdirSync(OUT,{recursive:true});
const pass=message=>{report.checks.push(message);console.log('PASS '+message);};
let server,browser;

function inspectGLB(bytes){
 assert(bytes.length>=20,'Shipped model must contain a GLB header');
 assert.equal(bytes.readUInt32LE(0),0x46546c67);assert.equal(bytes.readUInt32LE(4),2);assert.equal(bytes.readUInt32LE(8),bytes.length);
 let document;for(let offset=12;offset<bytes.length;){
  const length=bytes.readUInt32LE(offset),type=bytes.readUInt32LE(offset+4);offset+=8;
  assert.equal(length%4,0);assert(offset+length<=bytes.length);
  if(type===0x4e4f534a)document=JSON.parse(bytes.subarray(offset,offset+length).toString());
  offset+=length;
 }
 assert(document);assert.equal(document.asset.version,'2.0');
 function local(value){
  if(!value||typeof value!=='object')return;
  for(const [key,item] of Object.entries(value)){
   if(key==='uri')assert(/^data:/i.test(item),'Shipped GLBs must embed all buffers and images');
   local(item);
  }
 }
 local(document);
 assert(document.skins?.some(skin=>skin.joints.length>=15),'Character needs a real humanoid skin');
 assert(document.meshes?.some(mesh=>mesh.primitives.some(primitive=>primitive.attributes.JOINTS_0!==undefined&&primitive.attributes.WEIGHTS_0!==undefined)),'Character needs weighted mesh vertices');
 return {bytes:bytes.length,skins:document.skins.length,joints:document.skins.map(skin=>skin.joints.length),meshes:document.meshes.length};
}

(async()=>{
 try{
  if(!process.env.SYSTEMA_TEST_URL){
   let active=false;try{active=(await fetch(BASE+'characters/catalog.json')).ok;}catch{}
   if(!active){
    server=spawn(PYTHON,[path.join(ROOT,'work/preview_pages.py'),'--port','8788','--directory',path.join(ROOT,'work')],{windowsHide:true,stdio:'ignore'});
    for(let attempt=0;attempt<150;attempt++){try{if((await fetch(BASE+'characters/catalog.json')).ok)break;}catch{}await new Promise(resolve=>setTimeout(resolve,200));}
   }
  }
  const catalogResponse=await fetch(BASE+'characters/catalog.json');assert(catalogResponse.ok,'Built-in catalog must be deployed');
  const catalog=CHARACTER_SOURCE?JSON.parse(fs.readFileSync(path.join(CHARACTER_SOURCE,'catalog.json'),'utf8')):await catalogResponse.json();assert.equal(catalog.schemaVersion,1);assert(catalog.models.length>=3,'Ship at least three free characters');
  assert.equal(new Set(catalog.models.map(model=>model.id)).size,catalog.models.length);
  for(const model of catalog.models){
   assert.match(model.id,/^builtin-[a-z0-9_-]+$/);for(const key of ['name','creator','source','license','licenseUrl'])assert(model[key],`Missing ${key} for ${model.id}`);
   assert.match(model.source,/^https:\/\//);assert.match(model.licenseUrl,/^https:\/\//);
   const url=new URL(model.file,BASE);assert.equal(url.origin,new URL(BASE).origin);
   const response=await fetch(url);assert(response.ok,`${model.name} must be deployed`);
   const bytes=CHARACTER_SOURCE?fs.readFileSync(path.join(CHARACTER_SOURCE,path.basename(url.pathname))):Buffer.from(await response.arrayBuffer());
   report.models.push({id:model.id,name:model.name,file:url.href,creator:model.creator,license:model.license,...inspectGLB(bytes)});
  }
  pass('The published catalog contains three or more licensed, self-contained humanoid GLBs with genuine weighted skins');
  browser=await chromium.launch({channel:'msedge',headless:true});
  const context=await browser.newContext({viewport:{width:1440,height:1100},acceptDownloads:true});
  const page=await context.newPage();page.setDefaultTimeout(60000);
  page.on('pageerror',error=>report.errors.push(error.message));
  page.on('response',response=>{if(response.status()>=400&&!response.url().endsWith('favicon.ico'))report.failed.push(response.url());});
  page.on('request',request=>report.requests.push({method:request.method(),url:request.url()}));
  if(CHARACTER_SOURCE)await page.route(new URL('characters/**',BASE).href,async route=>{
   const filename=path.join(CHARACTER_SOURCE,path.basename(new URL(route.request().url()).pathname));
   if(fs.existsSync(filename))await route.fulfill({body:fs.readFileSync(filename),contentType:filename.endsWith('.json')?'application/json':filename.endsWith('.png')?'image/png':'model/gltf-binary'});
   else await route.continue();
  });
  // Test-only, read-only access to the actual visible instances and scene state.
  await page.route(new URL('scene.js',BASE).href,async route=>{
   const response=await route.fetch();
   await route.fulfill({response,body:(await response.text())+'\nwindow.__systemaBuiltinTest=()=>({objects,motion,frame,camera,THREE,modelLibrary});'});
  });
  const ready=async()=>{
   await page.waitForFunction(()=>document.getElementById('studioStatus')?.dataset.state==='ready'&&document.getElementById('sceneVideo').readyState>=2&&document.getElementById('modelUpload')&&!document.getElementById('modelUpload').disabled,null,{timeout:60000});
   await page.locator('#modelDetails').evaluate(details=>details.open=true);
   await page.locator('.builtin-model-card').first().waitFor();
  };
  const card=id=>page.locator(`.builtin-model-card[data-model-id="${id}"]`);
  const customCount=async expected=>page.waitForFunction(expected=>Number(document.querySelector('#orbitStage canvas').dataset.customModelCount)===expected,expected,{timeout:60000});
  const scrub=async value=>{
   await page.locator('#sceneScrub').evaluate((input,value)=>{input.value=String(value);input.dispatchEvent(new Event('input'));},value);
   await page.waitForFunction(value=>window.__systemaBuiltinTest().frame===value,value);
  };
  const inspectRendered=async(id,frame)=>{
   await scrub(frame);
   const rows=await page.evaluate(({id,frame})=>{
    const {objects,motion,camera,THREE}=window.__systemaBuiltinTest(),rigs=[],rows=[];
    camera.updateMatrixWorld(true);
    for(const person of motion.frames[frame].people){
     const object=objects.get(String(person.id)),rig=object.customRigs.get(id);
     if(!rig?.group.visible)throw Error(`No visible ${id} for participant ${person.id}`);
     if(rigs.some(previous=>previous.skeletons.some(skeleton=>rig.skeletons.includes(skeleton))||previous.bones.some(bone=>rig.bones.includes(bone))))throw Error('Participants share live skeleton bones');
     rigs.push(rig);rig.group.updateWorldMatrix(true,true);
     const pelvis=new THREE.Vector3(...person.xyz[motion.jointNames.indexOf('pelvis')]);
     const pelvisError=rig.group.getWorldPosition(new THREE.Vector3()).distanceTo(pelvis);
     if(pelvisError>1e-7)throw Error(`Participant ${person.id} lost captured pelvis position`);
     const mappedPelvisError=rig.boneMap.get(rig.asset.mapping.pelvis).getWorldPosition(new THREE.Vector3()).distanceTo(pelvis);
     if(mappedPelvisError>1e-6)throw Error(`Participant ${person.id}'s mapped pelvis is offset from captured motion by ${mappedPelvisError}`);
     const box=new THREE.Box3(),point=new THREE.Vector3(),inverseGroup=rig.group.matrixWorld.clone().invert();let vertices=0,skinnedVertices=0;
     const witness=[],localWitness=[];
     for(const mesh of rig.meshes)for(let index=0;index<mesh.geometry.attributes.position.count;index++){
      mesh.getVertexPosition(index,point).applyMatrix4(mesh.matrixWorld);
      if(!point.toArray().every(Number.isFinite))throw Error(`Non-finite deformed vertex for ${id}`);
      box.expandByPoint(point);vertices++;if(mesh.isSkinnedMesh)skinnedVertices++;
      if(witness.length<12&&index%Math.max(1,Math.floor(mesh.geometry.attributes.position.count/4))===0){witness.push(point.toArray());localWitness.push(point.clone().applyMatrix4(inverseGroup).toArray());}
     }
     const directions=[];
     for(const side of ['left','right'])for(const [from,to] of [['shoulder','elbow'],['elbow','wrist'],['hip','knee'],['knee','ankle']]){
      const a=`${side}_${from}`,b=`${side}_${to}`,boneA=rig.boneMap.get(rig.asset.mapping[a]),boneB=rig.boneMap.get(rig.asset.mapping[b]);
      if(!boneA||!boneB)throw Error(`Required ${a}/${b} mapping is missing`);
      const actual=boneB.getWorldPosition(new THREE.Vector3()).sub(boneA.getWorldPosition(new THREE.Vector3())).normalize();
      const desired=new THREE.Vector3(...person.xyz[motion.jointNames.indexOf(b)]).sub(new THREE.Vector3(...person.xyz[motion.jointNames.indexOf(a)])).normalize();
      desired.applyAxisAngle(new THREE.Vector3(0,1,0),THREE.MathUtils.degToRad(rig.asset.settings.yawDegrees));
      const cosine=actual.dot(desired),describe=bone=>({name:bone.name,parent:bone.parent?.name,position:bone.position.toArray(),scale:bone.scale.toArray(),worldPosition:bone.getWorldPosition(new THREE.Vector3()).toArray(),worldQuaternion:bone.getWorldQuaternion(new THREE.Quaternion()).toArray(),restWorldPosition:rig.asset.restWorld.get(bone.name)?.position.toArray()});
      directions.push({from:a,to:b,cosine,actual:actual.toArray(),desired:desired.toArray(),boneA:describe(boneA),boneB:describe(boneB)});
     }
     rows.push({model:id,frame,id:person.id,pelvisError,mappedPelvisError,vertices,skinnedVertices,worldBounds:[box.min.toArray(),box.max.toArray()],poseValid:rig.group.userData.customFigure.poseValid,directions,witness,localWitness});
    }
    return rows;
   },{id,frame});
   assert.equal(rows.length,4);assert(rows.every(row=>row.poseValid&&row.skinnedVertices>100),'All four visible figures must be genuinely skinned and animated');
   report.renderedInstances.push(...rows);
   for(const row of rows)for(const direction of row.directions)assert(direction.cosine>=.965,`${id} participant${row.id} ${direction.from}→${direction.to} points away from captured motion: ${direction.cosine}`);
   return rows;
  };
  const makePreview=async id=>{
   const image=await page.evaluate(id=>{
    const {modelLibrary,THREE}=window.__systemaBuiltinTest(),asset=modelLibrary.get(id),rig=asset.createInstance();
    const scene=new THREE.Scene();scene.background=new THREE.Color('#192b35');scene.add(rig.group);
    rig.group.updateMatrixWorld(true);for(const skeleton of rig.skeletons)skeleton.update();
    const bounds=new THREE.Box3(),point=new THREE.Vector3();
    for(const mesh of rig.meshes)for(let index=0;index<mesh.geometry.attributes.position.count;index++)bounds.expandByPoint(mesh.getVertexPosition(index,point).applyMatrix4(mesh.matrixWorld));
    const size=bounds.getSize(new THREE.Vector3()),center=bounds.getCenter(new THREE.Vector3()),dimension=Math.max(size.x,size.y,size.z);
    const up=asset.restWorld.get(asset.mapping.head).position.clone().sub(asset.restWorld.get(asset.mapping.pelvis).position).normalize();
    const across=asset.restWorld.get(asset.mapping.right_shoulder).position.clone().sub(asset.restWorld.get(asset.mapping.left_shoulder).position);
    across.addScaledVector(up,-across.dot(up)).normalize();const forward=new THREE.Vector3().crossVectors(across,up).normalize().negate();
    const camera=new THREE.PerspectiveCamera(35,300/360,dimension/100,dimension*100);
    const distance=Math.max(size.y,size.x/camera.aspect)/(2*Math.tan(THREE.MathUtils.degToRad(camera.fov/2)))*1.18+size.z/2;
    camera.position.copy(center).addScaledVector(forward,distance);camera.up.copy(up);camera.lookAt(center);
    scene.add(new THREE.HemisphereLight('#f4fbff','#44515b',2.1));
    const key=new THREE.DirectionalLight('#fff2df',3.3);key.position.copy(center).addScaledVector(forward,dimension*2).addScaledVector(up,dimension*1.5).addScaledVector(across,-dimension);scene.add(key);
    const rim=new THREE.DirectionalLight('#a4d5ff',1.4);rim.position.copy(center).addScaledVector(forward,-dimension).addScaledVector(up,dimension);scene.add(rim);
    const floor=new THREE.Mesh(new THREE.PlaneGeometry(dimension*5,dimension*5),new THREE.MeshStandardMaterial({color:'#223b48',roughness:1}));
    floor.rotation.x=-Math.PI/2;floor.position.set(center.x,bounds.min.y-dimension*.008,center.z);scene.add(floor);
    const renderer=new THREE.WebGLRenderer({antialias:true,preserveDrawingBuffer:true});renderer.setSize(300,360,false);renderer.setPixelRatio(1);
    renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1.15;
    renderer.render(scene,camera);const image=renderer.domElement.toDataURL('image/png');
    renderer.dispose();floor.geometry.dispose();floor.material.dispose();rig.dispose();return image;
   },id);
   const directory=path.join(OUT,'previews');fs.mkdirSync(directory,{recursive:true});
   const filename=path.join(directory,id+'.png');fs.writeFileSync(filename,Buffer.from(image.split(',')[1],'base64'));return filename;
  };
  await page.goto(BASE+'scene.html?clip=multiple-attackers&frame=60');await ready();
  assert.equal(await page.locator('.builtin-model-card').count(),catalog.models.length);
  assert.equal(await page.locator('.model-card').count(),0,'Built-in cards must not count against custom uploads');
  for(const model of catalog.models){
   const builtIn=card(model.id),text=await builtIn.textContent(),links=await builtIn.locator('a').evaluateAll(anchors=>anchors.map(anchor=>anchor.href));
   assert(text.includes(model.name));assert.equal(await builtIn.locator('a').first().getAttribute('title'),model.creator);assert.equal(await builtIn.locator('a').last().getAttribute('title'),model.license);
   assert(links.includes(model.source),`${model.name} source credit must be accessible`);assert(links.includes(model.licenseUrl),`${model.name} license must be accessible`);
   const preview=builtIn.locator('img.builtin-model-preview');assert.equal(await preview.count(),1,`${model.name} needs a gallery preview`);
   await preview.scrollIntoViewIfNeeded();await preview.evaluate(async image=>{await image.decode();});
   const picture=await preview.evaluate(image=>({src:image.currentSrc||image.src,width:image.naturalWidth,height:image.naturalHeight,alt:image.alt,complete:image.complete}));
   assert(picture.complete&&picture.width>0&&picture.height>0,`${model.name} gallery preview must load`);assert.equal(new URL(picture.src).origin,new URL(BASE).origin);assert.equal(picture.alt,model.name);
   report.models.find(row=>row.id===model.id).galleryPreview=picture;
  }
  pass('Separate built-in character cards show each creator, source and license without occupying any upload slots');
  pass('All three same-origin character gallery previews decode successfully and expose the character name');
  await page.locator('[data-scene-view="scene"]').click();
  for(const model of catalog.models){
   await page.waitForFunction(id=>document.querySelector(`.builtin-model-card[data-model-id="${id}"] [data-model-readiness]`)?.dataset.modelReadiness!=='loading',model.id,{timeout:60000});
   report.readiness=await page.locator('.builtin-model-card').evaluateAll(cards=>cards.map(card=>({id:card.dataset.modelId,state:card.querySelector('[data-model-readiness]').dataset.modelReadiness,message:card.querySelector('[data-model-readiness]').textContent})));
   if(await card(model.id).locator('[data-model-readiness]').getAttribute('data-model-readiness')==='error')report.loaderBones=await page.evaluate(async file=>{
    const {loadCustomModel}=await import(new URL('./custom-figure.js',location.href));
    const asset=await loadCustomModel(await (await fetch(new URL(file,document.baseURI))).arrayBuffer());
    const result={boneNames:asset.boneNames,automaticMapping:asset.mapping,missingRequired:asset.missingRequired};asset.dispose();return result;
   },model.file);
   assert.equal(await card(model.id).locator('[data-model-readiness]').getAttribute('data-model-readiness'),'ready',await card(model.id).textContent());
   await card(model.id).locator('[data-model-action="apply-all"]').click();
   await page.waitForFunction(id=>window.__systemaBuiltinTest().modelLibrary.hasReady(id),model.id,{timeout:60000});
   await card(model.id).locator('[data-model-readiness="ready"]').waitFor();await customCount(4);
   assert.equal(await page.locator('#figureStyle').inputValue(),`model:${model.id}`);
   report.models.find(row=>row.id===model.id).preview=await makePreview(model.id);
   await page.locator('[data-camera="front"]').click();
   const poses=[];
   for(const frame of [60,150,285]){
    poses.push(await inspectRendered(model.id,frame));
    await page.locator('#orbitStage').screenshot({path:path.join(OUT,`${model.id}-frame-${frame}-front.png`)});
   }
   for(let index=0;index<4;index++)assert(poses[0][index].localWitness.some((point,vertex)=>point.some((value,axis)=>Math.abs(value-poses[2][index].localWitness[vertex][axis])>.005)),`${model.name} must deform its skin beyond a rigid root move`);
   await page.locator('[data-camera="side"]').click();
   await page.locator('#orbitStage').screenshot({path:path.join(OUT,`${model.id}-frame-285-side.png`)});
   pass(`${model.name} loads and retargets to four independent, finite skinned characters at three distinct poses`);
  }
  const [first,second,third]=catalog.models;
  await scrub(100);await page.locator('#sceneSpeed').selectOption('0.5');await page.locator('#sceneMute').click();await page.locator('#scenePlay').click();
  await page.waitForFunction(()=>!document.getElementById('sceneVideo').paused);
  const videoState=()=>page.locator('#sceneVideo').evaluate(video=>({time:video.currentTime,paused:video.paused,muted:video.muted,volume:video.volume,rate:video.playbackRate}));
  const before=await videoState();
  for(const model of [first,second,third,first]){
   await card(model.id).locator('[data-model-action="apply-all"]').click();await customCount(4);
   assert.equal(await page.locator('#figureStyle').inputValue(),`model:${model.id}`);
   const after=await videoState();assert(!after.paused);assert(after.time>=before.time-.1,'Character switches must not seek playback');
   assert.deepEqual([after.muted,after.volume,after.rate],[before.muted,before.volume,before.rate]);
  }
  await page.locator('#figure-style-2').selectOption(`model:${second.id}`);
  await page.locator('#figure-style-3').selectOption(`model:${third.id}`);await page.locator('#figure-style-4').selectOption('skeleton');
  await customCount(3);assert.equal(await page.locator('#figureStyle').inputValue(),'mixed');
  assert.equal(await page.locator('#figure-style-1').inputValue(),`model:${first.id}`);
  assert.equal(await page.locator('#figure-style-2').inputValue(),`model:${second.id}`);
  assert.equal(await page.locator('#figure-style-3').inputValue(),`model:${third.id}`);
  assert.equal(await page.locator('#sceneVideo').evaluate(video=>video.paused),false);
  await page.locator('#scenePlay').click();await scrub(150);
  pass('Built-ins swap for everyone or one participant during playback while audio, speed and the current timeline continue');
  await page.locator('[data-camera="source"]').click();
  await page.locator('#orbitStage').screenshot({path:path.join(OUT,'mixed-characters-source-camera.png')});
  await page.locator('#modelLibrary').screenshot({path:path.join(OUT,'character-library-desktop.png')});
  const inspectStorage=()=>page.evaluate(async()=>{
   const databases=await indexedDB.databases(),records=[];
   for(const entry of databases){
    const db=await new Promise((resolve,reject)=>{const request=indexedDB.open(entry.name);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
    for(const name of db.objectStoreNames){
     const rows=await new Promise((resolve,reject)=>{const request=db.transaction(name,'readonly').objectStore(name).getAll();request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
     records.push({database:entry.name,store:name,count:rows.length,ids:rows.map(row=>row?.id),bytes:rows.some(row=>row?.bytes instanceof ArrayBuffer||row?.bytes instanceof Blob)});
    }
    db.close();
   }
   return records;
  });
  report.storageBeforeReload=await inspectStorage();assert(report.storageBeforeReload.every(store=>store.count===0),'Built-in model bytes must not be duplicated in IndexedDB');
  await page.reload();await ready();await customCount(3);
  for(const [person,style] of [['1',`model:${first.id}`],['2',`model:${second.id}`],['3',`model:${third.id}`],['4','skeleton']])assert.equal(await page.locator(`#figure-style-${person}`).inputValue(),style);
  assert.equal(await page.locator('.model-card').count(),0);report.storageAfterReload=await inspectStorage();assert(report.storageAfterReload.every(store=>store.count===0));
  pass('Per-person built-in choices restore after reload; built-in GLB bytes are never stored in the upload database');
  for(const width of [390,768]){
   await page.setViewportSize({width,height:width===390?844:1024});await page.locator('[data-scene-view="scene"]').click();
   assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Character controls must fit the viewport');
   assert(await card(first.id).locator('[data-model-action="apply-all"]').isVisible());
   await page.locator('#modelLibrary').screenshot({path:path.join(OUT,`character-library-${width}.png`)});
  }
  const origin=new URL(BASE).origin;
  assert.deepEqual(report.requests.filter(request=>!['GET','HEAD'].includes(request.method)),[],'Character bytes must never be uploaded');
  assert.deepEqual(report.requests.filter(request=>/^https?:/.test(request.url)&&new URL(request.url).origin!==origin),[],'Built-in characters must not fetch third-party runtime files');
  assert.deepEqual(report.errors,[]);assert.deepEqual(report.failed,[]);
  pass('Character controls fit phone and tablet; all runtime assets are local with no POST requests or JavaScript/network failures');
 }catch(error){report.failure=error.stack||String(error);throw error;}
 finally{
  fs.writeFileSync(path.join(OUT,'verification.json'),JSON.stringify(report,null,2));
  if(browser)await browser.close();if(server)server.kill();
 }
})().catch(error=>{console.error(error);process.exitCode=1;});

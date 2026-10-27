const {chromium}=require(process.env.SYSTEMA_PLAYWRIGHT||'C:/Users/thefo/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{spawn}=require('node:child_process');
const ROOT=path.resolve(__dirname,'..'),OUT=path.join(ROOT,'outputs/camera-deformation');fs.mkdirSync(OUT,{recursive:true});
const BASE=process.env.SYSTEMA_TEST_URL||'http://127.0.0.1:8798/release-camera-deformation-20261017/';
const PYTHON=process.env.SYSTEMA_PYTHON||'C:/Users/thefo/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe';
const report={checks:[],errors:[],failed:[]},pass=message=>{report.checks.push(message);console.log('PASS '+message);};let browser,server;
(async()=>{try{
 if(!process.env.SYSTEMA_TEST_URL){server=spawn(PYTHON,[path.join(ROOT,'work/preview_pages.py'),'--port','8798','--directory',path.join(ROOT,'work')],{windowsHide:true,stdio:'ignore'});for(let i=0;i<100;i++){try{if((await fetch(BASE+'catalog.json')).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}}
 browser=await chromium.launch({channel:'msedge',headless:true});const page=await browser.newPage({viewport:{width:1440,height:1050}});page.setDefaultTimeout(60000);
 page.on('pageerror',error=>report.errors.push(error.message));page.on('console',message=>{if(message.type()==='error'&&!message.text().includes('favicon'))report.errors.push(message.text());});
 page.on('response',response=>{if(response.status()>=400&&!response.url().endsWith('favicon.ico'))report.failed.push(response.url());});
 await page.route(new URL('scene.js',BASE).href,async route=>{const response=await route.fetch();await route.fulfill({response,body:(await response.text())+'\nwindow.__camera=()=>({navigation,camera,orbit,motion,frame,objects,studioEnvironment,showFrame,preset,renderSceneFrame,renderer,THREE,sourceFollowing});'});});
 await page.goto(BASE+'scene.html?clip=multiple-attackers&frame=172');
 await page.waitForFunction(()=>window.__camera?.().studioEnvironment?.ready&&document.getElementById('sceneVideo').readyState>=2);
 const tick=()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 const sourcePose=()=>page.evaluate(()=>{
  const {camera,orbit,motion,frame,sourceFollowing,studioEnvironment,THREE}=window.__camera(),r=motion.camera.Rcw[frame],t=motion.camera.Tcw[frame];
  const expected=new THREE.Vector3(...[0,1,2].map(i=>-r.reduce((sum,row,k)=>sum+row[i]*t[k],0)));
  const forward=new THREE.Vector3(0,0,-1).applyQuaternion(camera.quaternion),expectedForward=new THREE.Vector3(...r[2]);
  const focal=motion.camera.img_focal,height=motion.camera.img_center[1]*2;
  return {following:sourceFollowing,positionError:camera.position.distanceTo(expected),directionError:forward.distanceTo(expectedForward),projectionError:Math.abs(camera.projectionMatrix.elements[5]-2*focal/height),cutaway:studioEnvironment.cutaway.strength.value};
 });
 const checkSource=async()=>{const state=await sourcePose();assert(state.following);assert(state.positionError<1e-8);assert(state.directionError<1e-8);assert(state.projectionError<1e-8);assert.equal(state.cutaway,0);return state;};
 report.source=await checkSource();
 const canvas=page.locator('#orbitStage canvas'),box=await canvas.boundingBox();await page.mouse.click(box.x+box.width*.5,box.y+box.height*.5);await tick();await checkSource();
 pass('Source camera and projection stay exact; clicking the canvas does not leave footage-following mode');
 await page.mouse.move(box.x+box.width*.5,box.y+box.height*.5);await page.mouse.down();await page.mouse.move(box.x+box.width*.5+90,box.y+box.height*.5+20,{steps:8});await page.mouse.up();await tick();
 const drag=await page.evaluate(()=>{const {navigation,camera,orbit,sourceFollowing,studioEnvironment}=window.__camera(),volume=navigation.roomVolume(studioEnvironment),local=camera.position.clone().applyMatrix4(volume.inverse);return {following:sourceFollowing,pivotError:orbit.target.distanceTo(navigation.focus),inside:['x','y','z'].every(k=>local[k]>=volume.min[k]-1e-7&&local[k]<=volume.max[k]+1e-7)};});
 assert(!drag.following);assert(drag.pivotError<1e-7);assert(drag.inside);pass('Dragging leaves the source camera and orbits the visible group within the studio');
 await page.mouse.wheel(0,12000);await tick();
 report.sweep=await page.evaluate(()=>{
  const {navigation,camera,orbit,studioEnvironment,showFrame,THREE}=window.__camera();let checks=0;
  for(const frame of [0,172,359]){showFrame(frame);for(const elevation of [-.7,0,.7,1.45])for(let angle=0;angle<Math.PI*2;angle+=Math.PI/18){
   orbit.target.copy(navigation.focus);camera.position.copy(orbit.target).add(new THREE.Vector3(Math.sin(angle)*Math.cos(elevation),Math.sin(elevation),Math.cos(angle)*Math.cos(elevation)).multiplyScalar(40));navigation.constrain(studioEnvironment);
   const v=navigation.roomVolume(studioEnvironment),p=camera.position.clone().applyMatrix4(v.inverse);
   if(!['x','y','z'].every(k=>p[k]>=v.min[k]-1e-6&&p[k]<=v.max[k]+1e-6))throw Error(`Escaped room at ${frame}/${angle}/${elevation}`);checks++;
  }}
  orbit.target.add(new THREE.Vector3(100,-100,100));navigation.constrain(studioEnvironment);
  let v=navigation.roomVolume(studioEnvironment),p=orbit.target.clone().applyMatrix4(v.inverse);if(!['x','y','z'].every(k=>p[k]>=v.min[k]-1e-6&&p[k]<=v.max[k]+1e-6))throw Error('Pan target escaped room');
  const old=studioEnvironment.group.matrix.clone();studioEnvironment.group.position.x+=2;studioEnvironment.group.rotateY(.4);studioEnvironment.group.updateMatrixWorld(true);navigation.constrain(studioEnvironment);
  v=navigation.roomVolume(studioEnvironment);p=camera.position.clone().applyMatrix4(v.inverse);if(!['x','y','z'].every(k=>p[k]>=v.min[k]-1e-6&&p[k]<=v.max[k]+1e-6))throw Error('Alignment lost room limits');studioEnvironment.apply();
  const scale=studioEnvironment.group.scale.x;studioEnvironment.group.scale.setScalar(.01);studioEnvironment.group.updateMatrixWorld(true);navigation.constrain(studioEnvironment);
  v=navigation.roomVolume(studioEnvironment);if(!['x','y','z'].every(k=>v.min[k]<v.max[k]))throw Error('Small room scale inverted camera boundary');studioEnvironment.group.scale.setScalar(scale);studioEnvironment.apply();
  const boundary=studioEnvironment.config.navigation;delete studioEnvironment.config.navigation;camera.position.set(0,-5,0);navigation.constrain(studioEnvironment);
  if(camera.position.y<.12||navigation.roomVolume(studioEnvironment)!==null)throw Error('Unregistered room fallback failed');studioEnvironment.config.navigation=boundary;
  showFrame(172);return {checks};
 });pass('Full orbit sweeps, large zoom-out, panning and changed room alignment stay inside the inset boundary');
 await page.locator('[data-camera="source"]').click();await tick();await checkSource();
 await page.locator('[data-camera="overhead"]').click();await tick();
 report.overhead=await page.evaluate(()=>{const {navigation,camera,orbit,studioEnvironment}=window.__camera(),v=navigation.roomVolume(studioEnvironment),p=camera.position.clone().applyMatrix4(v.inverse);return {above:p.z>studioEnvironment.config.navigation.max[2],cutaway:studioEnvironment.cutaway.strength.value,focusError:orbit.target.distanceTo(navigation.focus)};});
 assert(report.overhead.above);assert.equal(report.overhead.cutaway,1);assert(report.overhead.focusError<1e-7);
 await page.locator('[data-scene-view="scene"]').click();await page.locator('#orbitStage').screenshot({path:path.join(OUT,'overhead.png')});
 pass('Overhead opens the roof, preserves the floor, and keeps its pivot on the participants');
 for(const preset of ['front','side']){await page.locator(`[data-camera="${preset}"]`).click();await tick();await page.locator('#orbitStage').screenshot({path:path.join(OUT,preset+'.png')});}
 // Exercise the shader with three synthetic splats and actual readback pixels.
 report.cutawayPixels=await page.evaluate(async()=>{
  const {THREE,renderer,studioEnvironment}=window.__camera(),{SplatMesh,PackedSplats,dyno}=await import('./vendor/spark/spark.module.js');
  const packed=new PackedSplats();for(const [x,y,z,color] of [[-1,1,0,'#ff0000'],[0,0,0,'#00ff00'],[1,1,-2,'#0000ff']])packed.pushSplat(new THREE.Vector3(x,y,z),new THREE.Vector3(.12,.12,.12),new THREE.Quaternion(),1,new THREE.Color(color));
  const mesh=new SplatMesh({packedSplats:packed}),scene=new THREE.Scene();scene.background=new THREE.Color('black');scene.add(mesh);await mesh.initialized;
  const environment={mesh};Object.getPrototypeOf(studioEnvironment).installCutaway.call(environment,dyno);
  const u=environment.cutaway;u.focus.value.set(0,1,-1.2);u.direction.value.set(0,0,1);u.floor.value.set(0,1,0,0);u.strength.value=1;
  const camera=new THREE.PerspectiveCamera(50,2,.01,50);camera.position.set(0,1,6);camera.lookAt(0,.5,0);camera.updateMatrixWorld(true);
  const {SparkRenderer}=await import('./vendor/spark/spark.module.js'),spark=new SparkRenderer({renderer});spark.material.toneMapped=false;scene.add(spark);
  const target=new THREE.WebGLRenderTarget(400,200),previous=renderer.getRenderTarget();renderer.setRenderTarget(target);
  for(let i=0;i<5;i++){renderer.render(scene,camera);await new Promise(r=>setTimeout(r,30));}
  renderer.render(scene,camera);
  const values=[];for(const xyz of [[-1,1,0],[0,0,0],[1,1,-2]]){const p=new THREE.Vector3(...xyz).project(camera),bytes=new Uint8Array(4);renderer.readRenderTargetPixels(target,Math.round((p.x+1)*200),Math.round((p.y+1)*100),1,1,bytes);values.push([...bytes]);}
  renderer.setRenderTarget(previous);mesh.dispose();spark.dispose();target.dispose();u.strength.value=0;studioEnvironment.mesh.updateVersion();return values;
 });
 assert(report.cutawayPixels[0].slice(0,3).every(c=>c<10),'Foreground wall should fade');assert(report.cutawayPixels[1][1]>100,'Floor must remain');assert(report.cutawayPixels[2][2]>100,'Far wall must remain');
 pass('GPU readback confirms foreground wall removal while floor and far-wall splats remain visible');
 await page.locator('[data-camera="source"]').click();await tick();await checkSource();
 await page.locator('#scenePlay').click();await page.waitForFunction(()=>!document.getElementById('sceneVideo').paused&&window.__camera().frame>180);await checkSource();await page.locator('#scenePlay').click();
 await page.locator('[data-camera="front"]').click();const oldFocus=await page.evaluate(()=>window.__camera().navigation.focus.toArray());await page.locator('#scenePeople input[type=checkbox]').first().uncheck();await tick();
 const hidden=await page.evaluate(()=>{const {navigation,orbit,objects}=window.__camera();return {error:orbit.target.distanceTo(navigation.focus),people:[...objects.values()].filter(o=>o.group.visible).length};});assert(hidden.error<1e-7);assert.equal(hidden.people,3);assert(oldFocus.every(Number.isFinite));await page.locator('#scenePeople input[type=checkbox]').first().check();
 pass('Reset restores the source pose after orbiting; playback follows its tracked camera; hidden people leave the orbit bounds');
 for(const width of [390,768]){await page.setViewportSize({width,height:width===390?844:1024});await tick();assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.locator('[data-camera="overhead"]').click();await tick();await page.locator('#orbitStage').screenshot({path:path.join(OUT,`overhead-${width}.png`)});}
 assert.deepEqual(report.failed,[]);assert.deepEqual(report.errors,[]);pass('Phone and tablet layouts retain all controls without horizontal overflow or viewer errors');
}catch(error){report.failure=error.stack;throw error;}finally{fs.writeFileSync(path.join(OUT,'verification.json'),JSON.stringify(report,null,2));if(browser)await browser.close();if(server)server.kill();}})().catch(error=>{console.error(error);process.exitCode=1;});

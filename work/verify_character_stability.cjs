// Check real captured frames and actual depth-buffer output for character stability.
const {chromium}=require(process.env.SYSTEMA_PLAYWRIGHT||'C:/Users/thefo/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const ROOT=path.resolve(__dirname,'..'),PUBLIC=path.join(ROOT,'teaching_suite/public');
const OUT=path.join(ROOT,'outputs/character-stability');fs.mkdirSync(OUT,{recursive:true});
const BASE=process.env.SYSTEMA_TEST_URL||'http://127.0.0.1:8794/release-strikes-final-20261017/';
const PYTHON=process.env.SYSTEMA_PYTHON||'C:/Users/thefo/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe';
const report={base:BASE,checks:[],models:[],errors:[],failed:[]};
const pass=message=>{report.checks.push(message);console.log('PASS '+message);};
let server,browser;
(async()=>{try{
 if(!process.env.SYSTEMA_TEST_URL){
  try{if(!(await fetch(BASE+'catalog.json')).ok)throw Error();}
  catch{server=spawn(PYTHON,[path.join(ROOT,'work/preview_pages.py'),'--port','8794','--directory',path.join(ROOT,'work')],{windowsHide:true,stdio:'ignore'});
   for(let i=0;i<100;i++){try{if((await fetch(BASE+'catalog.json')).ok)break;}catch{}await new Promise(resolve=>setTimeout(resolve,200));}}
 }
 browser=await chromium.launch({channel:'msedge',headless:true});
 const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage();
 page.setDefaultTimeout(60000);
 page.on('pageerror',error=>report.errors.push(error.message));
 page.on('response',response=>{if(response.status()>=400&&!response.url().endsWith('favicon.ico'))report.failed.push(response.url());});
 // Optional source overlay exercises new JS against an existing prepared media build.
 if(process.env.SYSTEMA_TEST_SOURCE==='1')await page.route('**/*',async route=>{
  const url=new URL(route.request().url()),base=new URL(BASE);
  if(url.origin!==base.origin||!url.pathname.startsWith(base.pathname))return route.continue();
  const relative=decodeURIComponent(url.pathname.slice(base.pathname.length)),local=path.resolve(PUBLIC,relative);
  if(!local.startsWith(PUBLIC+path.sep)||!fs.existsSync(local)||!fs.statSync(local).isFile()||!/[.](?:js|mjs|html|css|json)$/.test(local))return route.continue();
  let body=fs.readFileSync(local,'utf8');
  if(relative==='scene.html')body=body.replace('<script type="module" src="scene.js">','<script src="site-data.js"></script><script type="module" src="scene.js">').replace('src="media/source-reference.mp4"','').replaceAll('href="/?demo=1"','href="./"');
  if(relative==='scene.js')body+='\nwindow.__stability=()=>({objects,motion,frame,renderer,world,camera,studioEnvironment,modelLibrary,showFrame,renderSceneFrame,THREE});';
  return route.fulfill({body,contentType:/[.](?:js|mjs)$/.test(local)?'application/javascript':local.endsWith('.html')?'text/html':local.endsWith('.css')?'text/css':'application/json'});
 });
 else await page.route(new URL('scene.js',BASE).href,async route=>{const response=await route.fetch();await route.fulfill({response,body:(await response.text())+'\nwindow.__stability=()=>({objects,motion,frame,renderer,world,camera,studioEnvironment,modelLibrary,showFrame,renderSceneFrame,THREE});'});});
 await page.goto(BASE+'scene.html?clip=multiple-attackers&frame=60');
 await page.waitForFunction(()=>window.__stability?.().studioEnvironment?.ready&&window.__stability().modelLibrary.getBuiltinEntries().length>=3&&document.querySelectorAll('[data-model-readiness="ready"]').length>=3);
 await page.locator('#figureDetails').evaluate(element=>element.open=true);
 await page.locator('#modelDetails').evaluate(element=>element.open=true);
 await page.locator('#studioXray').check();
 const ids=await page.evaluate(()=>window.__stability().modelLibrary.getBuiltinEntries().map(entry=>entry.id));
 for(const id of ids){
  await page.locator('#figureStyle').selectOption('model:'+id);
  const result=await page.evaluate(id=>{
   const {objects,motion,showFrame}=window.__stability(),visited=new Set(),qualityFlags=new Set();let poses=0,absent=0;
   for(let frame=0;frame<motion.frames.length;frame++){
    showFrame(frame);const people=motion.frames[frame].people,present=new Set(people.map(person=>String(person.id)));
    for(const [personId,object] of objects){
     if(object.group.visible!==present.has(personId))throw Error(`Visibility differs from captured presence at ${frame}/${personId}`);
     if(!present.has(personId)){absent++;continue;}
     const rig=object.customRigs.get(id);
     if(!rig?.group.visible||!rig.group.userData.customFigure.poseValid)throw Error(`Character disappeared at ${frame}/${personId}`);
     for(const record of rig.materials){
      const material=record.material;
      if(material.opacity!==record.baseOpacity||material.transparent!==record.baseTransparent)throw Error(`Character changed opacity/render queue at ${frame}/${personId}`);
      if(!material.depthTest||!material.depthWrite)throw Error(`Character surface depth was disabled at ${frame}/${personId}`);
     }
     if(rig.meshes.some(mesh=>mesh.frustumCulled))throw Error('Moving skinned bounds can be culled');
     visited.add(personId);poses++;
    }
    for(const person of people){if(person.sourceBoxInterpolated)qualityFlags.add('interpolated');if(person.overlappingSourceBoxes?.length)qualityFlags.add('overlap');}
   }
   showFrame(150);return {id,frames:motion.frames.length,poses,absent,participants:[...visited],qualityFlags:[...qualityFlags]};
  },id);
  assert.equal(result.frames,360);assert.equal(result.participants.length,4);assert(result.poses>1300);assert.deepEqual(result.qualityFlags.sort(),['interpolated','overlap']);
  report.models.push(result);pass(`${id}: all 360 frames keep each available captured character solid, depth-tested and uncullable`);
 }
 const renderCheck=await page.evaluate(()=>{
  const state=window.__stability(),{renderer,world,camera,studioEnvironment,renderSceneFrame,THREE}=state;
  const initial=world.children.map(child=>({child,visible:child.visible})),originalRender=renderer.render,originalClear=renderer.clearDepth;
  const events=[];
  renderer.render=function(scene,camera){events.push({type:'render',foreground:scene.children.filter(child=>child.userData.figureOverlay&&child.visible).length,environment:scene.children.filter(child=>!child.isLight&&!child.userData.figureOverlay&&child.visible).length,autoClear:this.autoClear,background:scene.background!==null});return originalRender.call(this,scene,camera);};
  renderer.clearDepth=function(){events.push({type:'clearDepth'});return originalClear.call(this);};
  renderSceneFrame();renderer.render=originalRender;renderer.clearDepth=originalClear;
  if(initial.some(({child,visible})=>child.visible!==visible))throw Error('Render pass leaked visibility state');
  const savedCamera={position:camera.position.clone(),quaternion:camera.quaternion.clone(),up:camera.up.clone(),projection:camera.projectionMatrix.clone(),inverse:camera.projectionMatrixInverse.clone()};
  const target=new THREE.WebGLRenderTarget(32,32),savedTarget=renderer.getRenderTarget(),foreground=new THREE.Group(),room=new THREE.Group();
  foreground.userData.figureOverlay=true;
  const geometry=new THREE.BoxGeometry(2,2,.1),materials=['#ff0000','#0000ff','#00ff00'].map(color=>new THREE.MeshBasicMaterial({color,toneMapped:false}));
  const near=new THREE.Mesh(geometry,materials[0]),far=new THREE.Mesh(geometry,materials[1]),wall=new THREE.Mesh(geometry,materials[2]);
  near.position.z=1;far.position.z=0;far.renderOrder=1000;wall.position.z=2;
  foreground.add(near,far);room.add(wall);world.add(foreground,room);
  const pixel=()=>{const bytes=new Uint8Array(4);renderer.readRenderTargetPixels(target,16,16,1,1,bytes);return [...bytes];};
  let throughRoom,withRoom;
  try{
   initial.forEach(({child})=>{child.visible=false;});camera.position.set(0,0,5);camera.up.set(0,1,0);camera.lookAt(0,0,0);camera.aspect=1;camera.fov=45;camera.updateProjectionMatrix();camera.updateMatrixWorld(true);renderer.setRenderTarget(target);
   studioEnvironment.xray=true;renderSceneFrame();throughRoom=pixel();
   studioEnvironment.xray=false;renderSceneFrame();withRoom=pixel();
  }finally{
   studioEnvironment.xray=true;renderer.setRenderTarget(savedTarget);initial.forEach(({child,visible})=>{child.visible=visible;});foreground.removeFromParent();room.removeFromParent();geometry.dispose();materials.forEach(material=>material.dispose());target.dispose();
   camera.position.copy(savedCamera.position);camera.quaternion.copy(savedCamera.quaternion);camera.up.copy(savedCamera.up);camera.projectionMatrix.copy(savedCamera.projection);camera.projectionMatrixInverse.copy(savedCamera.inverse);camera.updateMatrixWorld(true);
  }
  return {events,throughRoom,withRoom};
 });
 assert.deepEqual(renderCheck.events.map(event=>event.type),['render','clearDepth','render']);
 assert.equal(renderCheck.events[0].foreground,0);assert(renderCheck.events[0].environment>0);assert(renderCheck.events[2].foreground>0);assert.equal(renderCheck.events[2].environment,0);assert.equal(renderCheck.events[2].autoClear,false);assert.equal(renderCheck.events[2].background,false);
 assert(renderCheck.throughRoom[0]>240&&renderCheck.throughRoom[1]<5&&renderCheck.throughRoom[2]<5,'Near red figure must cover farther blue figure after room depth is cleared');
 assert(renderCheck.withRoom[1]>240&&renderCheck.withRoom[0]<5&&renderCheck.withRoom[2]<5,'Green room wall must occlude figures when through-walls is off');
 report.renderCheck=renderCheck;pass('Actual depth-buffer pixels preserve near/far figure occlusion while the room remains visible; switching through-walls off restores wall occlusion');
 await page.locator('#sceneScrub').evaluate(element=>{element.value='150';element.dispatchEvent(new Event('input'));});
 await page.locator('#orbitStage').screenshot({path:path.join(OUT,'stable-characters-overlap.png')});
 const gap=await page.evaluate(()=>{const {showFrame}=window.__stability();showFrame(0);return document.getElementById('frameQuality').textContent;});assert.match(gap,/no captured pose/);
 pass('Real missing captures remain absent and are explicitly described instead of inventing motion');
 assert.deepEqual(report.errors,[]);assert.deepEqual(report.failed,[]);
}catch(error){report.failure=error.stack;throw error;}finally{fs.writeFileSync(path.join(OUT,'verification.json'),JSON.stringify(report,null,2));if(browser)await browser.close();if(server)server.kill();}})().catch(error=>{console.error(error);process.exitCode=1;});

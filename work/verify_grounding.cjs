const {chromium}=require(process.env.SYSTEMA_PLAYWRIGHT||'C:/Users/thefo/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{spawn}=require('node:child_process');
const ROOT=path.resolve(__dirname,'..'),OUT=path.join(ROOT,'outputs/grounding');fs.mkdirSync(OUT,{recursive:true});
const BASE=process.env.SYSTEMA_TEST_URL||'http://127.0.0.1:8797/release-grounding-20261017/';
const PYTHON=process.env.SYSTEMA_PYTHON||'C:/Users/thefo/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe';
const report={base:BASE,checks:[],errors:[],failed:[]};const pass=text=>{report.checks.push(text);console.log('PASS '+text);};let browser,server;
(async()=>{try{
 if(!process.env.SYSTEMA_TEST_URL){server=spawn(PYTHON,[path.join(ROOT,'work/preview_pages.py'),'--port','8797','--directory',path.join(ROOT,'work')],{windowsHide:true,stdio:'ignore'});for(let i=0;i<100;i++){try{if((await fetch(BASE+'catalog.json')).ok)break;}catch{}await new Promise(resolve=>setTimeout(resolve,100));}}
 browser=await chromium.launch({channel:'msedge',headless:true});const page=await browser.newPage({viewport:{width:1440,height:1050}});page.setDefaultTimeout(60000);
 page.on('pageerror',e=>report.errors.push(e.message));page.on('response',r=>{if(r.status()>=400&&!r.url().endsWith('favicon.ico'))report.failed.push(r.url());});
 await page.route(new URL('scene.js',BASE).href,async route=>{const response=await route.fetch();await route.fulfill({response,body:(await response.text())+'\nwindow.__grounding=()=>({objects,motion,frame,contactShadows,renderer,world,THREE,showFrame,renderSceneFrame});'});});
 await page.goto(BASE+'scene.html?clip=multiple-attackers&frame=150');await page.waitForFunction(()=>window.__grounding?.().contactShadows?.mesh.count===12&&document.getElementById('studioStatus').dataset.state==='ready'&&document.querySelectorAll('.builtin-model-card [data-model-readiness="ready"]').length===3);
 const facing=await page.evaluate(()=>{
  const {objects,motion,showFrame,THREE}=window.__grounding(),names=motion.jointNames;let count=0,minDot=1;
  for(let frame=0;frame<motion.frames.length;frame++){
   showFrame(frame);for(const person of motion.frames[frame].people){
    const rig=objects.get(String(person.id)).rig,head=rig.bones[names.indexOf('head')];
    const forward=new THREE.Vector3(0,0,1).transformDirection(head.matrixWorld),toe=new THREE.Vector3();
    for(const side of ['left','right'])toe.add(new THREE.Vector3(...person.xyz[names.indexOf(side+'_foot')]).sub(new THREE.Vector3(...person.xyz[names.indexOf(side+'_ankle')])));
    toe.y=0;if(toe.length()>.07){const dot=forward.dot(toe.normalize());if(dot<=0)throw Error(`Head points behind the feet at ${frame}/${person.id}`);minDot=Math.min(minDot,dot);count++;}
   }
  }
  showFrame(150);return {count,minDot};
 });report.facing=facing;pass('Mannequin head fronts face with the captured feet across every available pose, preserving all tracked joint positions');
 const shadows=await page.evaluate(()=>{
  const {contactShadows,motion,showFrame,objects}=window.__grounding(),visible=new Set(objects.keys());showFrame(150);
  const first=Array.from(contactShadows.mesh.instanceMatrix.array),alpha=Array.from(contactShadows.opacity);
  showFrame(230);showFrame(150);if(first.some((value,i)=>Math.abs(value-contactShadows.mesh.instanceMatrix.array[i])>1e-7))throw Error('Scrub order changes shadow placement');
  const people=structuredClone(motion.frames[150].people),indices=contactShadows.indices;
  for(const name of ['left_ankle','left_foot'])people[0].xyz[indices.get(name)][1]+=1;
  contactShadows.update(people,visible);if(contactShadows.opacity[1]>=alpha[1]*.2)throw Error('Lifted foot shadow is too dark');
  showFrame(149);showFrame(150);
  const started=performance.now();for(let i=0;i<1000;i++)contactShadows.update(motion.frames[150].people,visible);
  const milliseconds=(performance.now()-started)/1000;
  return {count:contactShadows.mesh.count,milliseconds,floorY:contactShadows.mesh.instanceMatrix.array[13],textures:contactShadows.mesh.material.uniforms};
 });assert.equal(shadows.count,12);assert(Math.abs(shadows.floorY-.006)<1e-6);assert(shadows.milliseconds<.5);report.shadows=shadows;
 pass('One batched floor layer follows both feet and body, fades for lifted feet, and is deterministic when scrubbing');
 report.drawCalls=[];
 for(const style of ['mannequin','dummy','model:builtin-robot','model:builtin-hero-male']){
  await page.locator('#figureStyle').selectOption(style);
  const draw=await page.evaluate(()=>{const {contactShadows,renderer,renderSceneFrame}=window.__grounding(),auto=renderer.info.autoReset;renderer.info.autoReset=false;
   contactShadows.group.visible=false;renderer.info.reset();renderSceneFrame();const without={...renderer.info.render};
   contactShadows.group.visible=true;renderer.info.reset();renderSceneFrame();const withShadow={...renderer.info.render};renderer.info.autoReset=auto;
   return {extraCalls:withShadow.calls-without.calls,extraTriangles:withShadow.triangles-without.triangles,shadowMaps:renderer.shadowMap.enabled};});
  assert.equal(draw.extraCalls,1);assert.equal(draw.extraTriangles,24);assert.equal(draw.shadowMaps,false);report.drawCalls.push({style,...draw});
 }
 pass('Actual render statistics add exactly one draw call and 24 triangles for four characters, with no shadow maps');
 await page.locator('#scenePeople input').first().uncheck();assert.equal(await page.evaluate(()=>window.__grounding().contactShadows.mesh.count),9);await page.locator('#scenePeople input').first().check();
 await page.locator('#figureStyle').selectOption('mannequin');await page.locator('[data-scene-view="scene"]').click();await page.locator('[data-camera="front"]').click();
 await page.evaluate(()=>{const {contactShadows,renderSceneFrame}=window.__grounding();contactShadows.group.visible=false;renderSceneFrame();});await page.locator('#orbitStage').screenshot({path:path.join(OUT,'shadows-off.png')});
 await page.evaluate(()=>{const {contactShadows,renderSceneFrame}=window.__grounding();contactShadows.group.visible=true;renderSceneFrame();});await page.locator('#orbitStage').screenshot({path:path.join(OUT,'shadows-on.png')});
 assert.deepEqual(report.errors,[]);assert.deepEqual(report.failed,[]);pass('Hidden participants lose their shadows; all viewer assets render without JavaScript or network errors');
}catch(error){report.failure=error.stack;throw error;}finally{fs.writeFileSync(path.join(OUT,'verification.json'),JSON.stringify(report,null,2));if(browser)await browser.close();if(server)server.kill();}})().catch(error=>{console.error(error);process.exitCode=1;});

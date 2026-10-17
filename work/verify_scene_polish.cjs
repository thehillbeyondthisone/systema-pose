const {chromium}=require(process.env.SYSTEMA_PLAYWRIGHT||'C:/Users/thefo/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{spawn}=require('node:child_process');
const ROOT=path.resolve(__dirname,'..'),OUT=path.join(ROOT,'outputs/scene-polish');fs.mkdirSync(OUT,{recursive:true});
const BASE=process.env.SYSTEMA_TEST_URL||'http://127.0.0.1:8795/release-polish-final-20261017/';
const PYTHON=process.env.SYSTEMA_PYTHON||'C:/Users/thefo/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe';
const report={base:BASE,checks:[],errors:[],failed:[]};const pass=text=>{report.checks.push(text);console.log('PASS '+text);};let server,browser;
function largeGLB(){
 const source=fs.readFileSync(path.join(ROOT,'outputs/custom-models/Coastal Rig.glb')),length=source.readUInt32LE(12),document=JSON.parse(source.subarray(20,20+length));
 const binary=source.subarray(28+length),size=65*1024*1024;let json;
 for(let i=0;i<4;i++){const raw=Buffer.from(JSON.stringify(document));json=Buffer.concat([raw,Buffer.alloc((4-raw.length%4)%4,32)]);document.buffers[0].byteLength=size-28-json.length;}
 const result=Buffer.alloc(size);result.writeUInt32LE(0x46546c67,0);result.writeUInt32LE(2,4);result.writeUInt32LE(size,8);
 result.writeUInt32LE(json.length,12);result.writeUInt32LE(0x4e4f534a,16);json.copy(result,20);
 result.writeUInt32LE(size-28-json.length,20+json.length);result.writeUInt32LE(0x004e4942,24+json.length);binary.copy(result,28+json.length);
 const filename=path.join(OUT,'65 MB Rig.glb');fs.writeFileSync(filename,result);return filename;
}
(async()=>{try{
 if(!process.env.SYSTEMA_TEST_URL){
  server=spawn(PYTHON,[path.join(ROOT,'work/preview_pages.py'),'--port','8795','--directory',path.join(ROOT,'work')],{windowsHide:true,stdio:'ignore'});
  for(let i=0;i<100;i++){try{if((await fetch(BASE+'catalog.json')).ok)break;}catch{}await new Promise(resolve=>setTimeout(resolve,100));}
 }
 browser=await chromium.launch({channel:'msedge',headless:true});const context=await browser.newContext({viewport:{width:1440,height:1050}}),page=await context.newPage();page.setDefaultTimeout(60000);
 page.on('pageerror',error=>report.errors.push(error.message));page.on('response',response=>{if(response.status()>=400&&!response.url().endsWith('favicon.ico'))report.failed.push(response.url());});
 await page.route(new URL('scene.js',BASE).href,async route=>{const response=await route.fetch();await route.fulfill({response,body:(await response.text())+'\nwindow.__polish=()=>({objects,motion,frame,world,renderer,studioLighting,studioEnvironment,modelLibrary,strikeCues,THREE});'});});
 const ready=async()=>page.waitForFunction(()=>window.__polish?.().studioEnvironment?.ready&&document.querySelectorAll('.builtin-model-card [data-model-readiness="ready"]').length===3&&!document.getElementById('modelUpload').disabled&&document.getElementById('sceneVideo').readyState>=2);
 await page.goto(BASE+'scene.html?clip=multiple-attackers&frame=230');await ready();
 assert(!await page.locator('#debugMenu').isVisible());assert(!await page.locator('#modelUpload').isVisible());assert(!await page.locator('#contactDetails').isVisible());assert(!await page.locator('#contactEffects').isChecked());
 assert.equal(await page.locator('.builtin-model-card [data-model-participant]').count(),0);
 assert((await page.locator('#modelLibrary').boundingBox()).height<225);
 const lighting=await page.evaluate(()=>{
  const {studioLighting,studioEnvironment,world,THREE,objects}=window.__polish();studioLighting.sync(studioEnvironment);
  const expected=studioEnvironment.config.lighting.fixtures;
  const fixtures=studioLighting.fixtures.map((light,i)=>({position:light.position.toArray(),error:light.position.distanceTo(new THREE.Vector3(...expected[i].position).applyMatrix4(studioEnvironment.group.matrixWorld)),down:new THREE.Vector3(0,0,-1).applyQuaternion(light.quaternion).toArray(),width:light.width,height:light.height}));
  for(const object of objects.values())if(object.rig.vertexKinds.includes('detail'))throw Error('Procedural head still has facial detail');
  return {fixtures,mode:world.userData.studioLighting.mode,splatToneMapped:studioEnvironment.spark.material.toneMapped};
 });
 assert.equal(lighting.fixtures.length,3);assert(lighting.fixtures.every(light=>light.error<1e-6&&light.down[1]<-.99&&light.width>.2&&light.width<.3));assert.equal(lighting.splatToneMapped,false);report.lighting=lighting;
 pass('Compact character cards retain credits; upload and legacy contact controls are hidden in debug; faceless heads and three scan-registered ceiling lights are active');
 await page.locator('#figureStyle').selectOption('dummy');await page.locator('[data-scene-view="scene"]').click();await page.locator('#orbitStage').screenshot({path:path.join(OUT,'dummy-room-lighting.png')});
 await page.locator('#figureStyle').selectOption('model:builtin-hero-male');await page.locator('#orbitStage').screenshot({path:path.join(OUT,'athlete-room-lighting.png')});
 await page.locator('#sceneSpeed').selectOption('0.25');await page.locator('#scenePlay').click();await page.waitForFunction(()=>!document.getElementById('sceneVideo').paused);
 const before=await page.locator('#sceneVideo').evaluate(video=>video.currentTime),name=page.locator('[data-character-name="1"]');
 await name.fill('Ada');await name.press('Enter');assert(!await page.locator('#sceneVideo').evaluate(video=>video.paused));assert((await page.locator('#sceneVideo').evaluate(video=>video.currentTime))>=before);
 assert.equal(await page.locator('[data-participant-name="1"]').textContent(),'Ada');assert.equal(await page.locator('#figure-style-1').getAttribute('aria-label'),'Figure style for Ada');assert((await page.locator('#strikeCueEstimatedList').textContent()).includes('Ada'));
 await page.locator('#scenePlay').click();await page.reload();await ready();assert.equal(await page.locator('[data-character-name="1"]').inputValue(),'Ada');
 await page.locator('[data-character-name="1"]').focus();await page.keyboard.press('Backquote');assert(!await page.locator('#debugMenu').isVisible());await page.keyboard.press('Escape');
 await page.keyboard.press('Backquote');assert(await page.locator('#debugMenu').isVisible());assert(await page.locator('#modelUpload').isVisible());
 await page.locator('#contactDetails').evaluate(details=>details.open=true);await page.locator('#contactEffects').check();await page.locator('#debugClose').click();assert(!await page.locator('#contactEffects').isChecked());assert(!await page.locator('#debugMenu').isVisible());
 pass('Character names update all participant references during playback and persist; backtick ignores text editing; closing debug clears legacy intersections');
 await page.locator('#debugToggle').click();const started=Date.now();await page.locator('#modelUpload').setInputFiles(largeGLB());
 await page.locator('.model-card [data-model-readiness="ready"]').waitFor();report.largeUploadMilliseconds=Date.now()-started;
 const upload=await page.evaluate(()=>{const {modelLibrary}=window.__polish(),record=[...modelLibrary.records.values()][0];return {bytes:record.bytes.byteLength,name:record.name,id:record.id};});assert.equal(upload.bytes,65*1024*1024);
 assert.equal(await page.locator('.model-card [data-model-participant] option[value="1"]').textContent(),'Ada');
 await page.locator('#figure-style-1').selectOption('model:'+upload.id);
 const limit=await page.evaluate(async()=>{let read=false;const {modelLibrary}=window.__polish();await modelLibrary.addFiles([{name:'Too large.glb',size:65*1024*1024+1,arrayBuffer:()=>{read=true;throw Error('Must reject before reading');}}]);return {read,status:document.getElementById('modelStatus').textContent,count:modelLibrary.records.size};});
 assert.equal(limit.read,false);assert.match(limit.status,/larger than 65 MB/);assert.equal(limit.count,1);report.upload=upload;
 await page.locator('.model-card [data-model-action="remove"]').click();await page.locator('#debugClose').click();
 pass('A valid 65 MiB rig loads, maps and animates; larger files are rejected before reading; browser storage and existing choices remain usable');
 for(const width of [390,768]){
  await page.setViewportSize({width,height:width===390?844:1024});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.locator('#modelLibrary').screenshot({path:path.join(OUT,`compact-library-${width}.png`)});await page.locator('#debugToggle').click();assert(await page.locator('#modelUpload').isVisible());await page.locator('#debugClose').click();
 }
 assert.deepEqual(report.errors,[]);assert.deepEqual(report.failed,[]);pass('Compact library, naming and debug controls work on phone and tablet without JavaScript or asset failures');
}catch(error){report.failure=error.stack;throw error;}finally{fs.writeFileSync(path.join(OUT,'verification.json'),JSON.stringify(report,null,2));if(browser)await browser.close();if(server)server.kill();}})().catch(error=>{console.error(error);process.exitCode=1;});

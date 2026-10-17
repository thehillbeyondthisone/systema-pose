// Verify estimated events on real character skins, frame scrubbing and slow replay.
const {chromium}=require(process.env.SYSTEMA_PLAYWRIGHT||'C:/Users/thefo/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const ROOT=path.resolve(__dirname,'..'),OUT=path.join(ROOT,'outputs/motion-strikes');
const PYTHON=process.env.SYSTEMA_PYTHON||'C:/Users/thefo/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe';
const BASE=process.env.SYSTEMA_TEST_URL||'http://127.0.0.1:8790/release-strikes-final-20261017/';
const report={base:BASE,checks:[],errors:[],failed:[],placements:[]};fs.mkdirSync(OUT,{recursive:true});
const pass=text=>{report.checks.push(text);console.log('PASS '+text);};
let browser,server;
(async()=>{try{
 if(!process.env.SYSTEMA_TEST_URL){
  let active=false;try{active=(await fetch(BASE+'catalog.json')).ok;}catch{}
  if(!active){
   server=spawn(PYTHON,[path.join(ROOT,'work/preview_pages.py'),'--port','8790','--directory',path.join(ROOT,'work')],{windowsHide:true,stdio:'ignore'});
   for(let i=0;i<100;i++){try{if((await fetch(BASE+'catalog.json')).ok)break;}catch{}await new Promise(resolve=>setTimeout(resolve,100));}
  }
 }
 browser=await chromium.launch({channel:'msedge',headless:true});
 const context=await browser.newContext({viewport:{width:1440,height:1050},acceptDownloads:true}),page=await context.newPage();page.setDefaultTimeout(60000);
 page.on('pageerror',error=>report.errors.push(error.message));
 page.on('response',response=>{if(response.status()>=400&&!response.url().endsWith('favicon.ico'))report.failed.push(response.url());});
 await page.route(new URL('scene.js',BASE).href,async route=>{const response=await route.fetch();await route.fulfill({response,body:(await response.text())+'\nwindow.__strikeTest=()=>({objects,motion,frame,strikeCues,modelLibrary,THREE});'});});
 await page.goto(BASE+'scene.html?clip=multiple-attackers&frame=128');
 await page.waitForFunction(()=>window.__strikeTest?.().strikeCues&&document.getElementById('studioStatus').dataset.state==='ready'&&document.querySelectorAll('.builtin-model-card [data-model-readiness="ready"]').length===3&&document.getElementById('sceneVideo').readyState>=2);
 const events=await page.evaluate(()=>window.__strikeTest().strikeCues.estimates);
 assert(events.length>0&&events.length<40);assert.equal(await page.locator('.strike-estimate-item').count(),events.length);
 assert.match(await page.locator('.strike-estimate-summary').textContent(),/blocks|grabs/);
 assert.match(await page.locator('.strike-estimate-summary').textContent(),/not measured force/);
 assert(await page.locator('#strikeCueEstimatedEnabled').isChecked());
 pass('Likely strike candidates load separately from authored cues with relative intensity and visible uncertainty');
 const scrub=async value=>{
  await page.locator('#sceneScrub').evaluate((input,value)=>{input.value=String(value);input.dispatchEvent(new Event('input'));},value);
  await page.waitForFunction(value=>window.__strikeTest().frame===value,value);
 };
 const inspect=async event=>page.evaluate(event=>{
  const {strikeCues,objects,THREE}=window.__strikeTest(),visual=strikeCues.estimatedVisuals.get(event.id);
  if(!visual?.group.visible||!visual.group.userData.landingResolved)throw Error('Landing does not resolve to a visible character');
  const target=objects.get(event.targetId),rig=[...target.customRigs.values()].find(rig=>rig.group.visible)||target.rig;
  const point=visual.ring.position.clone(),center=rig.group.getWorldPosition(new THREE.Vector3());
  if(!point.toArray().every(Number.isFinite)||point.distanceTo(center)>3)throw Error('Landing is outside the posed character');
  const normal=new THREE.Vector3(0,0,1).applyQuaternion(visual.ring.quaternion).normalize();
  const ray=new THREE.Raycaster(point.clone().addScaledVector(normal,.1),normal.clone().negate(),0,.3);
  const meshes=(rig.meshes||[rig.mesh]).filter(mesh=>mesh?.isMesh&&mesh.visible),hits=ray.intersectObjects(meshes,false);
  if(!hits.length||hits[0].point.distanceTo(point)>.018)throw Error('Landing ring is not on the actual current skinned surface');
  for(const id of [event.strikerId,event.targetId]){
   const object=objects.get(id),active=[...object.customRigs.values()].find(rig=>rig.group.visible)||object.rig;
   const highlight=strikeCues.getHighlight(id);
   if(!highlight)throw Error('The striking/receiving body region is not highlighted');
   if(active.asset&&active.group.userData.customFigure.highlightJoint!==highlight.jointName)throw Error('Uploaded character highlight does not match mapped anatomy');
  }
  return {id:event.id,frame:event.frame,point:point.toArray(),surfaceError:hits[0].point.distanceTo(point),intensity:event.intensity,ringScale:visual.ring.scale.toArray(),pulseOpacity:visual.pulse.material.opacity};
 },event);
 const examples=[events.find(event=>event.region==='Lower torso'),events.find(event=>event.region==='Head'),events.find(event=>event.limb.endsWith('foot'))].filter(Boolean);
 const models=['mannequin',...await page.evaluate(()=>window.__strikeTest().modelLibrary.getBuiltinEntries().map(entry=>'model:'+entry.id))];
 for(const model of models){
  await page.locator('#figureStyle').selectOption(model);
  for(const event of examples){
   await scrub(event.frame);const first=await inspect(event);await scrub(event.frame+15);await scrub(event.frame);
   assert.deepEqual(await inspect(event),first,'Scrub order must not change the marker or intensity');report.placements.push({model,...first});
   assert(await page.locator('#strikeEstimateHud').isVisible());assert.match(await page.locator('#strikeEstimateIntensity').textContent(),/Relative intensity [1-5]\/5/);
  }
  await page.locator('[data-camera="front"]').click();
  await page.locator('#orbitStage').screenshot({path:path.join(OUT,model.replace(':','-')+'-strike.png')});
 }
 pass('Landing markers attach to actual posed mannequin, robot and athlete skins; anatomy highlights and intensity are deterministic when scrubbing backward');
 const event=examples[1]||events[0];await scrub(event.frame);
 await page.locator('#strikeCueEstimatedEnabled').uncheck();assert.equal(await page.locator('#orbitStage canvas').getAttribute('data-estimated-strike-count'),'0');assert(!(await page.locator('#strikeEstimateHud').isVisible()));
 await page.locator('#strikeCueEstimatedEnabled').check();
 await page.locator(`#scenePeople input[value="${event.targetId}"]`).count().then(async count=>{
  const input=count?page.locator(`#scenePeople input[value="${event.targetId}"]`):page.locator('#scenePeople input').nth(Number(event.targetId)-1);
  await input.uncheck();assert(!await page.evaluate(id=>window.__strikeTest().strikeCues.getActiveEstimates().some(event=>event.id===id),event.id));await input.check();
 });
 pass('Estimate toggle and participant visibility remove their overlays immediately');
 const downloadEvent=page.waitForEvent('download');await page.locator('#strikeCueExport').click();
 const download=await downloadEvent,file=path.join(OUT,'authored-cues.json');await download.saveAs(file);assert.deepEqual(JSON.parse(fs.readFileSync(file)).cues,[]);
 pass('Generated estimates never enter authored cue exports');
 const before=await page.locator('#sceneVideo').evaluate(video=>({muted:video.muted,volume:video.volume}));
 await page.locator(`[data-estimate-id="${event.id}"] .strike-estimate-actions button`).last().click();
 assert.equal(await page.locator('#sceneSpeed').inputValue(),'0.25');assert.equal(await page.locator('#sceneVideo').evaluate(video=>video.playbackRate),.25);
 assert.equal(await page.locator('#scenePlaybackScope').textContent(),'Estimated strike replay');
 await page.waitForFunction(()=>document.getElementById('sceneVideo').paused,null,{timeout:15000});
 const stopped=Number(await page.locator('#sceneScrub').inputValue());assert.equal(stopped,event.endFrame);
 assert.deepEqual(await page.locator('#sceneVideo').evaluate(video=>({muted:video.muted,volume:video.volume})),before);
 pass('One-click quarter-speed replay uses the bounded candidate window and preserves audio settings');
 for(const width of [390,768]){
  await page.setViewportSize({width,height:width===390?844:1024});await page.locator('[data-scene-view="scene"]').click();await scrub(event.frame);
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.locator('#orbitStage').screenshot({path:path.join(OUT,`strike-hud-${width}.png`)});
  await page.locator('.strike-estimates').screenshot({path:path.join(OUT,`estimates-${width}.png`)});
 }
 assert.deepEqual(report.errors,[]);assert.deepEqual(report.failed,[]);
 pass('On-screen intensity and estimate controls fit phone and tablet without JavaScript or failed asset requests');
}catch(error){report.failure=error.stack||String(error);throw error;}
finally{fs.writeFileSync(path.join(OUT,'verification.json'),JSON.stringify(report,null,2));if(browser)await browser.close();if(server)server.kill();}
})().catch(error=>{console.error(error);process.exitCode=1;});

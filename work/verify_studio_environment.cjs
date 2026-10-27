const {chromium}=require(process.env.SYSTEMA_PLAYWRIGHT || 'C:/Users/thefo/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const BASE=process.env.SYSTEMA_TEST_URL||'http://127.0.0.1:8773';
const ROOT=path.resolve(__dirname,'..');
const OUT=path.join(ROOT,'outputs/studio-validation');
fs.mkdirSync(OUT,{recursive:true});
const report={checks:[],errors:[]};
const studioConfig=JSON.parse(fs.readFileSync(path.join(ROOT,'teaching_suite/public/studio/environment.json')));
const sourceHash=JSON.parse(fs.readFileSync(path.join(ROOT,'outputs/3d-pilot/scene.json'))).sourceSha256;
const initial=studioConfig.alignment;
const shiftedZ=Math.round((initial.z+.25)*10000)/10000;
const resetZ=String(Math.round(initial.z*10000)/10000);
function pass(value){report.checks.push(value);console.log('PASS '+value);}
(async()=>{
 const browser=await chromium.launch({channel:'msedge',headless:true});
 try{
  const context=await browser.newContext({viewport:{width:1440,height:1100},acceptDownloads:true});
  await context.addInitScript(({config,sourceHash})=>{
   localStorage.setItem(`systema-studio-v1:${sourceHash}:${config.id}`,JSON.stringify({x:999,y:999,z:999,pitch:180,yaw:0,roll:0,scale:1}));
  },{config:studioConfig,sourceHash});
  const page=await context.newPage();page.on('pageerror',e=>report.errors.push(e.message));
  const remote=[];page.on('request',r=>{if(/^https?:/.test(r.url())&&!r.url().startsWith(BASE))remote.push(r.url());});
  async function ready(){await page.waitForFunction(()=>document.getElementById('studioStatus').dataset.state==='ready',{timeout:60000});}
  await page.goto(BASE+'/scene.html');await ready();
  assert.equal(await page.locator('#scenePeople input[type=checkbox]').count(),4);
  assert.equal(await page.locator('#studioBadge').innerText(),studioConfig.calibration?'Matched to footage':'Alignment estimate');
  assert.equal(remote.length,0);pass('Local Gaussian scan loads alongside four participants without CDN requests');
  assert.equal(await page.locator('#studio-x').inputValue(),String(Math.round(initial.x*10000)/10000));
  assert.equal(await page.locator('[data-camera="source"]').getAttribute('aria-pressed'),'true');
  assert.equal(await page.locator('#orbitStage').getAttribute('data-camera-mode'),'source');
  const aspect=await page.locator('#orbitStage canvas').evaluate(el=>el.getBoundingClientRect().width/el.getBoundingClientRect().height);
  assert(Math.abs(aspect-16/9)<.001);pass('Calibrated source camera uses footage framing and ignores the older approximate browser alignment');
  for(const selectedFrame of [0,150,359]){
   await page.locator('#sceneScrub').evaluate((el,value)=>{el.value=String(value);el.dispatchEvent(new Event('input',{bubbles:true}));},selectedFrame);
   await page.waitForFunction(value=>document.querySelector('#orbitStage canvas').dataset.sourceCameraFrame===String(value)&&!document.getElementById('sceneVideo').seeking,selectedFrame);
   await page.waitForTimeout(150);
   await page.screenshot({path:path.join(OUT,`calibrated-frame-${String(selectedFrame).padStart(3,'0')}.png`),fullPage:true});
  }
  await page.locator('[data-camera="side"]').click();assert.equal(await page.locator('#orbitStage').getAttribute('data-camera-mode'),'side');
  await page.locator('#resetCamera').click();assert.equal(await page.locator('[data-camera="source"]').getAttribute('aria-pressed'),'true');
  await page.locator('#orbitStage canvas').scrollIntoViewIfNeeded();const drag=await page.locator('#orbitStage canvas').boundingBox();
  await page.mouse.move(drag.x+drag.width/2,drag.y+drag.height/2);await page.mouse.down();await page.mouse.move(drag.x+drag.width/2+35,drag.y+drag.height/2+12,{steps:4});await page.mouse.up();
  assert.equal(await page.locator('#orbitStage').getAttribute('data-camera-mode'),'orbit');
  await page.locator('#resetCamera').click();assert.equal(await page.locator('#orbitStage').getAttribute('data-camera-mode'),'source');
  pass('Source camera follows seeking across the clip, free orbit exits follow, and Reset restores the calibrated camera');

  await page.locator('#sceneScrub').evaluate(el=>{el.value='150';el.dispatchEvent(new Event('input',{bubbles:true}));});
  await page.waitForFunction(()=>Math.abs(document.getElementById('sceneVideo').currentTime-5)<.01&&!document.getElementById('sceneVideo').seeking);
  await page.locator('#sceneSpeed').selectOption('0.25');await page.locator('#scenePlay').click();await page.waitForTimeout(1500);await page.locator('#scenePlay').click();
  const slowFrame=Number(await page.locator('#sceneScrub').inputValue());assert(slowFrame>150&&slowFrame<180,`Slow playback reached ${slowFrame}`);
  await page.locator('#sceneSpeed').selectOption('1');await page.locator('#sceneScrub').evaluate(el=>{el.value='150';el.dispatchEvent(new Event('input',{bubbles:true}));});
  await page.waitForFunction(()=>Math.abs(document.getElementById('sceneVideo').currentTime-5)<.01&&!document.getElementById('sceneVideo').seeking);pass('Quarter-speed replay advances synchronized footage and source-camera motion with the new Gaussian room');
  await page.locator('.studio-alignment summary').click();
  await page.locator('#studio-z').fill(String(shiftedZ));await page.locator('#studio-z').dispatchEvent('change');
  assert.equal(await page.locator('#sceneScrub').inputValue(),'150');pass('Room registration changes preserve the synchronized source frame');
  await page.reload();await ready();assert.equal(await page.locator('#studio-z').inputValue(),String(shiftedZ));
  pass('Room registration survives reload for the same source and studio');
  await page.locator('.studio-alignment summary').click();
  const download=page.waitForEvent('download');await page.locator('#studioExport').click();
  const downloaded=await download;const exportPath=path.join(OUT,'alignment.json');await downloaded.saveAs(exportPath);
  const record=JSON.parse(fs.readFileSync(exportPath));assert.equal(record.alignment.z,shiftedZ);
  await page.locator('#studioReset').click();assert.equal(await page.locator('#studio-z').inputValue(),resetZ);
  await page.locator('#studioImport').setInputFiles(exportPath);await page.waitForFunction(value=>document.getElementById('studio-z').value===value,String(shiftedZ));
  const badPath=path.join(OUT,'wrong-source.json');fs.writeFileSync(badPath,JSON.stringify({...record,sourceSha256:'wrong'}));
  await page.locator('#studioImport').setInputFiles(badPath);await page.waitForFunction(()=>document.getElementById('studioStatus').textContent.includes('does not match'));
  assert.equal(await page.locator('#studio-z').inputValue(),String(shiftedZ));pass('Alignment export/import round-trips and rejects another source video');
  await page.locator('#studioReset').click();
  await page.locator('#studioVisible').uncheck();await page.locator('#studioVisible').check();
  await page.locator('#studioXray').uncheck();await page.locator('#studioXray').check();
  await page.locator('#debugToggle').click();await page.locator('#contactDetails summary').click();await page.locator('#contactEffects').check();
  await page.locator('#sceneScrub').evaluate(el=>{el.value='36';el.dispatchEvent(new Event('input',{bubbles:true}));});
  assert(Number(await page.locator('#contactStatus').getAttribute('data-count'))>0);
  await page.locator('#contactEffects').uncheck();pass('Studio visibility, figure occlusion and estimated contacts remain interactive');
  await page.locator('#debugClose').click();
  // A screen-space floor triangle exercises the renderer's real Gaussian raycast.
  await page.locator('#studioFloor').click();await page.locator('#orbitStage canvas').scrollIntoViewIfNeeded();
  const box=await page.locator('#orbitStage canvas').boundingBox();
  for(const [x,y] of [[.5,.88],[.7,.82],[.9,.9]])await page.mouse.click(box.x+box.width*x,box.y+box.height*y);
  const floor=await page.locator('#studioStatus').innerText();
  console.log('Floor selection:',floor);
  assert(floor.includes('Selected floor aligned'),floor);pass('Three real scan points level the room floor to the animation ground');
  await page.locator('#studioReset').click();
  await page.locator('#sceneScrub').evaluate(el=>{el.value='150';el.dispatchEvent(new Event('input',{bubbles:true}));});
  await page.locator('.studio-alignment summary').click();
  await page.locator('#orbitStage').scrollIntoViewIfNeeded();await page.waitForTimeout(500);
  await page.screenshot({path:path.join(OUT,'studio-desktop.png'),fullPage:true});
  for(const viewport of [{width:390,height:844},{width:1024,height:768}]){
   await page.setViewportSize(viewport);await page.locator('[data-scene-view="scene"]').click();
   assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),JSON.stringify(viewport));
  }
  await page.screenshot({path:path.join(OUT,'studio-tablet.png'),fullPage:true});pass('Phone and tablet layouts have no horizontal overflow');
  const failure=await context.newPage();failure.on('pageerror',e=>report.errors.push(e.message));
  await failure.route('**/studio.splat*',route=>route.fulfill({status:404,body:'missing'}));
  await failure.goto(BASE+'/scene.html');await failure.waitForFunction(()=>document.getElementById('studioStatus').dataset.state==='error');
  assert.equal(await failure.locator('#scenePeople input[type=checkbox]').count(),4);assert.equal(await failure.locator('#scenePlay').isEnabled(),true);
  await failure.unroute('**/studio.splat*');await failure.locator('#studioRetry').click();
  await failure.waitForFunction(()=>document.getElementById('studioStatus').dataset.state==='ready',{timeout:60000});
  pass('Missing scan leaves motion usable and Retry recovers without reloading');
  assert.deepEqual(report.errors,[]);pass('No browser JavaScript errors');
 }finally{fs.writeFileSync(path.join(OUT,'report.json'),JSON.stringify(report,null,2));await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});

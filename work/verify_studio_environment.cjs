const {chromium}=require(process.env.SYSTEMA_PLAYWRIGHT || 'C:/Users/thefo/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const BASE=process.env.SYSTEMA_TEST_URL||'http://127.0.0.1:8773';
const ROOT=path.resolve(__dirname,'..');
const OUT=path.join(ROOT,'outputs/studio-validation');
fs.mkdirSync(OUT,{recursive:true});
const report={checks:[],errors:[]};
function pass(value){report.checks.push(value);console.log('PASS '+value);}
(async()=>{
 const browser=await chromium.launch({channel:'msedge',headless:true});
 try{
  const context=await browser.newContext({viewport:{width:1440,height:1100},acceptDownloads:true});
  const page=await context.newPage();page.on('pageerror',e=>report.errors.push(e.message));
  const remote=[];page.on('request',r=>{if(/^https?:/.test(r.url())&&!r.url().startsWith(BASE))remote.push(r.url());});
  async function ready(){await page.waitForFunction(()=>document.getElementById('studioStatus').dataset.state==='ready',{timeout:60000});}
  await page.goto(BASE+'/scene.html');await ready();
  assert.equal(await page.locator('#scenePeople input').count(),4);
  assert.equal(remote.length,0);pass('Local Gaussian scan loads alongside four participants without CDN requests');
  await page.locator('#sceneScrub').evaluate(el=>{el.value='150';el.dispatchEvent(new Event('input',{bubbles:true}));});
  await page.waitForFunction(()=>Math.abs(document.getElementById('sceneVideo').currentTime-5)<.01&&!document.getElementById('sceneVideo').seeking);
  await page.locator('.studio-alignment summary').click();
  await page.locator('#studio-z').fill('2.25');await page.locator('#studio-z').dispatchEvent('change');
  assert.equal(await page.locator('#sceneScrub').inputValue(),'150');pass('Room registration changes preserve the synchronized source frame');
  await page.reload();await ready();assert.equal(await page.locator('#studio-z').inputValue(),'2.25');
  pass('Room registration survives reload for the same source and studio');
  await page.locator('.studio-alignment summary').click();
  const download=page.waitForEvent('download');await page.locator('#studioExport').click();
  const downloaded=await download;const exportPath=path.join(OUT,'alignment.json');await downloaded.saveAs(exportPath);
  const record=JSON.parse(fs.readFileSync(exportPath));assert.equal(record.alignment.z,2.25);
  await page.locator('#studioReset').click();assert.equal(await page.locator('#studio-z').inputValue(),'2');
  await page.locator('#studioImport').setInputFiles(exportPath);await page.waitForFunction(()=>document.getElementById('studio-z').value==='2.25');
  const badPath=path.join(OUT,'wrong-source.json');fs.writeFileSync(badPath,JSON.stringify({...record,sourceSha256:'wrong'}));
  await page.locator('#studioImport').setInputFiles(badPath);await page.waitForFunction(()=>document.getElementById('studioStatus').textContent.includes('does not match'));
  assert.equal(await page.locator('#studio-z').inputValue(),'2.25');pass('Alignment export/import round-trips and rejects another source video');
  await page.locator('#studioReset').click();
  await page.locator('#studioVisible').uncheck();await page.locator('#studioVisible').check();
  await page.locator('#studioXray').uncheck();await page.locator('#studioXray').check();
  await page.locator('#contactDetails summary').click();await page.locator('#contactEffects').check();
  await page.locator('#sceneScrub').evaluate(el=>{el.value='36';el.dispatchEvent(new Event('input',{bubbles:true}));});
  assert(Number(await page.locator('#contactStatus').getAttribute('data-count'))>0);
  await page.locator('#contactEffects').uncheck();pass('Studio visibility, figure occlusion and estimated contacts remain interactive');
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
  await failure.route('**/studio/studio.splat',route=>route.fulfill({status:404,body:'missing'}));
  await failure.goto(BASE+'/scene.html');await failure.waitForFunction(()=>document.getElementById('studioStatus').dataset.state==='error');
  assert.equal(await failure.locator('#scenePeople input').count(),4);assert.equal(await failure.locator('#scenePlay').isEnabled(),true);
  await failure.unroute('**/studio/studio.splat');await failure.locator('#studioRetry').click();
  await failure.waitForFunction(()=>document.getElementById('studioStatus').dataset.state==='ready',{timeout:60000});
  pass('Missing scan leaves motion usable and Retry recovers without reloading');
  assert.deepEqual(report.errors,[]);pass('No browser JavaScript errors');
 }finally{fs.writeFileSync(path.join(OUT,'report.json'),JSON.stringify(report,null,2));await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});

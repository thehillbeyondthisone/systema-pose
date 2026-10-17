// Exercise figure swaps and authored strike cues on the static viewer under a URL subpath.
const {chromium}=require(process.env.SYSTEMA_PLAYWRIGHT||'C:/Users/thefo/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const ROOT=path.resolve(__dirname,'..'),OUT=path.join(ROOT,'outputs/teaching-figures');
const PYTHON=process.env.SYSTEMA_PYTHON||'C:/Users/thefo/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe';
const BASE=process.env.SYSTEMA_TEST_URL||'http://127.0.0.1:8786/release-figures-20261017/';
const report={checks:[],errors:[],failed:[]};
fs.mkdirSync(OUT,{recursive:true});
const pass=message=>{report.checks.push(message);console.log('PASS '+message);};
let server,browser;
(async()=>{
 try{
  if(!process.env.SYSTEMA_TEST_URL){
   server=spawn(PYTHON,[path.join(ROOT,'work/preview_pages.py'),'--port','8786','--directory',path.join(ROOT,'work')],{windowsHide:true,stdio:'ignore'});
   for(let attempt=0;attempt<50;attempt++){
    try{if((await fetch(BASE+'catalog.json')).ok)break;}catch{}
    await new Promise(resolve=>setTimeout(resolve,100));
   }
  }
  browser=await chromium.launch({channel:'msedge',headless:true});
  const context=await browser.newContext({viewport:{width:1440,height:1100},acceptDownloads:true});
  const page=await context.newPage();
  page.on('pageerror',error=>report.errors.push(error.message));
  page.on('response',response=>{if(response.status()>=400&&!response.url().endsWith('favicon.ico'))report.failed.push(response.url());});
  await page.goto(BASE+'scene.html?clip=multiple-attackers&frame=150');
  const ready=async()=>page.waitForFunction(()=>document.getElementById('studioStatus')?.dataset.state==='ready'&&document.getElementById('sceneVideo').readyState>=2,null,{timeout:60000});
  await ready();
  assert.equal(await page.locator('#orbitStage canvas').getAttribute('data-rig-count'),'4');
  assert.equal(await page.locator('#figurePeople select').count(),4);
  pass('Four rigged mannequins load with the calibrated studio and exact source frame');
  await page.locator('#scenePlay').click();
  await page.waitForFunction(()=>document.getElementById('sceneVideo').currentTime>5.2);
  for(const style of ['skeleton','bones','dummy','mannequin']){
   const before=await page.locator('#sceneVideo').evaluate(video=>video.currentTime);
   await page.locator('#figureStyle').selectOption(style);
   assert.equal(await page.locator('#sceneVideo').evaluate(video=>video.paused),false);
   assert((await page.locator('#sceneVideo').evaluate(video=>video.currentTime))>=before-.04);
   assert(Object.values(JSON.parse(await page.locator('#orbitStage canvas').getAttribute('data-figure-styles'))).every(value=>value===style));
  }
  await page.locator('#figure-style-2').selectOption('dummy');
  assert.equal(await page.locator('#figureStyle').inputValue(),'mixed');
  assert.equal(await page.locator('#figure-style-1').inputValue(),'mannequin');
  await page.locator('#scenePlay').click();
  pass('All four styles and per-participant styles swap during playback without pausing or seeking');
  await page.locator('#scenePeople input').first().uncheck();
  assert.equal(await page.locator('#orbitStage canvas').getAttribute('data-rig-count'),'3');
  await page.locator('#scenePeople input').first().check();
  await page.reload();await ready();
  assert.equal(await page.locator('#figure-style-2').inputValue(),'dummy');
  pass('Participant visibility works with rigged models and style choices survive reload');
  await page.locator('#sceneScrub').evaluate(input=>{input.value='150';input.dispatchEvent(new Event('input'));});
  await page.locator('#strikeDetails').evaluate(details=>details.open=true);
  await page.locator('#strikeCueNew').click();
  await page.locator('#strikeCueName').fill('Hand placement illustration');
  await page.locator('#strikeCueStriker').selectOption('1');
  await page.locator('#strikeCueTarget').selectOption('2');
  await page.locator('#strikeCueLimb').selectOption('right_wrist');
  await page.locator('#strikeCueJoint').selectOption('spine3');
  await page.locator('#strikeCueIntensity').fill('5');
  await page.locator('#strikeCuePreview').click();
  await page.waitForFunction(()=>document.getElementById('sceneVideo').paused&&document.getElementById('scenePlaybackScope').textContent==='Strike preview');
  const stopped=Number(await page.locator('#sceneScrub').inputValue());
  assert(stopped>150&&stopped<175);
  await page.locator('#strikeCueSave').click();
  assert.equal(await page.locator('.strike-list>li').count(),1);
  await page.getByRole('button',{name:'Jump to Hand placement illustration',exact:true}).click();
  assert.equal(await page.locator('#orbitStage canvas').getAttribute('data-strike-cue-count'),'1');
  await page.screenshot({path:path.join(OUT,'rigged-strike-desktop.png'),fullPage:true});
  pass('A chosen limb, target region and visual emphasis produce a single illustrated cue with bounded preview playback');
  const downloadEvent=page.waitForEvent('download');await page.locator('#strikeCueExport').click();
  const download=await downloadEvent,backup=path.join(OUT,'strike-cues.json');await download.saveAs(backup);
  const data=JSON.parse(fs.readFileSync(backup));assert.equal(data.cues.length,1);assert.equal(data.cues[0].intensity,5);
  await page.reload();await ready();await page.locator('#strikeDetails').evaluate(details=>details.open=true);
  assert.equal(await page.locator('.strike-list>li').count(),1);
  await page.getByRole('button',{name:'Delete Hand placement illustration',exact:true}).click();
  assert.equal(await page.locator('.strike-list>li').count(),0);
  await page.locator('#strikeCueImport').setInputFiles(backup);
  await page.waitForFunction(()=>document.querySelectorAll('.strike-list>li').length===1);
  const wrong={...data,sourceSha256:'0'.repeat(64)};
  await page.locator('#strikeCueImport').setInputFiles({name:'wrong-clip.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(wrong))});
  await page.waitForFunction(()=>document.getElementById('strikeCueStatus').textContent.includes('different source clip'));
  assert.equal(await page.locator('.strike-list>li').count(),1);
  pass('Cues persist, export/import correctly and reject another source clip');
  await page.getByRole('button',{name:'Jump to Hand placement illustration',exact:true}).click();
  await page.locator('#scenePeople input').first().uncheck();
  assert.equal(await page.locator('#orbitStage canvas').getAttribute('data-strike-cue-count'),'0');
  await page.locator('#scenePeople input').first().check();
  assert.equal(await page.locator('#orbitStage canvas').getAttribute('data-strike-cue-count'),'1');
  await page.locator('#strikeCueNew').click();await page.locator('#strikeCuePreview').click();
  await page.locator('#strikeCueCancel').click();
  await page.getByRole('button',{name:'Jump to Hand placement illustration',exact:true}).click();
  assert.equal(await page.locator('#orbitStage canvas').getAttribute('data-strike-cue-count'),'1');
  pass('Hiding a participant hides their cue; cancelling a draft removes its unsaved overlay');
  if(await page.locator('#debugMenu').isHidden())await page.locator('#debugToggle').click();
  await page.locator('#contactDetails').evaluate(details=>details.open=true);await page.locator('#contactEffects').check();
  await page.locator('#sceneScrub').evaluate(input=>{input.value='36';input.dispatchEvent(new Event('input'));});
  assert(Number(await page.locator('#contactStatus').getAttribute('data-count'))>0);
  await page.locator('#contactEffects').uncheck();
  for(const viewport of [{width:390,height:844},{width:768,height:1024}]){
   await page.setViewportSize(viewport);await page.locator('[data-scene-view="scene"]').click();
   assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'No horizontal overflow');
  }
  await page.screenshot({path:path.join(OUT,'teaching-controls-tablet.png'),fullPage:true});
  assert.deepEqual(report.errors,[]);assert.deepEqual(report.failed,[]);
  pass('Contacts, camera, phone/tablet layouts and local assets remain usable without JavaScript or network errors');
 }finally{
  fs.writeFileSync(path.join(OUT,'verification.json'),JSON.stringify(report,null,2));
  if(browser)await browser.close();if(server)server.kill();
 }
})().catch(error=>{console.error(error);process.exitCode=1;});

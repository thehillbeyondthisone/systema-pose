const {chromium}=require(process.env.SYSTEMA_PLAYWRIGHT||'C:/Users/thefo/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const ROOT=path.resolve(__dirname,'..'),BASE=process.env.SYSTEMA_ADMIN_TEST_URL,OUT=process.env.SYSTEMA_ADMIN_TEST_OUTPUT,PROJECT=process.env.SYSTEMA_ADMIN_TEST_PROJECT;
if(process.env.SYSTEMA_ADMIN_ALLOW_GPU!=='1')throw Error('GPU tests require explicit authorization. Use the harness with --allow-gpu.');
const report=process.env.SYSTEMA_ADMIN_RESUME?JSON.parse(fs.readFileSync(path.join(OUT,'verification.json'))):{checks:[],errors:[],failed:[]};delete report.failure;
const pass=text=>{report.checks.push(text);console.log('PASS '+text);};let browser;
const state=async()=>await (await fetch(BASE+'/api/admin/state')).json();
const wait=async(predicate,timeout=240000)=>{const start=Date.now();while(Date.now()-start<timeout){const value=await state();if(await predicate(value))return value;await new Promise(r=>setTimeout(r,1500));}throw Error('Timed out waiting for dashboard state');};
async function post(route,body){const value=await state(),response=await fetch(BASE+'/api/admin/'+route,{method:'POST',headers:{'Content-Type':'application/json',Origin:BASE,'X-Systema-Admin-Token':value.token},body:JSON.stringify(body)});return {httpStatus:response.status,...await response.json()};}
async function job(route,body){const created=await post(route,body);assert.equal(created.httpStatus,202,JSON.stringify(created));const result=await wait(s=>s.jobs.some(j=>j.id===created.id&&j.status!=='running'));return result.jobs.find(j=>j.id===created.id);}
(async()=>{try{
 browser=await chromium.launch({channel:'msedge',headless:true});const page=await browser.newPage({viewport:{width:1500,height:1100}});page.setDefaultTimeout(180000);
 page.on('pageerror',e=>report.errors.push(e.message));page.on('response',r=>{if(r.status()>=500)report.failed.push(r.url());});
 await page.goto(BASE+'/admin');await wait(s=>!s.jobs.some(j=>j.status==='running'));
 assert.equal((await job('requirements',{gpu:true})).status,'complete');
 let value=await state();assert(value.threeD.ready,JSON.stringify(value.threeD));assert.equal(value.threeD.checks.length,6);pass('Actual workstation check validates WSL, RTX GPU/CUDA operations, 16 imports, model files and disk reserves');
 assert.equal((await fetch(BASE+'/api/admin/requirements',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,403);
 let clip,motion,reconstruction;
 if(!process.env.SYSTEMA_ADMIN_RESUME){
 await page.locator('#adminVideo').setInputFiles(path.join(ROOT,'outputs/pilot/source-reference.mp4'));await page.locator('#importVideo').click();await page.locator('#editorContent').waitFor();
 await page.locator('#adminTitle').fill('Full GPU dashboard verification');await page.locator('#adminSlug').fill('gpu-dashboard-test');
 await page.locator('[data-field=start]').fill('1');await page.locator('[data-field=end]').fill('3');await page.locator('#prepareVideo').click();
 await wait(s=>s.lessons[0]?.status==='ready'||s.lessons[0]?.status==='failed');value=await state();assert.equal(value.lessons[0].status,'ready',value.lessons[0].message);
 await page.waitForFunction(()=>document.getElementById('lessonState').textContent==='ready');await page.locator('#reviewedMotion').check();await page.locator('#stageVideo').click();await wait(s=>s.staged.includes('gpu-dashboard-test')&&!s.jobs.some(j=>j.status==='running'));
 value=await state();clip=value.clips[0];motion=JSON.parse(fs.readFileSync(path.join(PROJECT,clip.motion)));assert.equal(motion.frames.length,60);assert(motion.frames.every((f,i)=>f.frame===i));pass('Real video import, 60-frame 2D preparation and reviewed passage export preserve exact source timing and participant boxes');
 }else{clip=value.clips.find(c=>c.id==='gpu-dashboard-test');motion=JSON.parse(fs.readFileSync(path.join(PROJECT,clip.motion)));}
 if(!process.env.SYSTEMA_ADMIN_RESUME){
 await page.locator('[data-reconstruct=gpu-dashboard-test]').click();
 await wait(s=>{const r=s.reconstructions['gpu-dashboard-test'];return r&&fs.existsSync(path.join(OUT,'private-data/admin/reconstruction/gpu-dashboard-test',r.runId,'process.json'));});
 await page.getByRole('button',{name:'Cancel',exact:true}).click();value=await wait(s=>s.reconstructions['gpu-dashboard-test']?.status==='cancelled'&&!s.jobs.some(j=>j.status==='running'));
 const cancelled=value.reconstructions['gpu-dashboard-test'];assert(!value.clips[0].scene);assert(fs.existsSync(path.join(PROJECT,clip.video)));pass('Cancel stops only the isolated WSL worker and preserves the source/export for retry');
 }
 if(!process.env.SYSTEMA_ADMIN_RESUME||process.env.SYSTEMA_ADMIN_RETRY){
 const priorRun=(await state()).reconstructions['gpu-dashboard-test']?.runId;
 await page.locator('[data-reconstruct=gpu-dashboard-test]').click();console.log('RUNNING Real GPU reconstruction of the new two-second passage…');
 let last='';value=await wait(s=>{const r=s.reconstructions['gpu-dashboard-test'];if(r?.message!==last){last=r?.message;console.log('GPU '+last);}return r&&r.runId!==priorRun&&r.status!=='running'&&!s.jobs.some(j=>j.status==='running');},2400000);
 reconstruction=value.reconstructions['gpu-dashboard-test'];
 if(reconstruction.status!=='ready'){const log=await (await fetch(BASE+'/api/admin/clips/gpu-dashboard-test/reconstruction/log')).json();console.error(log.text);}
 assert.equal(reconstruction.status,'ready',reconstruction.message);assert.notEqual(reconstruction.runId,priorRun);
 }else{clip=value.clips.find(c=>c.id==='gpu-dashboard-test');reconstruction=value.reconstructions[clip.id];assert.equal(reconstruction.status,'ready');}
 const scenePath=path.join(PROJECT,'site/clips/gpu-dashboard-test/scene.json'),sceneBytes=fs.readFileSync(scenePath),scene=JSON.parse(sceneBytes);
 assert.equal(scene.coordinateSpace,'world-3d');assert.equal(scene.frames.length,60);assert.equal(scene.sourceStart,1);assert.equal(scene.sourceEnd,3);assert.equal(scene.sourceSha256,clip.sourceSha256);assert(!scene.roomCalibration);
 assert.deepEqual(scene.people.map(p=>p.id),clip.people.map(p=>p.id));assert.equal(scene.camera.Rcw.length,60);assert(scene.frames.every(f=>f.people.every(p=>p.xyz.every(x=>x.length===3&&x.every(Number.isFinite)))));
 assert.equal(crypto.createHash('sha256').update(sceneBytes).digest('hex'),reconstruction.sceneSha256);pass('Fresh real GPU inference exports finite shared XYZ, fresh source cameras, matched identities, exact video hash/timing, and a separate review preview');
 let result=await job('publish',{reviewed:true});assert.equal(result.status,'failed');assert.match(result.message,/review the 3D/i);
 assert.equal((await post('clips/gpu-dashboard-test/review',{reviewed:true,runId:'stale-run'})).httpStatus,400);
 await page.locator('[data-review3d=gpu-dashboard-test]').click();const viewer=page.frameLocator('#sceneReviewFrame');await viewer.locator('#sceneStatus.ready').waitFor();
 assert.equal(await viewer.locator('[data-camera=source]').isDisabled(),false);await viewer.locator('[data-camera=source]').click();await viewer.locator('[data-camera=side]').click();await viewer.locator('[data-camera=overhead]').click();
 await viewer.locator('#sceneScrub').evaluate(input=>{input.value='30';input.dispatchEvent(new Event('input',{bubbles:true}));});
 await page.screenshot({path:path.join(OUT,'3d-review-desktop.png'),fullPage:true});pass('Embedded synchronized 3D review renders without inherited room calibration; source, side, overhead and scrubbing controls work');
 await page.locator('[data-reviewed3d=gpu-dashboard-test]').check();await page.getByRole('button',{name:'Save 3D review',exact:true}).click();await wait(s=>s.reconstructions['gpu-dashboard-test'].reviewed);
 fs.appendFileSync(scenePath,'\n');result=await job('publish',{reviewed:true});assert.equal(result.status,'failed');assert.match(result.message,/reviewed 3D scene changed/);fs.writeFileSync(scenePath,sceneBytes);
 assert.equal((await job('preview',{})).status,'complete');await page.waitForFunction(()=>!document.getElementById('openPreview').hidden);await page.locator('#reviewedPreview').check();
 if(process.env.SYSTEMA_ADMIN_TEST_ROOM){
  await page.locator('#roomForm').evaluate(form=>form.closest('details').open=true);
  await page.locator('#roomPath').fill(process.env.SYSTEMA_ADMIN_TEST_ROOM);await page.locator('#roomTitle').fill('Training room · 17 October');await page.locator('#importRoom').click();
  value=await wait(s=>s.rooms.length&&!s.jobs.some(j=>j.status==='running'));assert.equal(value.rooms[0].splats,1117363);
  await page.locator('[data-attach-room=gpu-dashboard-test]').click();await wait(s=>s.clips[0].environment&&!s.jobs.some(j=>j.status==='running'));
  assert.equal((await job('preview',{})).status,'complete');await page.locator('[data-review3d=gpu-dashboard-test]').click();
  await viewer.locator('#studioStatus[data-state=ready]').waitFor();assert.equal(await viewer.locator('#studioBadge').innerText(),'Alignment estimate');
  await viewer.locator('.studio-alignment summary').click();await viewer.locator('#studio-z').fill('1.25');await viewer.locator('#studio-z').dispatchEvent('change');
  await page.locator('[data-save-room=gpu-dashboard-test]').click();await wait(s=>!s.preview&&!s.jobs.some(j=>j.status==='running'));
  const roomPath=path.join(PROJECT,'site/clips/gpu-dashboard-test/environment.json'),room=JSON.parse(fs.readFileSync(roomPath));assert.equal(room.alignment.z,1.25);assert(!room.calibration);
  assert.equal((await post('clips/gpu-dashboard-test/room-placement',{studio:room.id,sourceSha256:'wrong',alignment:room.alignment})).httpStatus,400);
  assert.equal((await job('preview',{})).status,'complete');
  const splat=path.join(PROJECT,'site/clips/gpu-dashboard-test/studio.splat'),bytes=fs.readFileSync(splat);const changed=Buffer.from(bytes);changed[24]^=1;fs.writeFileSync(splat,changed);
  const stale=await job('publish',{reviewed:true});assert.equal(stale.status,'failed');assert.match(stale.message,/fresh preview/);fs.writeFileSync(splat,bytes);
  await page.screenshot({path:path.join(OUT,'room-review-desktop.png'),fullPage:true});
  pass('Today’s real 1.1-million-Gaussian scan imports on CPU, renders in review, saves placement, rejects wrong-source placement and invalidates publication when scan bytes change');
 }
 await page.locator('#reviewedPreview').check();await page.locator('#publishVideos').click();value=await wait(s=>s.staged.length===0&&!s.jobs.some(j=>j.status==='running'));result=value.jobs.at(-1);assert.equal(result.status,'complete',result.message);pass('Unreviewed/stale 3D blocks publication; approved exact scene and final preview publish successfully to the isolated local Git remote');
 await page.locator('#closeSceneReview').click();for(const width of [390,768,1500]){await page.setViewportSize({width,height:1000});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:path.join(OUT,`dashboard-${width}.png`),fullPage:true});}
 assert.deepEqual(report.errors,[]);assert.deepEqual(report.failed,[]);pass('Desktop, phone and tablet dashboard layouts have no overflow, JavaScript errors or server errors');
}catch(error){report.failure=error.stack;throw error;}finally{fs.writeFileSync(path.join(OUT,'verification.json'),JSON.stringify(report,null,2));if(browser)await browser.close();}})().catch(error=>{console.error(error);process.exitCode=1;});

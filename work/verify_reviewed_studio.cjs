const {chromium}=require(process.env.SYSTEMA_PLAYWRIGHT||'C:/Users/thefo/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{spawn}=require('node:child_process');
const ROOT=path.resolve(__dirname,'..'),OUT=path.join(ROOT,'outputs/review-studio-20261027');fs.mkdirSync(OUT,{recursive:true});
const base='http://127.0.0.1:8794/',report={checks:[],errors:[],failed:[]};let browser,server;
const pass=s=>{report.checks.push(s);console.log('PASS '+s);};
(async()=>{try{
 server=spawn('C:/Users/thefo/AppData/Local/Programs/Python/Python310/python.exe',[path.join(ROOT,'work/preview_pages.py'),'--directory',path.join(ROOT,'work/review-epoch30-ready-20261027'),'--port','8794'],{windowsHide:true,stdio:'ignore'});
 for(let i=0;i<40;i++){try{if((await fetch(base+'catalog.json')).ok)break;}catch{}await new Promise(r=>setTimeout(r,150));}
 browser=await chromium.launch({channel:'msedge',headless:true});const context=await browser.newContext({viewport:{width:1484,height:1000},acceptDownloads:true}),page=await context.newPage();page.setDefaultTimeout(60000);
 page.on('pageerror',e=>report.errors.push(e.message));page.on('response',r=>{if(r.status()>=400&&!r.url().endsWith('favicon.ico'))report.failed.push(r.url());});
 await page.goto(base);await page.locator('.clip-card').last().waitFor();
 const href=await page.locator('.clip-card').filter({hasText:'Striking and pad work'}).locator('.file-button').getAttribute('href');assert(href.includes('scene.html'));
 pass('Library opens prepared 3D lessons directly in the scene');
 await page.evaluate(()=>localStorage.setItem('systema-scene-view-v1','video'));
 await page.goto(href+'&frame=3100');await page.waitForFunction(()=>document.getElementById('studioStatus').dataset.state==='ready');
 assert.equal(await page.locator('[data-scene-view="compare"]').getAttribute('aria-pressed'),'true');assert.equal(await page.locator('[data-camera="source"]').getAttribute('aria-pressed'),'true');
 assert(await page.locator('#studioVisible').isChecked());assert.equal(await page.locator('#scenePeople input[type=checkbox]').count(),2);
 const config=await (await fetch(base+'lessons/systema-striking-and-pad-work/environment.json')).json();assert.equal(config.sourceSha256,'9ceb7bcedfae221798baf73e1ec151830ab710e77b297481970e1e12781072a5');
 pass('Fresh default overrides legacy layout preferences and shows Compare, Source camera and the epoch-30 scan');
 const scrub=async f=>{await page.locator('#sceneScrub').evaluate((el,f)=>{el.value=String(f);el.dispatchEvent(new Event('input'));},f);await page.waitForFunction(f=>document.querySelector('#orbitStage canvas').dataset.sourceCameraFrame===String(f)&&!document.getElementById('sceneVideo').seeking,f);};
 for(const f of [0,2822,3100]){await scrub(f);await page.waitForTimeout(400);await page.screenshot({path:path.join(OUT,`frame-${f}.png`)});}
 pass('Scan and source camera render before and after the camera cut; seeking remains synchronized');
 await scrub(0);await page.locator('.studio-alignment > summary').click();const firstYaw=await page.locator('#studio-yaw').inputValue();const firstX=Number(await page.locator('#studio-x').inputValue());await page.locator('#studio-x').fill(String(firstX+.1));await page.locator('#studio-x').dispatchEvent('change');
 await scrub(3100);assert.notEqual(await page.locator('#studio-yaw').inputValue(),firstYaw);const padX=await page.locator('#studio-x').inputValue();await scrub(0);assert(Math.abs(Number(await page.locator('#studio-x').inputValue())-firstX-.1)<.0002);await page.locator('#studioReset').click();await scrub(3100);assert.equal(await page.locator('#studio-x').inputValue(),padX);
 const alignmentDownload=page.waitForEvent('download');await page.locator('#studioExport').click();await(await alignmentDownload).saveAs(path.join(OUT,'pad-alignment.json'));assert.equal(JSON.parse(fs.readFileSync(path.join(OUT,'pad-alignment.json'))).shotStartFrame,2822);await scrub(0);await page.locator('#studioImport').setInputFiles(path.join(OUT,'pad-alignment.json'));await page.waitForFunction(()=>document.getElementById('studioStatus').textContent.includes('does not match'));assert.match(await page.locator('#studioStatus').textContent(),/does not match/);await scrub(3100);
 pass('Each shot uses its own placement, remembers edits independently, resets independently and rejects another shot’s alignment import');

 await page.locator('#strikeCueNew').click();await page.locator('#strikeCueName').fill('Manual mitt strike');await page.locator('#strikeCueStriker').selectOption('2');await page.locator('#strikeCueTarget').selectOption('1');await page.locator('#strikeCueJoint').selectOption('left_wrist');
 await scrub(3101);await page.getByRole('button',{name:'Use current frame',exact:true}).click();assert.equal(await page.locator('#strikeCueFrame').inputValue(),'3101');
 await page.locator('#strikeCueSave').click();assert.equal(await page.locator('.strike-item').count(),1);
 const downloadEvent=page.waitForEvent('download');await page.locator('#strikeCueExport').click();const download=await downloadEvent;await download.saveAs(path.join(OUT,'manual-cue.json'));
 const cues=JSON.parse(fs.readFileSync(path.join(OUT,'manual-cue.json'))).cues;assert.equal(cues.length,1);assert.equal(cues[0].frame,3101);assert.equal(cues[0].targetJoint,'left_wrist');assert.equal(cues[0].strikerId,'2');
 await page.reload();await page.waitForFunction(()=>document.getElementById('studioStatus').dataset.state==='ready');assert.equal(await page.locator('.strike-item').count(),1);
 await page.getByRole('button',{name:'Edit Manual mitt strike',exact:true}).click();await page.locator('#strikeCueFrame').fill('3102');await page.locator('#strikeCueSave').click();assert.equal(await page.locator('.strike-item').count(),1);
 pass('Manual mitt cue takes the current frame, saves, exports, survives reload and can be edited without reconstructing');
 for(const width of [390,768]){await page.setViewportSize({width,height:900});await page.evaluate(()=>window.scrollTo(0,0));assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert(await page.locator('#scenePanel').isVisible());assert(await page.locator('#sceneFootagePanel').isVisible());await page.screenshot({path:path.join(OUT,`compare-${width}.png`)});}
 pass('Compare retains both views on phone and tablet without horizontal overflow');
 await page.locator('[data-scene-view="scene"]').click();await page.reload();await page.waitForFunction(()=>document.getElementById('studioStatus').dataset.state==='ready');assert.equal(await page.locator('[data-scene-view="scene"]').getAttribute('aria-pressed'),'true');
 pass('User layout choices remain remembered after setting the new default');
 await page.goto(base+'scene.html?clip=multiple-attackers');await page.waitForFunction(()=>document.getElementById('studioStatus').dataset.state==='ready');assert.equal(await page.locator('#scenePeople input[type=checkbox]').count(),4);pass('Legacy single-placement studio still loads all four participants');
assert.deepEqual(report.errors,[]);assert.deepEqual(report.failed,[]);pass('No browser errors or failed asset requests');
 }catch(e){report.failure=e.stack;throw e;}finally{fs.writeFileSync(path.join(OUT,'verification.json'),JSON.stringify(report,null,2));await browser?.close();server?.kill();}})().catch(e=>{console.error(e);process.exitCode=1;});

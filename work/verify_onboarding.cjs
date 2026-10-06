const {chromium} = require('C:/Users/thefo/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname,'..'), BASE = 'http://127.0.0.1:8770';
const OUT = path.join(ROOT,'outputs','onboarding'); fs.mkdirSync(OUT,{recursive:true});
const results = {checks:[],errors:[]};
function passed(name) { results.checks.push(name); console.log('PASS '+name); }
async function request(url,body) {
  return fetch(BASE+url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
}
(async () => {
  const browser = await chromium.launch({channel:'msedge',headless:true});
  try {
    const page = await browser.newPage({viewport:{width:1366,height:1000}});
    page.on('pageerror',e=>results.errors.push(e.message));
    await page.goto(BASE); await page.locator('#videoFile').waitFor({state:'attached'});
    await page.screenshot({path:path.join(OUT,'start.png'),fullPage:true});
    await page.locator('#videoFile').setInputFiles(path.join(ROOT,'outputs','pilot','source-reference.mp4'));
    await page.locator('#passagePanel:not([hidden])').waitFor({timeout:240000});
    const id = new URL(page.url()).searchParams.get('project'); results.projectId=id;
    await page.waitForFunction(()=>document.getElementById('sourceVideo').readyState>=2);
    await page.locator('#setupTitle').fill('QA onboarding — two selected passages');
    await page.locator('#rangeStart').fill('0.2'); await page.locator('#rangeEnd').fill('0.6');
    await page.locator('#rangeLabel').fill('First exchange'); await page.locator('#addPassage').click();
    await page.locator('#rangeStart').fill('0.4'); await page.locator('#rangeEnd').fill('0.8');
    await page.locator('#addPassage').click(); assert(await page.locator('#setupError').isVisible());
    assert.equal(await page.locator('.passage-row').count(),1);
    await page.locator('#rangeStart').fill('1.0'); await page.locator('#rangeEnd').fill('1.4');
    await page.locator('#rangeLabel').fill('<Contact>'); await page.locator('#addPassage').click();
    await page.locator('#saveDraft').click(); await page.waitForFunction(()=>document.getElementById('draftStatus').textContent.includes('Draft saved'));
    await page.reload(); await page.locator('.passage-row').nth(1).waitFor();
    assert.equal(await page.locator('#setupTitle').inputValue(),'QA onboarding — two selected passages');
    assert.equal(await page.locator('.passage-row strong').nth(1).textContent(),'<Contact>');
    passed('Real video upload, playable normalized footage, non-overlapping named passages, saved draft survives reload');
    for (const segments of [[{start:1,end:.5}],[{start:0,end:99}],[{start:0,end:1},{start:.5,end:2}],[{start:'bad',end:1}]]) {
      const response=await request(`/api/projects/${id}/draft`,{title:'invalid',segments}); assert.equal(response.status,400);
    }
    const crossOrigin=await fetch(BASE+`/api/projects/${id}/generate`,{method:'POST',headers:{Origin:'https://other.invalid','Content-Type':'application/json'},body:'{}'});
    assert.equal(crossOrigin.status,400);
    passed('Server rejects invalid ranges and cross-origin writes');
    for(const size of [{width:1024,height:768},{width:834,height:1194},{width:390,height:844}]) {
      await page.setViewportSize(size); assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    }
    await page.setViewportSize({width:1024,height:768});
    await page.screenshot({path:path.join(OUT,'passages-tablet.png'),fullPage:true});
    await page.locator('#generate').click(); await page.locator('#generationPanel:not([hidden])').waitFor();
    await page.reload(); await page.locator('#generationPanel:not([hidden])').waitFor();
    await page.locator('#openLesson:not([hidden])').waitFor({timeout:240000});
    const motion = await (await fetch(BASE+`/lessons/${id}/motion.json`)).json();
    assert.equal(motion.frames.length,24);
    assert(motion.frames.every(f=>(f.frame>=6 && f.frame<18)||(f.frame>=30 && f.frame<42)));
    assert(motion.frames.some(f=>f.people.length)); assert.equal(motion.coordinateSpace,'image-2d');
    passed('Real model generation runs only in selected passages and preparation survives browser reload');
    await page.locator('#openLesson').click();
    await page.waitForFunction(()=>document.getElementById('video').readyState>=2 && document.querySelector('[data-track-id]'));
    async function scrub(frame) {
      await page.locator('#scrub').evaluate((el,frame)=>{el.value=frame;el.dispatchEvent(new Event('input'));},frame);
      await page.waitForFunction(frame=>{const v=document.getElementById('video');return !v.seeking && Math.abs(v.currentTime-frame/30)<.02;},frame);
    }
    const visibleSkeleton=()=>page.locator('#skeleton').evaluate(c=>c.getContext('2d').getImageData(0,0,c.width,c.height).data.some((v,i)=>i%4===3&&v));
    await scrub(9); assert(await visibleSkeleton()); await scrub(24); assert.equal(await visibleSkeleton(),false);
    await scrub(33); assert(await visibleSkeleton());
    await page.locator('#addNote').click(); await page.locator('#noteTitle').fill('Check the contact');
    await page.locator('#noteText').fill('A teaching note in an uploaded passage.'); await page.locator('#saveNote').click();
    await page.locator('#noteDetail:not([hidden])').waitFor();
    const lesson=await (await fetch(BASE+`/api/lesson?project=${id}`)).json(); assert.equal(lesson.notes.length,1);
    const pilot=await (await fetch(BASE+'/api/lesson')).json(); assert(!pilot.notes.some(n=>n.title==='Check the contact'));
    passed('Uploaded lesson displays skeletons only in selected passages; notes are saved to its own lesson');
    const popup=page.waitForEvent('popup'); await page.locator('#classView').click(); const student=await popup;
    student.on('pageerror',e=>results.errors.push(e.message)); await student.locator('.note-card').waitFor();
    await student.waitForFunction(()=>document.getElementById('video').readyState>=2);
    assert.equal(await student.locator('#newLesson').isVisible(),false);
    assert(Math.abs(await student.locator('#video').evaluate(v=>v.duration)-12)<.1);
    assert((await student.locator('#video').getAttribute('src')).startsWith('/published/'));
    await student.locator('.note-card').click(); await student.waitForFunction(()=>!document.getElementById('video').seeking);
    results.classUrl=student.url(); results.archive=await page.locator('#downloadLesson').getAttribute('href');
    const packageResponse=await fetch(BASE+results.archive);assert.equal(packageResponse.status,200);
    fs.writeFileSync(path.join(OUT,'lesson-package.zip'),Buffer.from(await packageResponse.arrayBuffer()));
    await page.screenshot({path:path.join(OUT,'review-tablet.png'),fullPage:true});
    passed('Uploaded lesson creates a separate playable class snapshot and complete downloadable package');
    assert.deepEqual(results.errors,[]); results.success=true;
    passed('Tablet and phone onboarding layouts fit; no JavaScript errors');
  } finally { await browser.close(); fs.writeFileSync(path.join(OUT,'validation.json'),JSON.stringify(results,null,2)); }
})().catch(e=>{console.error(e);process.exitCode=1;});

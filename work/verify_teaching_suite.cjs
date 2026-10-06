const {chromium} = require('C:/Users/thefo/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname,'..');
const OUT = path.join(ROOT,'outputs','teaching-suite');
fs.mkdirSync(OUT,{recursive:true});
const BASE = 'http://127.0.0.1:8770';
const prefix = 'QA-' + Date.now();
const results = {checkedAt:new Date().toISOString(),checks:[],consoleErrors:[]};
const ids = [];
function passed(name) { results.checks.push(name); console.log('PASS '+name); }
async function post(url,value) {
  const r = await fetch(BASE+url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(value)});
  assert.equal(r.status,200); return r.json();
}
async function load(page,url=BASE+'/?demo=1') {
  await page.goto(url,{waitUntil:'domcontentloaded'});
  await page.waitForSelector('.note-card');
  await page.waitForFunction(() => document.getElementById('video').readyState >= 2);
  assert.equal(await page.locator('#videoError').isVisible(),false);
}
async function scrub(page,frame) {
  await page.locator('#scrub').evaluate((el,value) => { el.value = String(value); el.dispatchEvent(new Event('input',{bubbles:true})); },frame);
  await page.waitForFunction(value => {const video=document.getElementById('video');return !video.seeking && video.readyState>=2 && Math.abs(video.currentTime-value/30)<.04;},frame);
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
}

(async () => {
  const browser = await chromium.launch({channel:'msedge',headless:true,
    args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream']});
  try {
    const context = await browser.newContext({viewport:{width:1366,height:900},permissions:['microphone']});
    const page = await context.newPage();
    page.on('pageerror',e => results.consoleErrors.push(e.message));
    await load(page);
    assert.equal(await page.locator('.note-card').count(),3);
    assert.equal(await page.locator('#video').evaluate(v=>v.duration),12);
    await scrub(page,234);
    const hasSkeleton = await page.locator('#skeleton').evaluate(c => c.getContext('2d').getImageData(0,0,c.width,c.height).data.some((v,i)=>i%4===3 && v>0));
    assert(hasSkeleton);
    passed('Pilot video decodes and skeleton follows the timeline');

    await page.locator('[data-view="motion"]').click();
    assert.equal(await page.locator('#stage').evaluate(el=>el.classList.contains('motion')),true);
    await page.locator('[data-track-id="3"]').click();
    assert.equal(await page.locator('[data-track-id="3"]').getAttribute('aria-pressed'),'false');
    await page.locator('[data-track-id="3"]').click();
    await page.locator('[data-view="footage"]').click();
    passed('Motion view and participant filtering work');

    await page.locator('#addNote').click();
    const motion = await (await fetch(BASE+'/motion.json')).json();
    const hand = motion.frames[234].people.find(p=>p.id===1).xy[10];
    const box = await page.locator('#stage').boundingBox();
    await page.mouse.click(box.x+hand[0]/1920*box.width,box.y+hand[1]/1080*box.height);
    assert.equal(await page.locator('#notePerson').inputValue(),'1');
    assert.equal(await page.locator('#noteJoint').inputValue(),'10');
    await page.locator('#noteTitle').fill(prefix+' hand explanation');
    await page.locator('#noteText').fill('A test explanation with <strong>literal text</strong>.');
    await page.locator('#noteStart').fill('25.8'); await page.locator('#noteEnd').fill('27.8');
    await page.locator('#saveNote').click();
    await page.waitForSelector('#noteDetail:not([hidden])');
    let live = await (await fetch(BASE+'/api/lesson')).json();
    const note = live.notes.find(n=>n.title===prefix+' hand explanation'); ids.push(note.id);
    assert.equal(note.trackId,1); assert.equal(note.jointIndex,10);
    assert.equal(await page.locator('#detailText strong').count(),0);
    assert.equal(await page.locator('.note-pin[data-note-id="'+note.id+'"]').count(),1);
    const before = await page.locator('.note-pin[data-note-id="'+note.id+'"]').getAttribute('style');
    await scrub(page,260);
    const after = await page.locator('.note-pin[data-note-id="'+note.id+'"]').getAttribute('style');
    assert.notEqual(before,after);
    await page.reload({waitUntil:'domcontentloaded'}); await page.waitForSelector('.note-card[data-note-id="'+note.id+'"]');
    await page.locator('.note-card[data-note-id="'+note.id+'"]').click();
    await page.locator('#editNote').click(); await page.locator('#noteText').fill('A revised test explanation — breathe naturally.');
    await page.locator('#saveNote').click(); await page.waitForSelector('#noteDetail:not([hidden])');
    assert.equal(await page.locator('#detailText').textContent(),'A revised test explanation — breathe naturally.');
    passed('Tap a joint, save safe text, follow the joint, reload and edit the note');

    await page.locator('#closeDetail').click(); await scrub(page,0); await page.locator('#addNote').click();
    await page.locator('#noteTitle').fill(prefix+' voice explanation');
    await page.locator('#record').click();
    await page.waitForSelector('#record.recording');
    assert.equal(await page.locator('#saveNote').isDisabled(),true);
    await page.waitForTimeout(1600); await page.locator('#record').click();
    await page.waitForFunction(()=>!document.getElementById('saveNote').disabled && !document.getElementById('editorAudio').hidden);
    await page.locator('#saveNote').click(); await page.waitForSelector('#noteDetail:not([hidden])');
    live = await (await fetch(BASE+'/api/lesson')).json();
    const voice = live.notes.find(n=>n.title===prefix+' voice explanation'); ids.push(voice.id);
    assert(voice.audio); assert.equal(voice.text,'');
    const audio = await fetch(BASE+'/audio/'+voice.audio); assert.equal(audio.status,200);
    assert((await audio.arrayBuffer()).byteLength>500);
    await page.waitForFunction(()=>document.getElementById('detailAudio').readyState>=1);
    assert(await page.locator('#detailAudio').evaluate(a=>a.duration>0));
    passed('Browser microphone recording saves a decodable voice-only explanation (synthetic microphone)');

    await page.locator('#closeDetail').click(); await page.locator('#addNote').click();
    await page.locator('#noteTitle').fill(prefix+' attached audio');
    const rate=22050, count=rate, wave=Buffer.alloc(44+count*2);
    wave.write('RIFF',0); wave.writeUInt32LE(wave.length-8,4); wave.write('WAVEfmt ',8);
    wave.writeUInt32LE(16,16);wave.writeUInt16LE(1,20);wave.writeUInt16LE(1,22);
    wave.writeUInt32LE(rate,24);wave.writeUInt32LE(rate*2,28);wave.writeUInt16LE(2,32);wave.writeUInt16LE(16,34);
    wave.write('data',36);wave.writeUInt32LE(count*2,40);
    for(let i=0;i<count;i++) wave.writeInt16LE(Math.round(Math.sin(i/rate*2*Math.PI*440)*1500),44+i*2);
    await page.locator('#audioFile').setInputFiles({name:'test-explanation.wav',mimeType:'audio/wav',buffer:wave});
    await page.locator('#saveNote').click();await page.waitForSelector('#noteDetail:not([hidden])');
    live = await (await fetch(BASE+'/api/lesson')).json();
    const attached = live.notes.find(n=>n.title===prefix+' attached audio');ids.push(attached.id);
    assert(attached.audio.endsWith('.wav'));
    await page.waitForFunction(()=>document.getElementById('detailAudio').readyState>=1);
    assert(await page.locator('#detailAudio').evaluate(a=>a.duration>0));
    passed('Attached audio saves and plays as the recording fallback');

    await page.locator('#closeDetail').click();
    const popupPromise = page.waitForEvent('popup');
    await page.locator('#classView').click(); const student = await popupPromise;
    student.on('pageerror',e=>results.consoleErrors.push(e.message));
    await student.waitForSelector('.note-card');
    const classUrl = student.url(); results.testSnapshotUrl = classUrl;
    for (const id of ['addNote','classView','authorFooter','detailAuthorActions']) assert.equal(await student.locator('#'+id).isVisible(),false);
    await student.locator('.note-card[data-note-id="'+note.id+'"]').click();
    assert.equal(await student.locator('#detailTitle').textContent(),note.title);
    assert.equal(await student.locator('#video').evaluate(v=>v.currentTime),7.8);
    await student.locator('#speed').selectOption('0.5');
    assert.equal(await student.locator('#video').evaluate(v=>v.playbackRate),.5);
    await student.locator('#loopPassage').check(); await student.locator('#replayPassage').click();
    await student.waitForFunction(()=>!document.getElementById('video').paused);
    await student.locator('#video').evaluate(v=>{v.currentTime=9.85;});
    await student.waitForFunction(()=>document.getElementById('video').currentTime<8.3);
    await student.locator('#play').click();
    await post('/api/notes/delete',{id:note.id});
    await student.reload({waitUntil:'domcontentloaded'}); await student.waitForSelector('.note-card[data-note-id="'+note.id+'"]');
    passed('Saved class view has no authoring controls, jumps to notes, slows and loops passages, and keeps its fixed notes');

    await page.locator('#downloadLesson').waitFor({state:'visible'});
    const archiveUrl = await page.locator('#downloadLesson').getAttribute('href');
    const archive = await fetch(BASE+archiveUrl); assert.equal(archive.status,200);
    fs.writeFileSync(path.join(OUT,'qa-lesson-package.zip'),Buffer.from(await archive.arrayBuffer()));
    results.testArchive = archiveUrl;
    passed('Self-contained class package downloads with the saved lesson');

    await post('/api/notes/delete',{id:voice.id});
    await post('/api/notes/delete',{id:attached.id});
    await load(page);
    for (const size of [{width:1024,height:768},{width:834,height:1194},{width:390,height:844}]) {
      await page.setViewportSize(size);
      assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
      await page.locator('#addNote').click();
      assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
      await page.locator('#cancelEdit').click();
    }
    await page.setViewportSize({width:1024,height:768}); await scrub(page,234);
    await page.screenshot({path:path.join(OUT,'instructor-ipad-preview.png'),fullPage:true});
    const cleanClass = await post('/api/class-view',{}); results.classViewUrl = BASE+cleanClass.url;
    results.classArchiveUrl = BASE+cleanClass.archive;
    await student.setViewportSize({width:1024,height:768}); await load(student,results.classViewUrl); await scrub(student,234);
    await student.screenshot({path:path.join(OUT,'student-ipad-preview.png'),fullPage:true});
    await student.locator('.note-card[data-note-id="sample-hands"]').click();
    await student.waitForFunction(()=>!document.getElementById('video').seeking);
    await student.screenshot({path:path.join(OUT,'student-note-preview.png'),fullPage:true});
    assert.equal(results.consoleErrors.length,0);
    passed('Landscape tablet, portrait tablet and phone layouts have no horizontal overflow; no JavaScript errors');
    results.success = true;
  } finally {
    // Only remove notes created by this verification run, preserving instructor work.
    const live = await (await fetch(BASE+'/api/lesson')).json();
    for (const n of live.notes.filter(n=>n.title.startsWith(prefix))) await post('/api/notes/delete',{id:n.id});
    await browser.close();
    fs.writeFileSync(path.join(OUT,'validation.json'),JSON.stringify(results,null,2));
  }
})().catch(e=>{console.error(e);process.exitCode=1;});

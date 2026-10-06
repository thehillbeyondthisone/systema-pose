const {chromium} = require('C:/Users/thefo/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {spawn,spawnSync} = require('node:child_process');
const ROOT = path.resolve(__dirname,'..');
const OUT = path.join(ROOT,'outputs','student-workspace');
const DATA = path.join(OUT,'test-data-'+Date.now());
const PYTHON = 'C:/Users/thefo/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe';
const BASE = 'http://127.0.0.1:8771';
const env = {...process.env,SYSTEMA_DATA_DIR:DATA,PYTHONDONTWRITEBYTECODE:'1'};
const results = {checkedAt:new Date().toISOString(),checks:[],consoleErrors:[]};
fs.mkdirSync(DATA,{recursive:true});
const fixtureId = '0123456789abcdef0123456789abcdef';
const fixture = path.join(DATA,'lessons',fixtureId);
fs.mkdirSync(fixture,{recursive:true});
const motion = JSON.parse(fs.readFileSync(path.join(ROOT,'teaching_suite/public/motion.json'),'utf8'));
fs.writeFileSync(path.join(fixture,'motion.json'),JSON.stringify({...motion,sourceStart:0,sourceEnd:12,frames:motion.frames.map((frame,i)=>({...frame,frame:i}))}));
fs.copyFileSync(path.join(ROOT,'outputs/pilot/source-reference.mp4'),path.join(fixture,'source.mp4'));
fs.writeFileSync(path.join(fixture,'lesson.json'),JSON.stringify({schemaVersion:2,id:fixtureId,title:'Prepared QA lesson',
  sourceStart:0,sourceEnd:12,width:1920,height:1080,fps:30,video:`/lessons/${fixtureId}/source.mp4`,motion:`/lessons/${fixtureId}/motion.json`,
  people:[{id:1,name:'Instructor',color:'#ffc044'},{id:2,name:'Grey shirt',color:'#4ad4ff'},{id:3,name:'Blue shirt',color:'#ea69e6'},{id:4,name:'White shirt',color:'#7cea91'}],
  status:'ready',segments:[{start:0,end:12,label:'Exchange'}],notes:[],updatedAt:new Date().toISOString()}));
const server = spawn(PYTHON,['teaching_suite/server.py','--port','8771'],{cwd:ROOT,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
const log = fs.createWriteStream(path.join(OUT,'server.log'));
server.stdout.pipe(log);server.stderr.pipe(log);
let browser;
function pass(name){results.checks.push(name);console.log('PASS '+name);}
async function ready(){let lastError;for(let i=0;i<150;i++){try{if((await fetch(BASE+'/api/projects')).ok)return;}catch(error){lastError=error;}await new Promise(r=>setTimeout(r,100));}throw Error('Server did not start',{cause:lastError});}
async function load(page,url=BASE+'/?demo=1'){
  await page.goto(url,{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>!document.getElementById('addNote').disabled && document.getElementById('participants').children.length>0 && document.getElementById('video').readyState>=2);
  assert.equal(await page.locator('#videoError').isVisible(),false);
  await page.locator('[data-preset="annotate"]').click();
}
async function scrub(page,frame){
  await page.locator('#scrub').evaluate((el,value)=>{el.value=value;el.dispatchEvent(new Event('input',{bubbles:true}));},String(frame));
  await page.waitForFunction(value=>{const v=document.getElementById('video');return !v.seeking&&Math.abs(v.currentTime-value/30)<.01;},frame);
  await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
}
const note = {title:'Personal observation',text:'Watch <strong>literal text</strong> here.',start:25.8,end:27.8,trackId:1,jointIndex:10,anchor:{x:.6,y:.5},audio:null};
async function annotations(context,query=''){return (await context.request.get(BASE+'/api/annotations'+query)).json();}
async function post(context,url,data){return context.request.post(BASE+url,{data});}
function status(id,value,lesson){
  const args=['teaching_suite/manage_requests.py','status',id,value,...(lesson?['--lesson',lesson]:[])];
  const r=spawnSync(PYTHON,args,{cwd:ROOT,env,encoding:'utf8',windowsHide:true});assert.equal(r.status,0,r.stderr);
}
(async()=>{
  try {
    await ready();
    browser=await chromium.launch({channel:'msedge',headless:true});
    const a=await browser.newContext({viewport:{width:1440,height:960}});
    const b=await browser.newContext({viewport:{width:1440,height:960}});
    const page=await a.newPage(), other=await b.newPage();
    for(const p of [page,other])p.on('pageerror',error=>results.consoleErrors.push(error.message));
    await page.goto(BASE+'/');await page.waitForSelector('#requestForm');
    assert.equal(await page.locator('input[type=file]').count(),0);
    assert.equal(await page.getByText('Instructor workspace').count(),0);
    await page.locator('#requestName').fill('Student Alice');await page.locator('#requestTitle').fill('Study <b>contact</b>');
    await page.locator('#requestUrl').fill('https://example.com/movement-video');await page.locator('#requestPassage').fill('1:20–1:45');
    await page.locator('#requestMessage').fill('Explore the timing of the first contact.');await page.locator('#submitRequest').click();
    await page.waitForSelector('.request-item');assert.equal(await page.locator('.request-item h3 b').count(),0);
    const requests=await (await a.request.get(BASE+'/api/video-requests')).json();const request=requests.requests[0];
    assert.equal(request.status,'requested');assert.equal(request.passage,'1:20–1:45');assert(!request.studentId);
    await page.reload();await page.waitForSelector('.request-item');
    assert.equal((await (await b.request.get(BASE+'/api/video-requests')).json()).requests.length,0);
    for(const url of ['javascript:alert(1)','file:///tmp/video','https://user:password@example.com/video','https://example.com/a\nvideo']){
      assert.equal((await post(a,'/api/video-requests',{name:'Alice',title:'Invalid',url})).status(),400);
    }
    assert.equal((await post(a,'/api/videos',{})).status(),410);
    assert.equal((await post(a,`/api/projects/${fixtureId}/generate`,{})).status(),410);
    status(request.id,'processing');await page.locator('#refreshRequests').click();await page.getByText('Being processed',{exact:true}).waitFor();
    status(request.id,'ready',fixtureId);await page.locator('#refreshRequests').click();await page.getByText('Open prepared lesson',{exact:true}).waitFor();
    assert.equal(await page.getByText('Open prepared lesson',{exact:true}).getAttribute('href'),`/?project=${fixtureId}`);
    await page.screenshot({path:path.join(OUT,'video-requests.png'),fullPage:true});
    pass('Video links replace uploads; requests persist, validate, stay separate, and link to prepared lessons');

    await load(page);await load(other);
    assert.equal(await page.locator('#classView,#backToTeach,#modeBadge').count(),0);
    await scrub(page,234);await page.locator('#addNote').click();
    const hand=motion.frames[234].people.find(p=>p.id===1).xy[10];const box=await page.locator('#stage').boundingBox();
    await page.mouse.click(box.x+hand[0]/1920*box.width,box.y+hand[1]/1080*box.height);
    assert.equal(await page.locator('#notePerson').inputValue(),'1');assert.equal(await page.locator('#noteJoint').inputValue(),'10');
    await page.locator('#noteTitle').fill(note.title);await page.locator('#noteText').fill(note.text);
    await page.locator('#noteStart').fill('25.8');await page.locator('#noteEnd').fill('27.8');
    await page.locator('#saveNote').click();await page.waitForSelector('#noteDetail:not([hidden])');
    const saved=(await annotations(a)).notes[0];assert.equal(saved.trackId,1);assert.equal(saved.jointIndex,10);
    assert.equal(await page.locator('#detailText strong').count(),0);
    const line=page.locator(`polyline[data-note-id="${saved.id}"]`), callout=page.locator(`.annotation-callout[data-note-id="${saved.id}"]`);
    await line.waitFor();const first=await line.getAttribute('points');
    const stage=await page.locator('#stage').boundingBox(),card=await callout.boundingBox();assert(card.x>=stage.x+stage.width);
    const styles=await line.evaluate(el=>({stroke:getComputedStyle(el).stroke,width:getComputedStyle(el).strokeWidth}));
    assert.equal(styles.stroke,'rgb(245, 214, 60)');assert.equal(styles.width,'1.25px');
    await scrub(page,260);assert.notEqual(await line.getAttribute('points'),first);
    await page.locator('[data-track-id="1"]').click();assert.equal(await line.count(),0);assert((await callout.textContent()).includes('target unavailable'));
    await page.locator('[data-track-id="1"]').click();await line.waitFor();
    await scrub(page,233);assert.equal(await line.count(),0);assert.equal(await callout.count(),0);
    await scrub(page,234);await line.waitFor();await scrub(page,294);assert.equal(await line.count(),0);assert.equal(await callout.count(),0);
    await scrub(page,250);await page.screenshot({path:path.join(OUT,'annotations-desktop.png'),fullPage:true});
    await page.reload();await page.waitForSelector(`.note-card[data-note-id="${saved.id}"]`);
    assert.equal((await annotations(b)).notes.length,0);
    assert.equal((await post(b,'/api/notes',{...saved,text:'Try to edit Alice'})).status(),400);
    assert.equal((await post(b,'/api/notes/delete',{id:saved.id})).status(),400);
    await other.reload();await other.waitForSelector('.note-card');assert.equal(await other.getByText(note.title,{exact:true}).count(),0);
    await page.locator(`.note-card[data-note-id="${saved.id}"]`).click();await page.locator('#editNote').click();
    await page.locator('#noteText').fill('Let the wrist move before the body follows.');await page.locator('#saveNote').click();
    await page.waitForSelector('#noteDetail:not([hidden])');assert.equal(await page.locator('#detailText').textContent(),'Let the wrist move before the body follows.');
    await page.locator('#replayPassage').click();
    await page.waitForFunction(()=>{const v=document.getElementById('video');return v.paused&&v.currentTime>=9.79;});
    assert.equal(await line.count(),0);
    await page.locator('#loopPassage').check();await page.locator('#replayPassage').click();
    await page.waitForTimeout(2300);
    assert(await page.locator('#video').evaluate(v=>!v.paused&&v.currentTime>=7.8&&v.currentTime<9.8));
    await page.locator('#play').click();await page.locator('#loopPassage').uncheck();
    pass('Students create, edit and reload personal annotations; yellow lines follow joints only during the chosen range');

    assert.equal(await page.locator('#record,#audioFile,#detailAudio,#editorAudio').count(),0);
    assert.equal((await a.request.post(BASE+'/api/audio',{data:Buffer.from('old audio'),headers:{'Content-Type':'audio/wav'}})).status(),410);
    assert.equal((await post(a,'/api/notes',{...note,text:'',audio:'old.wav'})).status(),400);
    assert.equal((await post(a,'/api/notes',{...note,audio:'old.wav'})).status(),400);
    const student=(await a.cookies()).find(cookie=>cookie.name==='systema_student').value;
    const legacyPath=path.join(DATA,'students',student,'sample.json');
    const legacyAudio=path.join(DATA,'students',student,'audio','old.wav');
    fs.mkdirSync(path.dirname(legacyAudio),{recursive:true});fs.writeFileSync(legacyAudio,'existing recording');
    fs.writeFileSync(legacyPath,JSON.stringify([...(await annotations(a)).notes,{...note,id:'legacy-audio',title:'Older observation',text:'',audio:'old.wav'}]));
    assert.equal((await a.request.get(BASE+'/student-audio/old.wav')).status(),404);
    await page.reload();await page.waitForSelector('.note-card[data-note-id="legacy-audio"]');
    await page.locator('.note-card[data-note-id="legacy-audio"]').click();
    assert((await page.locator('#detailText').textContent()).includes('no text explanation'));
    await page.locator('#editNote').click();await page.locator('#saveNote').click();
    assert.equal(await page.locator('#editorError').textContent(),'Add a text explanation.');
    await page.locator('#noteText').fill('Text added to an older observation.');await page.locator('#saveNote').click();
    await page.waitForSelector('#noteDetail:not([hidden])');
    assert(!(await annotations(a)).notes.find(n=>n.id==='legacy-audio').audio);
    assert.equal(fs.readFileSync(legacyAudio,'utf8'),'existing recording');
    pass('Annotations work over HTTP without microphone controls; audio uploads are disabled and older notes can become text without deleting files');

    await page.locator('#closeDetail').click();await scrub(page,250);
    const sceneNote=(await (await post(a,'/api/notes',{...note,title:'Scene observation',trackId:0,jointIndex:null,anchor:{x:.15,y:.25},start:25.8,end:27.8})).json()).note;
    await page.reload();await page.waitForSelector(`.note-card[data-note-id="${sceneNote.id}"]`);await scrub(page,250);
    assert.equal(await page.locator(`polyline[data-note-id="${sceneNote.id}"]`).count(),1);
    assert.equal(await page.locator(`polyline[data-note-id="${saved.id}"]`).count(),1);
    pass('Overlapping annotations and fixed scene points display beside the footage');
    for(const [width,height] of [[1024,768],[834,1194],[390,844]]){
      await page.setViewportSize({width,height});await scrub(page,250);
      assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`Lesson overflow at ${width}`);
      const s=await page.locator('#stage').boundingBox(),r=await page.locator('#annotationRail').boundingBox();assert(r.x>=s.x+s.width-1);
      await page.screenshot({path:path.join(OUT,`annotations-${width}.png`),fullPage:true});
      await page.goto(BASE+'/');await page.waitForSelector('.request-item');
      assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`Request overflow at ${width}`);
      await page.screenshot({path:path.join(OUT,`requests-${width}.png`),fullPage:true});await load(page);
    }
    pass('Desktop, landscape tablet, portrait tablet and phone keep annotations beside the video without overflow');

    await page.setViewportSize({width:1440,height:960});await load(page,BASE+`/?project=${fixtureId}`);
    assert.equal((await annotations(a,`?project=${fixtureId}`)).notes.length,0);
    await page.locator('#addNote').click();await page.locator('#noteTitle').fill('Prepared lesson annotation');await page.locator('#noteText').fill('A note for this lesson.');
    await page.locator('#saveNote').click();await page.waitForSelector('#noteDetail:not([hidden])');
    assert.equal((await annotations(a,`?project=${fixtureId}`)).notes.length,1);assert.equal((await annotations(b,`?project=${fixtureId}`)).notes.length,0);
    assert.equal((await annotations(a)).notes.length,3);
    const snapshotId=fs.readdirSync(path.join(ROOT,'teaching_suite/published')).find(id=>fs.existsSync(path.join(ROOT,'teaching_suite/published',id,'lesson.json')));
    await load(page,BASE+`/?mode=learn&lesson=${snapshotId}`);assert(await page.locator('#addNote').isVisible());
    await page.locator('#addNote').click();await page.locator('#noteTitle').fill('Annotation on a shared lesson');await page.locator('#noteText').fill('My personal note.');
    await page.locator('#saveNote').click();await page.waitForSelector('#noteDetail:not([hidden])');
    assert.equal((await annotations(a,`?lesson=${snapshotId}`)).notes.length,1);assert.equal((await annotations(a)).notes.length,3);
    pass('Prepared lessons and existing class links use the same editable student workspace with separate notes per lesson');
    await load(page);await page.locator(`.note-card[data-note-id="${saved.id}"]`).click();
    page.once('dialog',dialog=>dialog.accept());await page.locator('#deleteNote').click();await page.waitForSelector('#noteList:not([hidden])');
    assert(!(await annotations(a)).notes.some(n=>n.id===saved.id));
    assert.equal(JSON.parse(fs.readFileSync(path.join(DATA,'lesson.json'),'utf8')).notes.length,3);
    assert.equal(results.consoleErrors.length,0,results.consoleErrors.join('\n'));
    pass('Deleting a personal annotation leaves shared lesson notes intact; no JavaScript errors');
  } catch(error){results.failure=error.stack;throw error;}
  finally {fs.writeFileSync(path.join(OUT,'validation.json'),JSON.stringify(results,null,2));if(browser)await browser.close();server.kill();log.end();}
})().catch(error=>{console.error(error);process.exitCode=1;});

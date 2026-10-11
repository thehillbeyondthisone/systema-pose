// Exercise the built site under a subpath with no application server.
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'C:/Users/thefo/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {spawn} = require('node:child_process');
const ROOT = path.resolve(__dirname,'..'), OUT = path.join(ROOT,'outputs','pages');
const PYTHON = process.env.SYSTEMA_PYTHON || 'C:/Users/thefo/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe';
const BASE = 'http://127.0.0.1:8781/dist/';
const result = {checks:[],errors:[],requests:[]};
fs.mkdirSync(OUT,{recursive:true});
let browser, server;
const pass = message => { result.checks.push(message); console.log('PASS '+message); };
async function load(page, url=BASE+'lesson.html?clip=multiple-attackers') {
  await page.goto(url,{waitUntil:'networkidle'});
  await page.waitForFunction(()=>document.getElementById('participants').children.length===4 && document.getElementById('video').readyState>=2);
  assert.equal(await page.locator('#videoError').isVisible(),false);
}
async function noOverflow(page) { assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Horizontal page overflow'); }
(async()=>{
  try {
    server = spawn(PYTHON,[path.join(ROOT,'work','preview_pages.py'),'--port','8781','--directory',ROOT],{windowsHide:true,stdio:'ignore'});
    for(let i=0;i<60;i++){try{if((await fetch(BASE+'catalog.json')).ok)break;}catch{}await new Promise(resolve=>setTimeout(resolve,100));}
    browser=await chromium.launch({channel:'msedge',headless:true});
    const context=await browser.newContext({viewport:{width:1440,height:1000},acceptDownloads:true});
    const page=await context.newPage();
    page.on('pageerror',error=>result.errors.push(error.message));
    page.on('request',request=>result.requests.push(new URL(request.url()).pathname));
    await page.goto(BASE,{waitUntil:'networkidle'});
    assert.equal(await page.locator('.clip-card').count(),1);
    assert(await page.locator('.clip-preview img').evaluate(image=>image.complete&&image.naturalWidth>0));
    await page.locator('#clipCategory').selectOption('Sparring');
    assert.equal(await page.locator('.clip-card').count(),0);
    assert(await page.locator('#libraryStatus').isVisible());
    await page.locator('#clipCategory').selectOption('');
    await page.locator('#clipSearch').fill('spacing');
    assert.equal(await page.locator('.clip-card').count(),1);
    await page.locator('#clipSearch').fill('no match here');
    assert.equal(await page.locator('.clip-card').count(),0);
    await page.locator('#clipSearch').fill('');
    await noOverflow(page);
    await page.screenshot({path:path.join(OUT,'library-desktop.png'),fullPage:true});
    await page.getByRole('link',{name:'Open lesson →'}).click();
    await page.waitForFunction(()=>document.getElementById('participants').children.length===4&&document.getElementById('video').readyState>=2);
    pass('Library search, footage categories and clip navigation work under /dist/');
    await page.locator('#scrub').evaluate(input=>{input.value='36';input.dispatchEvent(new Event('input'));});
    await page.waitForFunction(()=>!document.getElementById('video').seeking&&Math.abs(document.getElementById('video').currentTime-1.2)<.01);
    assert.equal(await page.locator('#currentTime').innerText(),'19.200s');
    assert(await page.locator('#skeleton').evaluate(c=>c.getContext('2d').getImageData(0,0,c.width,c.height).data.some((v,i)=>i%4===3&&v>0)));
    pass('Silent-source study loads and frame seeking aligns the 2D skeleton');
    await page.locator('#addNote').click();
    await page.locator('#noteTitle').fill('Keep the contact visible');
    await page.locator('#noteText').fill('<img src=x onerror=alert(1)> Compare the hand with the footage.');
    await page.locator('#saveNote').click();
    await page.waitForFunction(()=>document.getElementById('saveState').textContent==='Annotation saved');
    assert.equal(await page.locator('#detailText img').count(),0);
    const stored=await page.evaluate(()=>Object.keys(localStorage).filter(key=>key.startsWith('systema-notes-v1:')));
    assert.equal(stored.length,1);
    const exportEvent=page.waitForEvent('download');await page.locator('#exportNotes').click();
    const download=await exportEvent, backupPath=path.join(OUT,'notes-backup.json');await download.saveAs(backupPath);
    const backup=JSON.parse(fs.readFileSync(backupPath));assert.equal(backup.notes.length,1);
    await page.reload({waitUntil:'networkidle'});
    await page.locator('[data-preset="annotate"]').click();
    assert.equal(await page.locator('.note-card').count(),1);
    await page.locator('.note-card').click();await page.locator('#editNote').click();
    await page.locator('#noteText').fill('Updated observation');await page.locator('#saveNote').click();
    await page.waitForFunction(()=>document.getElementById('saveState').textContent==='Annotation saved');
    await page.locator('#notesFile').setInputFiles(backupPath);
    await page.waitForFunction(()=>document.querySelectorAll('.note-card').length===2);
    await page.locator('#notesFile').setInputFiles(backupPath);
    assert.equal(await page.locator('.note-card').count(),2);
    const wrong={...backup,lesson:'another-clip:wrong'};
    await page.locator('#notesFile').setInputFiles({name:'wrong.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(wrong))});
    await page.waitForFunction(()=>document.getElementById('toast').textContent.includes('exact clip'));
    assert.equal(await page.locator('.note-card').count(),2);
    page.once('dialog',dialog=>dialog.accept());await page.locator('.note-card').first().click();await page.locator('#deleteNote').click();
    await page.waitForFunction(()=>document.querySelectorAll('.note-card').length===1);
    pass('Browser notes persist, render safely, edit/delete, back up and merge without losing conflicts');
    const other=await browser.newContext();const otherPage=await other.newPage();await load(otherPage);
    await otherPage.locator('[data-preset="annotate"]').click();assert.equal(await otherPage.locator('.note-card').count(),0);await other.close();
    pass('Personal notes stay in their browser profile');
    await page.locator('#chooseViews').click();await page.locator('#sceneLink').click();
    await page.waitForFunction(()=>document.getElementById('sceneStatus').classList.contains('ready'));
    await page.waitForFunction(()=>document.getElementById('sceneVideo').readyState>=2);
    assert(page.url().includes('/dist/scene.html?clip=multiple-attackers&frame=36'));
    await page.locator('#contactEffects').check();
    assert(Number(await page.locator('#contactStatus').getAttribute('data-count'))>0);
    await page.locator('[data-camera="side"]').click();
    assert(Number(await page.locator('#contactStatus').getAttribute('data-count'))>0);
    await page.screenshot({path:path.join(OUT,'scene-contacts-desktop.png'),fullPage:true});
    await page.getByRole('link',{name:'Back to lesson'}).click();await page.waitForFunction(()=>document.getElementById('participants').children.length===4);
    assert(page.url().includes('/dist/lesson.html?clip=multiple-attackers&frame=36'));
    pass('3D scenes, camera-independent contacts and frame-preserving return links work on static hosting');
    for(const size of [{width:390,height:844},{width:768,height:1024}]){
      await page.setViewportSize(size);await noOverflow(page);
      await page.goto(BASE,{waitUntil:'networkidle'});await noOverflow(page);
      await page.screenshot({path:path.join(OUT,`library-${size.width}.png`),fullPage:true});
      await load(page);await noOverflow(page);
      await page.screenshot({path:path.join(OUT,`lesson-${size.width}.png`),fullPage:true});
    }
    pass('Library and lesson layouts fit phone, tablet and desktop');
    const blocked=await browser.newContext();await blocked.addInitScript(()=>{Storage.prototype.setItem=function(){throw new DOMException('QuotaExceededError');};});
    const blockedPage=await blocked.newPage();await load(blockedPage);await blockedPage.locator('#addNote').click();
    await blockedPage.locator('#noteTitle').fill('Unsaved draft');await blockedPage.locator('#noteText').fill('Do not lose this.');await blockedPage.locator('#saveNote').click();
    await blockedPage.waitForFunction(()=>document.getElementById('editorError').textContent.includes('could not be saved'));
    assert(await blockedPage.locator('#noteEditor').isVisible());assert.equal(await blockedPage.locator('#noteText').inputValue(),'Do not lose this.');await blocked.close();
    pass('Storage failures keep the draft open and report that saving failed');
    await page.goto(BASE+'lesson.html?clip=missing',{waitUntil:'networkidle'});assert(await page.locator('#videoError').isVisible());assert(await page.locator('#addNote').isDisabled());
    assert(result.requests.every(request=>request.startsWith('/dist/')||request==='/favicon.ico'));
    assert.deepEqual(result.errors,[]);
    pass('Missing clips fail clearly; no API, absolute asset paths or JavaScript errors');
  } finally {
    fs.writeFileSync(path.join(OUT,'verification.json'),JSON.stringify(result,null,2));
    if(browser)await browser.close();if(server)server.kill();
  }
})().catch(error=>{console.error(error);process.exitCode=1;});

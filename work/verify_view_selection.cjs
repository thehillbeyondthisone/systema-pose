const {chromium} = require('C:/Users/thefo/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname,'..');
const OUT = path.join(ROOT,'outputs','view-selection');
const BASE = process.env.SYSTEMA_TEST_URL || 'http://127.0.0.1:8772';
const result = {checkedAt:new Date().toISOString(),checks:[],pageErrors:[]};
fs.mkdirSync(OUT,{recursive:true});
let browser;
const pass = message => { result.checks.push(message); console.log('PASS '+message); };
async function load(page,url=BASE+'/?demo=1') {
  await page.goto(url,{waitUntil:'networkidle'});
  await page.waitForFunction(()=>document.getElementById('participants').children.length>0 && document.getElementById('video').readyState>=2);
  assert.equal(await page.locator('#videoError').isVisible(),false);
}
async function scrub(page,frame) {
  await page.locator('#scrub').evaluate((input,value)=>{input.value=String(value);input.dispatchEvent(new Event('input',{bubbles:true}));},frame);
  await page.waitForFunction(value=>!document.getElementById('video').seeking && Math.abs(document.getElementById('video').currentTime-value/30)<.01,frame);
}
async function noOverflow(page) {
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Horizontal page overflow');
}
async function dialogFits(page) {
  const box=await page.locator('#viewPicker').boundingBox();
  const viewport=page.viewportSize();
  assert(box.x>=-1 && box.y>=-1 && box.x+box.width<=viewport.width+1 && box.y+box.height<=viewport.height+1,'Dialog outside viewport');
  assert(await page.locator('#viewPicker').evaluate(el=>el.scrollWidth<=el.clientWidth+1),'Horizontal dialog overflow');
}
(async()=>{
  try {
    browser=await chromium.launch({channel:'msedge',headless:true});
    const context=await browser.newContext({viewport:{width:390,height:844},hasTouch:true,isMobile:true});
    const page=await context.newPage();
    page.on('pageerror',e=>result.pageErrors.push(e.message));
    await load(page);
    assert((await page.locator('body').innerText()).includes('Multiple attackers'));
    assert.equal(await page.locator('[data-preset="study"]').getAttribute('aria-pressed'),'true');
    assert.equal(await page.locator('#notesPanel').isVisible(),false);
    assert.equal(await page.locator('#annotationRail').isVisible(),false);
    await noOverflow(page);
    await page.screenshot({path:path.join(OUT,'phone-study.png'),fullPage:true});
    pass('Page loads with full-width study view, meaningful content, and no JavaScript errors');

    await scrub(page,234);
    const time=await page.locator('#video').evaluate(v=>v.currentTime);
    await page.locator('[data-preset="watch"]').click();
    assert.equal(await page.locator('#video').evaluate(v=>v.currentTime),time);
    assert.equal(await page.locator('#participantControls').isVisible(),false);
    assert.equal(await page.locator('#skeleton').evaluate(c=>c.getContext('2d').getImageData(0,0,c.width,c.height).data.some((v,i)=>i%4===3&&v>0)),false);
    await page.locator('[data-preset="study"]').click();
    assert.equal(await page.locator('#skeleton').evaluate(c=>c.getContext('2d').getImageData(0,0,c.width,c.height).data.some((v,i)=>i%4===3&&v>0)),true);
    await page.locator('[data-track-id="2"]').click();
    await page.locator('#chooseViews').click();
    await dialogFits(page);
    await page.screenshot({path:path.join(OUT,'phone-view-chooser.png')});
    await page.locator('input[name="movementView"][value="motion"]').check();
    await page.locator('#showMomentNotes').check();
    assert.equal(await page.locator('#notesPanel').isVisible(),false);
    await page.locator('#showAnnotationList').check();
    await page.locator('#doneViews').click();
    assert.equal(await page.locator('#chooseViews').evaluate(el=>el===document.activeElement),true);
    assert.equal(await page.locator('#stage').evaluate(el=>el.classList.contains('motion')),true);
    assert.equal(await page.locator('#video').evaluate(v=>v.currentTime),time);
    assert.equal(await page.locator('[data-track-id="2"]').getAttribute('aria-pressed'),'false');
    assert.equal(await page.locator('#notesPanel').isVisible(),true);
    assert.equal(await page.locator('#annotationRail').isVisible(),true);
    await page.locator('[data-track-id="2"]').click();
    assert(await page.locator('#annotationLines polyline').count()>0);
    await page.reload();await page.waitForFunction(()=>document.getElementById('participants').children.length>0);
    assert.equal(await page.locator('input[name="movementView"][value="motion"]').isChecked(),true);
    assert.equal(await page.locator('#notesPanel').isVisible(),true);
    assert.equal(await page.locator('#annotationRail').isVisible(),true);
    pass('Presets and independent panels preserve paused time and participant choices; custom views survive reload');

    await page.locator('#chooseViews').click();
    for(let i=0;i<12;i++){
      await page.keyboard.press('Tab');
      assert(await page.locator('#viewPicker').evaluate(el=>el.contains(document.activeElement)),'Focus escaped the modal');
    }
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#viewPicker').evaluate(el=>el.open),false);
    assert.equal(await page.locator('#chooseViews').evaluate(el=>el===document.activeElement),true);
    await page.locator('[data-preset="study"]').click();await page.locator('#play').click();
    await page.waitForFunction(()=>document.getElementById('video').currentTime>.1);
    await page.locator('[data-preset="watch"]').click();
    assert.equal(await page.locator('#video').evaluate(v=>v.paused),false);
    await page.locator('#play').click();
    pass('Modal traps keyboard focus, Escape restores focus, and changing presets keeps playing footage running');

    await page.locator('#addNote').click();
    assert.equal(await page.locator('#notesPanel').isVisible(),true);
    await page.locator('#noteTitle').fill('An unsaved observation');
    await page.locator('#noteText').fill('Keep this text while changing movement views.');
    await page.locator('#chooseViews').click();
    assert.equal(await page.locator('#showAnnotationList').isDisabled(),true);
    await page.locator('input[name="movementView"][value="motion"]').check();
    await page.locator('#doneViews').click();
    assert.equal(await page.locator('#noteTitle').inputValue(),'An unsaved observation');
    assert.equal(await page.locator('#noteEditor').isVisible(),true);
    assert.equal(await page.locator('[data-preset="watch"]').isDisabled(),true);
    await page.locator('#cancelEdit').click();
    assert.equal(await page.locator('[data-preset="watch"]').isDisabled(),false);
    pass('Adding an annotation opens its panels; changing the movement view preserves drafts and cannot hide the editor');

    for(const [width,height,label] of [[320,568,'small-phone'],[390,844,'phone'],[844,390,'phone-landscape'],[834,1194,'ipad-portrait'],[1024,768,'ipad-landscape'],[1440,960,'desktop']]){
      await page.setViewportSize({width,height});
      for(const preset of ['watch','study','annotate']){
        await page.locator(`[data-preset="${preset}"]`).click();
        await noOverflow(page);
        for(const button of await page.locator('[data-preset],#chooseViews').all()){
          const box=await button.boundingBox();assert(box.height>=44 && box.width>=44);
        }
      }
      await scrub(page,234);
      await page.screenshot({path:path.join(OUT,label+'-annotate.png'),fullPage:true});
      await page.locator('#chooseViews').click();await dialogFits(page);
      await page.screenshot({path:path.join(OUT,label+'-chooser.png')});
      await page.locator('#doneViews').click();
    }
    pass('Watch, Study, Annotate, and chooser fit six phone/tablet/desktop sizes with touch targets of at least 44px');

    await page.setViewportSize({width:390,height:844});await scrub(page,234);
    await page.locator('#chooseViews').click();await page.locator('#sceneLink').waitFor();await page.locator('#sceneLink').click();
    await page.waitForFunction(()=>document.getElementById('sceneStatus').classList.contains('ready'));
    await page.waitForFunction(()=>Math.abs(document.getElementById('sceneVideo').currentTime-7.8)<.01);
    if(!await page.locator('#contactDetails').evaluate(details=>details.open))await page.locator('#contactDetails summary').click();
    assert.equal(await page.locator('#contactEffects').isChecked(),false);
    await page.locator('#contactEffects').check();
    await page.locator('#sceneScrub').evaluate(input=>{input.value='36';input.dispatchEvent(new Event('input',{bubbles:true}));});
    await page.waitForFunction(()=>Number(document.getElementById('contactStatus').dataset.count)>0);
    const thinContacts=Number(await page.locator('#contactStatus').getAttribute('data-count'));
    await page.locator('[data-camera="side"]').click();
    assert.equal(Number(await page.locator('#contactStatus').getAttribute('data-count')),thinContacts);
    await page.locator('#boneThickness').selectOption('0.05');
    assert(Number(await page.locator('#contactStatus').getAttribute('data-count'))>=thinContacts);
    const peopleControls=await page.locator('#scenePeople input').all();
    for(const input of peopleControls.slice(1))await input.uncheck();
    assert.equal(await page.locator('#contactStatus').getAttribute('data-count'),'0');
    for(const input of peopleControls.slice(1))await input.check();
    await page.reload();await page.waitForFunction(()=>document.getElementById('sceneStatus').classList.contains('ready'));
    if(!await page.locator('#contactDetails').evaluate(details=>details.open))await page.locator('#contactDetails summary').click();
    assert.equal(await page.locator('#contactEffects').isChecked(),true);
    assert.equal(await page.locator('#boneThickness').inputValue(),'0.05');
    await page.locator('#boneThickness').selectOption('0.02');
    await page.locator('#sceneScrub').evaluate(input=>{input.value='36';input.dispatchEvent(new Event('input',{bubbles:true}));});
    await page.setViewportSize({width:1440,height:960});await page.locator('[data-scene-view="compare"]').click();
    await page.locator('[data-camera="front"]').click();
    await page.waitForFunction(()=>document.getElementById('sceneVideo').readyState>=2&&!document.getElementById('sceneVideo').seeking);
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    await page.screenshot({path:path.join(OUT,'3d-contact-effects.png'),fullPage:true});
    await page.locator('#contactEffects').uncheck();
    assert.equal(await page.locator('#contactStatus').getAttribute('data-count'),'0');
    await page.locator('#contactEffects').check();
    await page.locator('#sceneScrub').evaluate(input=>{input.value='234';input.dispatchEvent(new Event('input',{bubbles:true}));});
    await page.waitForFunction(()=>!document.getElementById('sceneVideo').seeking&&Math.abs(document.getElementById('sceneVideo').currentTime-7.8)<.01);
    await page.setViewportSize({width:390,height:844});await page.locator('[data-scene-view="scene"]').click();
    pass('3D intersections use visible participants, preserve counts across camera changes, follow thickness and frame changes, and save preferences');
    assert.equal(await page.locator('#sceneFootagePanel').isVisible(),false);
    await page.locator('[data-scene-view="video"]').click();
    await page.waitForFunction(()=>document.getElementById('sceneVideo').readyState>=2&&!document.getElementById('sceneVideo').seeking);
    assert(await page.locator('#sceneVideo').evaluate(video=>{
      const canvas=document.createElement('canvas');canvas.width=64;canvas.height=36;
      const ctx=canvas.getContext('2d');ctx.drawImage(video,0,0,64,36);
      return ctx.getImageData(0,0,64,36).data.some((value,index)=>index%4!==3&&value>100);
    }),'Source footage did not decode when its panel was shown');
    await page.locator('[data-scene-view="scene"]').click();
    for(const [width,height,label] of [[390,844,'phone'],[844,390,'phone-landscape'],[834,1194,'ipad-portrait'],[1024,768,'ipad-landscape'],[1440,960,'desktop']]){
      await page.setViewportSize({width,height});
      for(const view of ['scene','video','compare']){
        await page.locator(`[data-scene-view="${view}"]`).click();await noOverflow(page);
        assert.equal(await page.locator('#sceneVideo').evaluate(v=>v.currentTime),7.8);
      }
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      await page.screenshot({path:path.join(OUT,label+'-3d-compare.png'),fullPage:true});
    }
    await page.locator('[data-scene-view="scene"]').click();
    await page.locator('[data-camera="overhead"]').click();
    assert.equal(await page.locator('[data-camera="overhead"]').getAttribute('aria-pressed'),'true');
    await page.locator('#scenePlay').click();
    await page.waitForFunction(()=>document.getElementById('sceneVideo').currentTime>7.9);
    await page.locator('#scenePlay').click();
    await page.locator('#sceneNext').click();
    const sceneFrame=Number(await page.locator('#sceneScrub').inputValue());
    await page.getByRole('link',{name:'Back to lesson'}).click();await page.waitForFunction(()=>document.getElementById('participants').children.length>0);
    await page.waitForFunction(value=>Math.abs(document.getElementById('video').currentTime-value/30)<.01,sceneFrame);
    pass('3D/footage/compare layouts, camera selection, hidden-footage playback, and return to the same source frame work');

    const blocked=await browser.newContext({viewport:{width:390,height:844}});
    await blocked.addInitScript(()=>{
      Storage.prototype.getItem=()=>{throw new DOMException('Storage blocked','SecurityError');};
      Storage.prototype.setItem=()=>{throw new DOMException('Storage blocked','SecurityError');};
    });
    const fallback=await blocked.newPage();fallback.on('pageerror',e=>result.pageErrors.push(e.message));
    await load(fallback);await fallback.locator('[data-preset="watch"]').click();await fallback.locator('#chooseViews').click();await fallback.locator('input[value="motion"]').check();
    assert.equal(await fallback.locator('#stage').evaluate(el=>el.classList.contains('motion')),true);
    await blocked.close();
    await page.addInitScript(()=>localStorage.setItem('systema-workspace-views-v1','{"visual":"unknown","moment":"no","list":null}'));
    await load(page);assert.equal(await page.locator('[data-preset="study"]').getAttribute('aria-pressed'),'true');
    pass('Unavailable browser storage and malformed saved choices fall back without breaking view selection');
    assert.deepEqual(result.pageErrors,[]);
    fs.writeFileSync(path.join(OUT,'validation.json'),JSON.stringify(result,null,2));
  } finally { if(browser)await browser.close(); }
})().catch(e=>{console.error(e);process.exitCode=1;});

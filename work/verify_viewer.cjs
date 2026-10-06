const fs = require('fs');
const path = require('path');
const { chromium } = require('C:/Users/thefo/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
(async () => {
  const root = path.resolve(__dirname, '..');
  const errors = [];
  const browser = await chromium.launch({channel:'msedge',headless:true});
  const page = await browser.newPage({viewport:{width:1500,height:1080}});
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('http://127.0.0.1:8766', {waitUntil:'networkidle'});
  await page.locator('#source').evaluate(v => v.readyState >= 2 || new Promise(r => v.addEventListener('loadeddata',r,{once:true})));
  await page.getByRole('button',{name:'Frame →',exact:true}).click();
  if (!((await page.locator('#time').innerText()).includes('frame 541'))) throw Error('Frame stepping failed');
  await page.getByLabel('Grey shirt',{exact:false}).uncheck();
  await page.getByLabel('Blue shirt',{exact:false}).uncheck();
  await page.getByLabel('White shirt',{exact:false}).uncheck();
  const alpha = await page.locator('#illustration').evaluate(c => {
    const data=c.getContext('2d').getImageData(0,0,c.width,c.height).data;
    let zero=0,visible=0;for(let i=3;i<data.length;i+=4){if(data[i]===0)zero++;else visible++}
    return {zero,visible};
  });
  if(!alpha.zero || !alpha.visible)throw Error('Illustration alpha failed');
  await page.getByRole('button',{name:'Play',exact:true}).click();
  await page.waitForFunction(()=>document.getElementById('source').currentTime>.2);
  await page.getByRole('button',{name:'Pause',exact:true}).click();
  await page.getByRole('button',{name:'Reset',exact:true}).click();
  for(const name of ['Grey shirt','Blue shirt','White shirt'])await page.getByLabel(name,{exact:false}).check();
  const downloadPromise=page.waitForEvent('download');
  await page.getByRole('button',{name:'Save transparent pose PNG'}).click();
  const download=await downloadPromise;
  await download.saveAs(path.join(root,'work','viewer-export-check.png'));
  await page.screenshot({path:path.join(root,'outputs','pilot','viewer-preview.png'),fullPage:true});
  const result={page_errors:errors,frame_stepping:true,participant_selection:true,playback:true,transparent_export:true,illustration_alpha:alpha};
  if(errors.length)throw Error(errors.join('\n'));
  fs.writeFileSync(path.join(root,'outputs','pilot','viewer-validation.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify(result,null,2));
  await browser.close();
})().catch(e=>{console.error(e);process.exit(1)});

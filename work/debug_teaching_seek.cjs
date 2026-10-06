const {chromium} = require('C:/Users/thefo/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
(async()=>{
 const b=await chromium.launch({channel:'msedge',headless:true});const p=await b.newPage();
 p.on('console',m=>console.log(m.type(),m.text()));p.on('pageerror',e=>console.log('ERROR',e.message));
 await p.goto('http://127.0.0.1:8770/',{waitUntil:'networkidle'});
 await p.waitForFunction(()=>document.getElementById('video').readyState>=2);
 console.log('before',await p.locator('#video').evaluate(v=>({time:v.currentTime,ready:v.readyState,buffer:Array.from({length:v.buffered.length},(_,i)=>[v.buffered.start(i),v.buffered.end(i)]),seekable:Array.from({length:v.seekable.length},(_,i)=>[v.seekable.start(i),v.seekable.end(i)])})));
 console.log('input',await p.locator('#scrub').evaluate(el=>{el.value='234';el.dispatchEvent(new Event('input',{bubbles:true}));return{value:el.value,time:document.getElementById('video').currentTime,text:document.getElementById('currentTime').textContent};}));
 await p.waitForTimeout(1000);
 console.log('after',await p.locator('#video').evaluate(v=>({time:v.currentTime,ready:v.readyState,error:v.error?.message,seeking:v.seeking,paused:v.paused})));
 await p.screenshot({path:'outputs/teaching-suite/seek-debug.png',fullPage:true});
 await b.close();
})().catch(e=>{console.error(e);process.exitCode=1});

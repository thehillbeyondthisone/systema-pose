const $=id=>document.getElementById(id);
let state=null,selected=null,editorId=null,lastState='',pending=false,activePassage=0,lastJobNotice='',previewShown='';
const element=(tag,text,className='')=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(className)node.className=className;return node;};
function message(text,error=false){$('adminStatus').textContent=text;$('adminStatus').dataset.error=String(error);}
async function api(path,body){
  const response=await fetch('/api/admin/'+path,{method:'POST',headers:{'Content-Type':'application/json','X-Systema-Admin-Token':state.token},body:JSON.stringify(body)});
  const value=await response.json();if(!response.ok)throw Error(value.error||'The action could not be completed.');return value;
}
async function action(callback){try{pending=true;controls();await callback();await refresh();}catch(error){message(error.message,true);}finally{pending=false;controls();}}
const current=()=>state?.lessons.find(lesson=>lesson.id===selected);
function controls(){
  const lesson=current(),working=state?.jobs.some(job=>job.status==='running'),locked=lesson&&['queued','processing','ready'].includes(lesson.status);
  $('prepareVideo').disabled=pending||!lesson||locked||!state?.processingAvailable;
  const slug=$('adminSlug').value,ids=lesson?.segments?.map((_,index)=>lesson.segments.length===1?slug:`${slug}-${String(index+1).padStart(2,'0')}`)||[];
  $('stageVideo').disabled=pending||working||lesson?.status!=='ready'||!$('reviewedMotion').checked||state?.clips.some(clip=>ids.includes(clip.id));
  $('addPassage').disabled=!lesson||locked;for(const input of $('adminPassages').querySelectorAll('input,button'))input.disabled=locked;
  $('buildPreview').disabled=pending||working||!state;$('publishVideos').disabled=pending||working||!state?.staged.length||!state?.preview||!$('reviewedPreview').checked;
}
function passageRow(segment){
  const row=element('div',undefined,'admin-passage');
  for(const [name,label,type,value] of [['start','Start (s)','number',segment.start],['end','End (s)','number',segment.end],['label','Label','text',segment.label||'']]){
    const wrapper=element('label',label),input=element('input');input.type=type;input.dataset.field=name;input.value=value;
    if(type==='number'){input.min='0';input.max=String(current().sourceEnd);input.step='.033333';}else input.maxLength=80;
    input.addEventListener('focus',()=>activePassage=[...$('adminPassages').children].indexOf(row));wrapper.append(input);row.append(wrapper);
  }
  const remove=element('button','Remove');remove.type='button';remove.addEventListener('click',()=>row.remove());row.append(remove);$('adminPassages').append(row);
}
function loadEditor(){
  const lesson=current();$('editorEmpty').hidden=Boolean(lesson);$('editorContent').hidden=!lesson;if(!lesson)return;
  if(editorId!==lesson.id){
    editorId=lesson.id;$('adminTitle').value=lesson.title;$('adminSlug').value=lesson.title.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,64);
    $('adminDescription').value='';$('adminTags').value='';$('reviewedMotion').checked=false;$('adminPreviewVideo').src=lesson.video;
    $('adminPassages').replaceChildren();for(const segment of lesson.segments?.length?lesson.segments:[{start:0,end:Math.min(12,lesson.sourceEnd),label:''}])passageRow(segment);
  }
  $('lessonState').textContent=lesson.status;$('prepareStatus').textContent=lesson.message||'';
  $('reviewMotion').hidden=lesson.status!=='ready';$('reviewMotion').href='/?project='+lesson.id;
}
function render(){
  $('adminLessons').replaceChildren();
  for(const lesson of state.lessons){const button=element('button',undefined,lesson.id===selected?'active':'');button.append(element('strong',lesson.title),element('small',`${lesson.status}${lesson.status==='processing'?' · '+lesson.progress+'%':''}`));button.addEventListener('click',()=>{selected=lesson.id;loadEditor();render();});$('adminLessons').append(button);}
  if(!state.lessons.length)$('adminLessons').append(element('p','No source videos imported yet.','helper'));
  loadEditor();$('stagedCount').textContent=state.staged.length+' staged';$('publicCount').textContent=state.clips.length+' clips in catalog';$('stagedClips').replaceChildren();
  const preview=state.preview?.id||'';if(preview!==previewShown){$('reviewedPreview').checked=false;previewShown=preview;}
  for(const clip of state.clips.filter(clip=>state.staged.includes(clip.id))){
    const card=element('article');card.dataset.clipId=clip.id;card.append(element('h3',clip.title),element('p',clip.scene?'2D + matching 3D scene':'2D prepared · 3D optional'));
    const details=element('details'),summary=element('summary','Attach reviewed 3D scene');details.append(summary,element('p','Run the GPU reconstruction on this exported video. Its scene must match the hash and passage timing.'));
    const video=element('a','Download processing video');video.href=`/admin-assets/${clip.id}/source.mp4`;video.download=clip.id+'.mp4';details.append(video,element('code',clip.sourceSha256||''));
    const label=element('label','Scene JSON'),input=element('input');input.type='file';input.accept='.json,application/json';input.dataset.sceneClip=clip.id;
    input.addEventListener('change',()=>action(async()=>{const file=input.files[0];if(!file)return;if(file.size>50*1024*1024)throw Error('Choose a scene JSON under 50 MB.');const result=await api(`clips/${clip.id}/scene`,JSON.parse(await file.text()));$('reviewedPreview').checked=false;message(result.message);}));
    label.append(input);details.append(label);card.append(details);
    const unstage=element('button','Unstage');unstage.addEventListener('click',()=>action(async()=>message((await api('unstage',{clipId:clip.id})).message)));card.append(unstage);$('stagedClips').append(card);
  }
  if(!state.staged.length)$('stagedClips').append(element('p','No new clips staged. Prepare and review a video above.','helper'));
  $('openPreview').hidden=!state.preview;$('openPreview').href=state.preview?.url||'#';
  $('adminJobs').replaceChildren();for(const job of [...state.jobs].reverse()){
    const item=element('li',`${job.kind} · ${job.status} — ${job.message}`);item.dataset.state=job.status;item.dataset.jobId=job.id;$('adminJobs').append(item);
  }
  if(!state.jobs.length)$('adminJobs').append(element('li','Preparation and publishing progress will appear here.'));
  const latest=state.jobs.at(-1);if(latest&&latest.status!=='running'&&latest.id+latest.status!==lastJobNotice){lastJobNotice=latest.id+latest.status;message(latest.message,latest.status==='failed');}
  controls();
}
async function refresh(){
  const response=await fetch('/api/admin/state',{cache:'no-store'}),value=await response.json();if(!response.ok)throw Error(value.error||'Could not open the local admin dashboard.');
  state=value;if(!selected&&state.lessons.length)selected=state.lessons[0].id;
  const signature=JSON.stringify(value);if(signature!==lastState){lastState=signature;render();}
}
$('importForm').addEventListener('submit',event=>{event.preventDefault();action(async()=>{
  const file=$('adminVideo').files[0];if(!file)return;if(file.size>500*1024*1024)throw Error('Choose a video under 500 MB.');
  $('importVideo').disabled=true;$('importProgress').hidden=false;$('importStatus').textContent='Importing video…';
  try{
    const lesson=await new Promise((resolve,reject)=>{const request=new XMLHttpRequest();request.open('POST','/api/admin/upload');request.setRequestHeader('X-Systema-Admin-Token',state.token);request.setRequestHeader('X-File-Name',encodeURIComponent(file.name));request.setRequestHeader('Content-Type','application/octet-stream');
      request.upload.onprogress=event=>{if(event.lengthComputable){$('importProgress').value=event.loaded/event.total*100;$('importStatus').textContent=event.loaded===event.total?'Preparing browser playback…':'Importing video…';}};
      request.onerror=()=>reject(Error('The local upload connection was interrupted.'));request.onload=()=>{try{const result=JSON.parse(request.responseText);request.status<300?resolve(result):reject(Error(result.error));}catch(error){reject(error);}};request.send(file);});
    selected=lesson.id;editorId=null;$('adminVideo').value='';$('importStatus').textContent='Video imported. Choose the passages to prepare.';message('Video ready for passage selection.');
  }finally{$('importVideo').disabled=false;$('importProgress').hidden=true;}
});});
$('prepareVideo').addEventListener('click',()=>action(async()=>{
  const segments=[...$('adminPassages').children].map(row=>Object.fromEntries([...row.querySelectorAll('input')].map(input=>[input.dataset.field,input.type==='number'?Number(input.value):input.value])));
  await api('prepare',{lessonId:selected,title:$('adminTitle').value,segments});message('Queued for local 2D motion preparation. Progress appears below.');
}));
$('addPassage').addEventListener('click',()=>{const rows=[...$('adminPassages').children];if(rows.length>=12){message('Choose up to 12 passages.',true);return;}const start=rows.length?Number(rows.at(-1).querySelector('[data-field=end]').value):0;passageRow({start,end:Math.min(start+10,current().sourceEnd),label:''});});
for(const [id,field] of [['markStart','start'],['markEnd','end']])$(id).addEventListener('click',()=>{if(['queued','processing','ready'].includes(current()?.status))return;const row=$('adminPassages').children[activePassage]||$('adminPassages').firstElementChild;if(row)row.querySelector(`[data-field=${field}]`).value=$('adminPreviewVideo').currentTime.toFixed(3);});
$('reviewedMotion').addEventListener('change',controls);$('reviewedPreview').addEventListener('change',controls);
$('adminSlug').addEventListener('input',controls);
$('stageVideo').addEventListener('click',()=>action(async()=>{await api('stage',{lessonId:selected,slug:$('adminSlug').value,title:$('adminTitle').value,description:$('adminDescription').value,category:$('adminCategory').value,tags:$('adminTags').value.split(','),reviewed:$('reviewedMotion').checked});$('reviewedPreview').checked=false;message('Exporting the reviewed passages. Original footage remains local.');}));
$('buildPreview').addEventListener('click',()=>action(async()=>{await api('preview',{});$('reviewedPreview').checked=false;message('Building a public viewer preview on this PC…');}));
$('publishVideos').addEventListener('click',()=>action(async()=>{await api('publish',{reviewed:$('reviewedPreview').checked});message('Publishing the reviewed release. Follow the activity log below.');}));
$('refreshAdmin').addEventListener('click',()=>refresh().catch(error=>message(error.message,true)));
async function poll(){try{await refresh();if($('adminStatus').textContent.startsWith('Connecting'))message('Local workstation connected. Import a video to begin.');}catch(error){message(error.message,true);}setTimeout(poll,1800);}poll();

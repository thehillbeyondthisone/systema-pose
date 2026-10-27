const $=id=>document.getElementById(id);
let state=null,selected=null,editorId=null,lastState='',pending=false,activePassage=0,lastJobNotice='',previewShown='',reviewClipId=null;
const cameraChoices=new Map(),reviewChecks=new Map(),reconstructionErrors=new Map();
const participantEditor=new ParticipantEditor({save:api,onSaved:async result=>{reviewChecks.clear();reconstructionErrors.clear();$('reviewedPreview').checked=false;await refresh();message(result.message||'Participant corrections saved. Reconstruct this passage to generate matching 3D.');}});
const element=(tag,text,className='')=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(className)node.className=className;return node;};
function message(text,error=false){$('adminStatus').textContent=text;$('adminStatus').dataset.error=String(error);}
async function api(path,body){
  const response=await fetch('/api/admin/'+path,{method:'POST',headers:{'Content-Type':'application/json','X-Systema-Admin-Token':state.token},body:JSON.stringify(body)});
  const value=await response.json();if(!response.ok)throw Error(value.error||'The action could not be completed.');return value;
}
async function action(callback,clipId=null){
  try{pending=true;if(clipId)reconstructionErrors.delete(clipId);controls();await callback();await refresh();}
  catch(error){
    if(clipId){
      reconstructionErrors.set(clipId,error.message);render();
      const notice=$('reconstruct-error-'+clipId);notice?.focus();notice?.scrollIntoView({behavior:'smooth',block:'nearest'});
    }
    message(error.message,true);
  }finally{pending=false;controls();}
}
const current=()=>state?.lessons.find(lesson=>lesson.id===selected);
function saveEditor(){
  if(!editorId)return;
  const draft={title:$('adminTitle').value,slug:$('adminSlug').value,description:$('adminDescription').value,tags:$('adminTags').value,category:$('adminCategory').value,
    segments:[...$('adminPassages').children].map(row=>Object.fromEntries([...row.querySelectorAll('input')].map(input=>[input.dataset.field,input.type==='number'?Number(input.value):input.value])))};
  try{localStorage.setItem('systema-admin-draft-v1:'+editorId,JSON.stringify(draft));}catch{}
}
function readEditor(id){try{return JSON.parse(localStorage.getItem('systema-admin-draft-v1:'+id))||{};}catch{return {};}}
function reconstructionBlocker(){
  if(pending)return 'Wait for the current action to finish.';
  if(state?.threeD.status==='checking')return 'Checking the workstation. Reconstruction will be available when the GPU check passes.';
  if(state?.jobs.some(job=>job.status==='running'))return 'Wait for the current workstation job to finish.';
  const runtime=state?.threeD;
  if(runtime?.gpuPaused)return 'GPU use is paused. Choose Enable & check GPU in Processing workstation above.';
  if(runtime?.ready)return '';
  if(runtime?.status==='installed')return 'GPU execution has not been checked. Choose Check GPU execution in Processing workstation above.';
  if(runtime?.status==='unchecked')return 'Choose Enable & check GPU in Processing workstation above before reconstructing.';
  return 'Resolve the requirements shown under Processing workstation, then check GPU execution again.';
}
function controls(){
  const lesson=current(),working=state?.jobs.some(job=>job.status==='running'),locked=lesson&&['queued','processing','ready'].includes(lesson.status);
  $('prepareVideo').disabled=pending||!lesson||locked||!state?.processingAvailable;
  $('deleteDraft').hidden=!lesson?.canDelete;$('deleteDraft').disabled=pending;
  const slug=$('adminSlug').value,ids=lesson?.segments?.map((_,index)=>lesson.segments.length===1?slug:`${slug}-${String(index+1).padStart(2,'0')}`)||[];
  $('stageVideo').disabled=pending||working||lesson?.status!=='ready'||!$('reviewedMotion').checked||state?.clips.some(clip=>ids.includes(clip.id));
  $('addPassage').disabled=!lesson||locked;for(const input of $('adminPassages').querySelectorAll('input,button'))input.disabled=locked;
  $('buildPreview').disabled=pending||working||!state;$('publishVideos').disabled=pending||working||!state?.staged.length||!state?.preview||!$('reviewedPreview').checked;
  const awaiting3d=state?.staged.some(id=>state.reconstructions?.[id]&&!state.reconstructions[id].reviewed);
  if(awaiting3d)$('publishVideos').disabled=true;
  $('checkRequirements').disabled=pending||working;
  $('enableGpu').disabled=pending||working;
  $('pauseGpu').disabled=pending;
  $('importRoom').disabled=pending||working;
  const reconstructionReason=reconstructionBlocker();
  for(const button of document.querySelectorAll('[data-reconstruct]')){button.disabled=Boolean(reconstructionReason);button.title=reconstructionReason;}
  for(const hint of document.querySelectorAll('[data-reconstruct-hint]')){hint.textContent=reconstructionReason;hint.hidden=!reconstructionReason;}
  for(const button of document.querySelectorAll('[data-edit-tracks]'))button.disabled=pending||working;
  for(const button of document.querySelectorAll('[data-approve3d]'))button.disabled=pending||working||!reviewChecks.get(button.dataset.approve3d);
}
function passageRow(segment){
  const row=element('div',undefined,'admin-passage');
  for(const [name,label,type,value] of [['start','Start (s)','number',segment.start],['end','End (s)','number',segment.end],['label','Label','text',segment.label||'']]){
    const wrapper=element('label',label),input=element('input');input.type=type;input.dataset.field=name;input.value=value;
    if(type==='number'){input.min='0';input.max=String(current().sourceEnd);input.step='.033333';}else input.maxLength=80;
    input.addEventListener('focus',()=>activePassage=[...$('adminPassages').children].indexOf(row));wrapper.append(input);row.append(wrapper);
  }
  const remove=element('button','Remove');remove.type='button';remove.addEventListener('click',()=>{row.remove();saveEditor();});row.append(remove);$('adminPassages').append(row);
}
function loadEditor(){
  const lesson=current();$('editorEmpty').hidden=Boolean(lesson);$('editorContent').hidden=!lesson;if(!lesson){editorId=null;return;}
  if(editorId!==lesson.id){
    const draft=readEditor(lesson.id);editorId=lesson.id;$('adminTitle').value=draft.title??lesson.title;$('adminSlug').value=draft.slug??lesson.title.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,64);
    $('adminDescription').value=draft.description||'';$('adminTags').value=draft.tags||'';$('adminCategory').value=['Training','Sparring','Fight'].includes(draft.category)?draft.category:'Training';$('reviewedMotion').checked=false;$('adminPreviewVideo').src=lesson.video;
    const locked=['queued','processing','ready'].includes(lesson.status),segments=locked?lesson.segments:draft.segments||lesson.segments;
    $('adminPassages').replaceChildren();for(const segment of Array.isArray(segments)&&segments.length?segments.slice(0,12):[{start:0,end:Math.min(12,lesson.sourceEnd),label:''}])passageRow(segment);
  }
  $('lessonState').textContent=lesson.status;$('prepareStatus').textContent=lesson.message||'';
  $('reviewMotion').hidden=lesson.status!=='ready';$('reviewMotion').href='/?project='+lesson.id;
}
function render(){
  const runtime=state.threeD,working=state.jobs.some(job=>job.status==='running');
  $('runtimeSummary').textContent=runtime.ready?`Ready · ${runtime.gpu||'CUDA GPU'} · checked ${new Date(runtime.checkedAt).toLocaleTimeString()}`:runtime.status==='installed'?'Installed requirements available · GPU validation deferred':runtime.status==='checking'?'Checking workstation requirements…':runtime.status==='unchecked'?'Requirements have not been checked yet.':'Setup needs attention. Open diagnostics below.';
  $('gpuMode').textContent=runtime.gpuPaused?'GPU paused · CPU preparation':'GPU enabled';$('gpuMode').dataset.state=runtime.gpuPaused?'paused':'ready';
  $('gpuModeHelp').textContent=runtime.gpuPaused?'Importing, editing and 2D tracking use the CPU. GPU tests and reconstruction are paused.':'GPU validation and reconstruction are enabled. Pause here when you need the GPU for other work.';
  $('enableGpu').hidden=runtime.ready;$('enableGpu').textContent=runtime.gpuPaused?'Enable & check GPU':'Check GPU execution';$('pauseGpu').hidden=runtime.gpuPaused;
  $('runtimeChecks').replaceChildren();for(const check of [...runtime.checks,...runtime.storage]){const row=element('li',`${check.ok===null?'○':check.ok?'✓':'!'} ${check.name}`);row.dataset.ok=check.ok===null?'deferred':String(check.ok);row.append(element('small',check.detail));$('runtimeChecks').append(row);}
  $('runtimeErrors').replaceChildren(...(runtime.errors||[]).map(error=>element('li',error)));
  $('adminLessons').replaceChildren();
  for(const lesson of state.lessons){const button=element('button',undefined,lesson.id===selected?'active':'');button.append(element('strong',lesson.title),element('small',`${lesson.status}${lesson.status==='processing'?' · '+lesson.progress+'%':''}`));button.addEventListener('click',()=>{saveEditor();selected=lesson.id;loadEditor();render();});$('adminLessons').append(button);}
  if(!state.lessons.length)$('adminLessons').append(element('p','No source videos imported yet.','helper'));
  $('roomLibrary').textContent=(state.rooms||[]).map(room=>`${room.title} · ${(room.bytes/1024/1024).toFixed(1)} MB`).join(' · ')||'No room scans imported yet.';
  loadEditor();$('stagedCount').textContent=state.staged.length+' staged';$('publicCount').textContent=state.clips.length+' clips in catalog';$('stagedClips').replaceChildren();
  const preview=state.preview?.id||'';if(preview!==previewShown){$('reviewedPreview').checked=false;previewShown=preview;}
  for(const clip of state.clips.filter(clip=>state.staged.includes(clip.id))){
    const reconstruction=state.reconstructions?.[clip.id],running=reconstruction?.status==='running';
    const card=element('article');card.dataset.clipId=clip.id;card.append(element('h3',clip.title),element('p',reconstruction?.message||(clip.scene?'2D + matching 3D scene':'2D ready · reconstruct this passage in 3D')));
    const editTracks=element('button','Choose participants & correct tracks');editTracks.dataset.editTracks=clip.id;editTracks.addEventListener('click',()=>participantEditor.open(clip));card.append(element('p',`${clip.people.length} participant${clip.people.length===1?'':'s'} selected for reconstruction`),editTracks);
    if(running){const progress=element('progress');progress.removeAttribute('value');progress.setAttribute('aria-label','3D reconstruction running');card.append(progress);}
    const cameraLabel=element('label','Camera movement','admin-camera'),camera=element('select');
    for(const [value,title] of [['moving','Estimate camera motion'],['static','Fixed camera (tripod)']]){const option=element('option',title);option.value=value;camera.append(option);}
    camera.value=cameraChoices.get(clip.id)||reconstruction?.camera||'moving';camera.disabled=running;camera.addEventListener('change',()=>cameraChoices.set(clip.id,camera.value));cameraLabel.append(camera);card.append(cameraLabel);
    const actions=element('div',undefined,'admin-actions'),start=element('button',reconstruction?'Reconstruct again':'Reconstruct 3D');start.dataset.reconstruct=clip.id;
    start.addEventListener('click',()=>action(async()=>{await api(`clips/${clip.id}/reconstruct`,{camera:camera.value});reviewChecks.delete(clip.id);$('reviewedPreview').checked=false;message('3D reconstruction started. Progress appears here; you can cancel and retry.');},clip.id));actions.append(start);
    if(running){const cancel=element('button','Cancel');cancel.addEventListener('click',()=>action(async()=>message((await api(`clips/${clip.id}/cancel`,{})).message)));actions.append(cancel);}
    const reconstructionHint=element('p',undefined,'helper');reconstructionHint.dataset.reconstructHint=clip.id;reconstructionHint.id='reconstruct-hint-'+clip.id;reconstructionHint.setAttribute('role','status');start.setAttribute('aria-describedby',reconstructionHint.id);
    card.append(actions,reconstructionHint);
    const reconstructionError=reconstructionErrors.get(clip.id)||(reconstruction?.status==='failed'?reconstruction.message:null);
    if(reconstructionError){
      const notice=element('div',undefined,'admin-reconstruction-error');notice.id='reconstruct-error-'+clip.id;notice.setAttribute('role','alert');notice.tabIndex=-1;
      notice.append(element('strong',reconstruction?.status==='failed'?'Reconstruction stopped':'Reconstruction could not start'),element('p',reconstructionError));
      if(reconstructionError.includes('tracked frames'))notice.append(element('p','Open Choose participants & correct tracks to exclude brief background detections or join fragments of the same person, then reconstruct again.'));
      card.append(notice);
    }
    const reviewUrl=(!reconstruction||reconstruction.status==='ready')?((clip.scene&&state.preview?state.preview.url+'scene.html?clip='+clip.id:null)||(!clip.environment&&reconstruction?.reviewUrl)):null;
    if(reviewUrl){const review=element('button','Review 3D scene');review.dataset.review3d=clip.id;review.addEventListener('click',()=>{reviewClipId=clip.id;$('sceneReview').hidden=false;$('sceneReviewTitle').textContent=clip.title;$('sceneReviewFrame').src=reviewUrl;$('sceneReview').scrollIntoView({behavior:'smooth',block:'start'});});card.append(review);}
    if(clip.scene&&(state.rooms||[]).length){
      const label=element('label','Room scan'),select=element('select');select.dataset.roomClip=clip.id;
      for(const room of state.rooms){const option=element('option',room.title);option.value=room.id;select.append(option);}label.append(select);card.append(label);
      const attach=element('button',clip.environment?'Replace room scan':'Attach room scan');attach.dataset.attachRoom=clip.id;attach.disabled=working;
      attach.addEventListener('click',()=>action(async()=>message((await api(`clips/${clip.id}/room`,{roomId:select.value})).message)));card.append(attach);
      if(clip.environment){const save=element('button','Save room placement from review');save.dataset.saveRoom=clip.id;save.disabled=working;
        save.addEventListener('click',()=>action(async()=>{
          if(reviewClipId!==clip.id||$('sceneReview').hidden)throw Error('Build a preview and open this passage’s 3D review first.');
          const frame=$('sceneReviewFrame').contentWindow,requestId=crypto.randomUUID();
          const record=await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>{window.removeEventListener('message',receive);reject(Error('The room has not loaded in this review. Reopen the latest preview.'));},10000);
            function receive(event){if(event.source!==frame||event.origin!==location.origin||event.data?.type!=='systema-room-placement'||event.data.requestId!==requestId)return;clearTimeout(timeout);window.removeEventListener('message',receive);resolve(event.data.record);}
            window.addEventListener('message',receive);frame.postMessage({type:'systema-room-placement-request',requestId},location.origin);
          });message((await api(`clips/${clip.id}/room-placement`,record)).message);
        }));card.append(save,element('p','Adjust the room under Studio alignment in the 3D review, then save its placement here. Room placement remains an estimate until calibrated.','helper'));
      }
    }
    if(reconstruction?.status==='ready'){
      const label=element('label',undefined,'admin-check'),checkbox=element('input');checkbox.type='checkbox';checkbox.dataset.reviewed3d=clip.id;
      checkbox.checked=reconstruction.reviewed||reviewChecks.get(clip.id)||false;checkbox.disabled=reconstruction.reviewed;
      checkbox.addEventListener('change',()=>{reviewChecks.set(clip.id,checkbox.checked);controls();});label.append(checkbox,document.createTextNode(reconstruction.reviewed?'3D motion reviewed':'I compared the 3D motion and identities with the source.'));card.append(label);
      if(!reconstruction.reviewed){const approve=element('button','Save 3D review');approve.dataset.approve3d=clip.id;approve.addEventListener('click',()=>action(async()=>message((await api(`clips/${clip.id}/review`,{runId:reconstruction.runId,reviewed:checkbox.checked})).message)));card.append(approve);}
    }
    if(reconstruction){const log=element('button','View run log');log.addEventListener('click',()=>action(async()=>{const response=await fetch(`/api/admin/clips/${clip.id}/reconstruction/log`),value=await response.json();if(!response.ok)throw Error(value.error);$('runLogText').textContent=value.text;$('runLog').hidden=false;$('runLog').open=true;}));card.append(log);}
    const details=element('details'),summary=element('summary','Advanced: import an existing scene');details.append(summary,element('p','Optional: use a scene reconstructed from this exact exported video.'));
    const video=element('a','Download processing video');video.href=`/admin-assets/${clip.id}/source.mp4`;video.download=clip.id+'.mp4';details.append(video,element('code',clip.sourceSha256||''));
    const label=element('label','Scene JSON'),input=element('input');input.type='file';input.accept='.json,application/json';input.dataset.sceneClip=clip.id;
    input.addEventListener('change',()=>action(async()=>{const file=input.files[0];if(!file)return;if(file.size>50*1024*1024)throw Error('Choose a scene JSON under 50 MB.');const result=await api(`clips/${clip.id}/scene`,JSON.parse(await file.text()));$('reviewedPreview').checked=false;message(result.message);}));
    label.append(input);details.append(label);card.append(details);
    const unstage=element('button','Unstage');unstage.disabled=working;unstage.addEventListener('click',()=>action(async()=>message((await api('unstage',{clipId:clip.id})).message)));card.append(unstage);$('stagedClips').append(card);
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
  state=value;if(!state.lessons.some(lesson=>lesson.id===selected))selected=state.lessons[0]?.id||null;
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
$('deleteDraft').addEventListener('click',()=>{
  const lesson=current();if(!lesson?.canDelete)return;
  const title=$('adminTitle').value.trim()||lesson.title;
  if(!window.confirm(`Delete “${title}”? This removes the draft, its saved edits and its uploaded video copy from this PC.`))return;
  action(async()=>{
    const video=$('adminPreviewVideo');video.pause();video.removeAttribute('src');video.load();
    try{
      const result=await api('drafts/delete',{lessonId:lesson.id});
      try{localStorage.removeItem('systema-admin-draft-v1:'+lesson.id);}catch{}
      selected=null;editorId=null;message(result.message);
    }catch(error){video.src=lesson.video;throw error;}
  });
});
$('addPassage').addEventListener('click',()=>{const rows=[...$('adminPassages').children];if(rows.length>=12){message('Choose up to 12 passages.',true);return;}const start=rows.length?Number(rows.at(-1).querySelector('[data-field=end]').value):0;passageRow({start,end:Math.min(start+10,current().sourceEnd),label:''});saveEditor();});
for(const [id,field] of [['markStart','start'],['markEnd','end']])$(id).addEventListener('click',()=>{if(['queued','processing','ready'].includes(current()?.status))return;const row=$('adminPassages').children[activePassage]||$('adminPassages').firstElementChild;if(row){row.querySelector(`[data-field=${field}]`).value=$('adminPreviewVideo').currentTime.toFixed(3);saveEditor();}});
for(const id of ['adminTitle','adminSlug','adminDescription','adminTags','adminCategory','adminPassages'])for(const event of ['input','change'])$(id).addEventListener(event,saveEditor);
$('reviewedMotion').addEventListener('change',controls);$('reviewedPreview').addEventListener('change',controls);
$('adminSlug').addEventListener('input',controls);
$('stageVideo').addEventListener('click',()=>action(async()=>{await api('stage',{lessonId:selected,slug:$('adminSlug').value,title:$('adminTitle').value,description:$('adminDescription').value,category:$('adminCategory').value,tags:$('adminTags').value.split(','),reviewed:$('reviewedMotion').checked});$('reviewedPreview').checked=false;message('Exporting the reviewed passages. Original footage remains local.');}));
$('buildPreview').addEventListener('click',()=>action(async()=>{await api('preview',{});$('reviewedPreview').checked=false;message('Building a public viewer preview on this PC…');}));
$('publishVideos').addEventListener('click',()=>action(async()=>{await api('publish',{reviewed:$('reviewedPreview').checked});message('Publishing the reviewed release. Follow the activity log below.');}));
$('refreshAdmin').addEventListener('click',()=>refresh().catch(error=>message(error.message,true)));
$('checkRequirements').addEventListener('click',()=>action(async()=>{await api('requirements',{});message('Checking the installed 3D workstation…');}));
$('enableGpu').addEventListener('click',()=>action(async()=>{await api('requirements',{gpu:true});message('GPU enabled. Checking CUDA and body models…');}));
$('roomForm').addEventListener('submit',event=>{event.preventDefault();action(async()=>{await api('rooms/import',{path:$('roomPath').value,title:$('roomTitle').value,upAxis:$('roomUpAxis').value});message('Importing the room scan on the CPU…');});});
$('pauseGpu').addEventListener('click',()=>action(async()=>message((await api('gpu/pause',{})).message)));
$('closeSceneReview').addEventListener('click',()=>{$('sceneReview').hidden=true;$('sceneReviewFrame').removeAttribute('src');});
async function poll(){try{await refresh();if($('adminStatus').textContent.startsWith('Connecting'))message('Local workstation connected. Import a video to begin.');}catch(error){message(error.message,true);}setTimeout(poll,1800);}poll();

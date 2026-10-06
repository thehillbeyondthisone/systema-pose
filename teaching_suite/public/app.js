'use strict';

(() => {
  const $ = id => document.getElementById(id);
  const query = new URLSearchParams(location.search);
  const snapshotId = query.get('lesson');
  const projectId = query.get('project');
  const api = path => path + (projectId ? '?project=' + encodeURIComponent(projectId) : snapshotId ? '?lesson=' + encodeURIComponent(snapshotId) : '');
  const people = [null,
    {name: 'Instructor', color: '#ffc044'},
    {name: 'Grey shirt', color: '#4ad4ff'},
    {name: 'Blue shirt', color: '#ea69e6'},
    {name: 'White shirt', color: '#7cea91'}];
  const joints = ['Nose', 'Left eye', 'Right eye', 'Left ear', 'Right ear',
    'Left shoulder', 'Right shoulder', 'Left elbow', 'Right elbow', 'Left wrist',
    'Right wrist', 'Left hip', 'Right hip', 'Left knee', 'Right knee',
    'Left ankle', 'Right ankle', 'Left big toe', 'Left small toe', 'Left heel',
    'Right big toe', 'Right small toe', 'Right heel'];
  const edges = [[0,1],[0,2],[1,3],[2,4],[5,6],[5,7],[7,9],[6,8],[8,10],
    [5,11],[6,12],[11,12],[11,13],[13,15],[12,14],[14,16],
    [15,17],[17,18],[15,19],[16,20],[20,21],[16,22]];
  const video = $('video');
  const canvas = $('skeleton');
  const ctx = canvas.getContext('2d');
  const shown = new Set([1,2,3,4]);
  let motion, lesson, sharedNotes = [], ownNotes = [], selected = null, draft = null, frameIndex = 0;
  let frameMap = new Map(), frameCount = 360;
  let renderRequest = null;
  const viewStorageKey = 'systema-workspace-views-v1';
  const visualLabels = {video:'Footage', overlay:'Footage + motion', motion:'Motion only'};
  const presets = {
    watch: {visual:'video', moment:false, list:false},
    study: {visual:'overlay', moment:false, list:false},
    annotate: {visual:'overlay', moment:true, list:true}
  };
  let views = {...presets.study};
  try {
    const saved = JSON.parse(localStorage.getItem(viewStorageKey));
    if (saved && Object.hasOwn(visualLabels,saved.visual) && typeof saved.moment === 'boolean' && typeof saved.list === 'boolean') {
      views = {visual:saved.visual, moment:saved.moment, list:saved.list};
    }
  } catch { /* View selection still works when browser storage is unavailable. */ }
  const sharedAudioBase = snapshotId ? `/published/${encodeURIComponent(snapshotId)}/audio/` : '/audio/';
  const audioBase = '/student-audio/';
  let audioBlob = null, audioName = null, previewUrl = null;
  let recorder = null, micStream = null, recordTimer = null, recordingPending = false;
  let toastTimer, saving = false, annotationSignature = '';
  const audioUrl = note => (note.personal ? audioBase : sharedAudioBase) + encodeURIComponent(note.audio);
  function mergeNotes(notes) {
    ownNotes = notes.map(note => ({...note, personal:true}));
    lesson.notes = [...sharedNotes, ...ownNotes].sort((a,b) => a.start-b.start || a.id.localeCompare(b.id));
    annotationSignature = '';
  }

  function toast(message) {
    $('toast').textContent = message;
    $('toast').hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { $('toast').hidden = true; }, 5500);
  }
  function applyViews(next = views) {
    views = {...next, list: draft ? true : next.list};
    $('workspace').dataset.visual = views.visual;
    $('stage').classList.toggle('motion',views.visual === 'motion');
    $('movementView').classList.toggle('without-moment-notes',!views.moment);
    $('annotationRail').hidden = !views.moment;
    $('annotationLines').hidden = !views.moment;
    $('notesPanel').hidden = !views.list;
    $('workspaceGrid').classList.toggle('notes-hidden',!views.list);
    $('participantControls').hidden = views.visual === 'video';
    $('contextLabel').textContent = visualLabels[views.visual];
    document.querySelectorAll('[data-preset]').forEach(button => {
      const preset = presets[button.dataset.preset];
      const active = Object.keys(preset).every(key => preset[key] === views[key]);
      button.classList.toggle('active',active);
      button.setAttribute('aria-pressed',String(active));
      button.disabled = Boolean(draft) && button.dataset.preset !== 'annotate';
    });
    document.querySelectorAll('input[name="movementView"]').forEach(input => { input.checked = input.value === views.visual; });
    $('showMomentNotes').checked = views.moment;
    $('showAnnotationList').checked = views.list;
    $('showAnnotationList').disabled = Boolean(draft);
    $('viewDraftHint').hidden = !draft;
    const panels = [views.moment && 'moment notes', views.list && 'annotation list'].filter(Boolean);
    $('viewSummary').textContent = [visualLabels[views.visual], ...panels].join(' · ');
    try { localStorage.setItem(viewStorageKey,JSON.stringify(views)); } catch {}
    render();
  }
  function closeViews() { $('viewPicker').close(); }
  async function json(url, options) {
    const response = await fetch(url, options);
    const value = await response.json();
    if (!response.ok) throw new Error(value.error || 'The lesson could not load.');
    return value;
  }
  function post(url, value) {
    return json(url, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(value)});
  }
  const seconds = value => `${Number(value).toFixed(2)}s`;
  const sourceTime = () => motion.sourceStart + video.currentTime;
  const currentFrame = () => frameMap.get(frameIndex) || {people:[]};
  const noteTarget = note => note.trackId ? `${people[note.trackId].name}${note.jointIndex === null ? '' : ' · ' + joints[note.jointIndex].toLowerCase()}` : 'Scene';
  function validPoint(person, joint) {
    // Model scores are uncalibrated; this only suppresses the weakest estimates.
    return person && person.confidence[joint] >= .35 && person.xy[joint]?.every(Number.isFinite);
  }
  function markerPosition(note) {
    if (!note.trackId) return note.anchor;
    if (!shown.has(note.trackId)) return null;
    const person = currentFrame().people.find(p => p.id === note.trackId);
    if (!person) return null;
    if (note.jointIndex !== null) {
      if (!validPoint(person, note.jointIndex)) return null;
      const [x,y] = person.xy[note.jointIndex];
      if (x < 0 || y < 0 || x > motion.width || y > motion.height) return null;
      return {x: x / motion.width, y: y / motion.height};
    }
    return {x: (person.bbox[0] + person.bbox[2]) / (2 * motion.width),
      y: (person.bbox[1] + person.bbox[3]) / (2 * motion.height)};
  }
  function drawSkeleton() {
    ctx.clearRect(0,0,canvas.width,canvas.height);
    if (views.visual === 'video') return;
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (const person of currentFrame().people) {
      if (!shown.has(person.id)) continue;
      const color = people[person.id].color;
      for (const [a,b] of edges) {
        if (!validPoint(person,a) || !validPoint(person,b)) continue;
        ctx.beginPath(); ctx.moveTo(...person.xy[a]); ctx.lineTo(...person.xy[b]);
        ctx.strokeStyle = '#07101bd0'; ctx.lineWidth = 13; ctx.stroke();
        ctx.strokeStyle = color; ctx.lineWidth = 7; ctx.stroke();
      }
      for (let i = 0; i < 23; i++) {
        if (!validPoint(person,i)) continue;
        ctx.beginPath(); ctx.arc(...person.xy[i],i < 5 ? 4 : 7,0,Math.PI*2);
        ctx.fillStyle = color; ctx.fill(); ctx.strokeStyle = '#07101b'; ctx.lineWidth = 2; ctx.stroke();
      }
    }
  }
  function renderAnnotations() {
    if (!views.moment) { $('annotationLines').replaceChildren(); return; }
    const time = sourceTime();
    const pending = draft ? {...draft, id:'draft-preview', title:$('noteTitle').value || 'Your annotation',
      text:$('noteText').value || 'Tap the part this belongs to.', start:Number($('noteStart').value), end:Number($('noteEnd').value)} : null;
    const active = (pending ? [pending] : lesson.notes).filter(note => time >= note.start && time < note.end)
      .sort((a,b) => Number(Boolean(b.personal))-Number(Boolean(a.personal)));
    $('annotationRail').classList.toggle('compact',active.length>2);
    const signature = JSON.stringify(active.map(note => [note.id,note.title,note.text,note.start,note.end,note.audio]));
    if (signature !== annotationSignature) {
      annotationSignature = signature; $('activeAnnotations').replaceChildren();
      active.forEach(note => {
        const card = document.createElement(pending ? 'div' : 'button');
        card.className = 'annotation-callout'; card.dataset.noteId = note.id;
        if (!pending) { card.type = 'button'; card.addEventListener('click',() => openNote(note)); }
        const title = document.createElement('strong'); title.textContent = note.title;
        const text = document.createElement('span'); text.className = 'callout-text'; text.textContent = note.text || '♪ Voice annotation';
        const target = document.createElement('span'); target.className = 'callout-target';
        card.append(title,text,target); $('activeAnnotations').append(card);
      });
      if (!active.length) {
        const empty = document.createElement('p'); empty.className = 'rail-empty';
        empty.textContent = 'Annotations appear here during their passage.'; $('activeAnnotations').append(empty);
      }
    }
    const svg = $('annotationLines'); svg.replaceChildren();
    const view = $('movementView').getBoundingClientRect(), stage = $('stage').getBoundingClientRect();
    const rail = $('annotationRail').getBoundingClientRect();
    svg.setAttribute('viewBox',`0 0 ${view.width} ${view.height}`);
    active.forEach((note,index) => {
      const card = $('activeAnnotations').children[index], box = card.getBoundingClientRect();
      card.classList.toggle('active',selected?.id === note.id);
      const position = markerPosition(note);
      card.querySelector('.callout-target').textContent = position ? noteTarget(note) : `${noteTarget(note)} · target unavailable`;
      if (!position || video.seeking || box.bottom <= rail.top || box.top >= rail.bottom) return;
      const x = stage.left-view.left+position.x*stage.width, y = stage.top-view.top+position.y*stage.height;
      const line = document.createElementNS('http://www.w3.org/2000/svg','polyline');
      line.dataset.noteId = note.id;
      const endY = Math.max(rail.top+3,Math.min(rail.bottom-3,box.top+Math.min(box.height/2,30)))-view.top;
      line.setAttribute('points',`${x},${y} ${stage.right-view.left+6},${y} ${box.left-view.left},${endY}`);
      svg.append(line);
      const dot = document.createElementNS('http://www.w3.org/2000/svg','circle');
      dot.setAttribute('cx',x); dot.setAttribute('cy',y); dot.setAttribute('r','3'); svg.append(dot);
    });
  }
  function render() {
    if (!motion || !lesson) return;
    frameIndex = Math.max(0,Math.min(frameCount-1,Math.floor(video.currentTime * motion.fps + .01)));
    $('scrub').value = String(frameIndex);
    $('currentTime').textContent = `${sourceTime().toFixed(3)}s`;
    const time = sourceTime();
    const overlap = (time >= 20.5 && time <= 25.5) || time >= 28;
    $('motionCaution').textContent = lesson.schemaVersion === 2
      ? frameMap.has(frameIndex) ? 'Unreviewed estimates. Participant identities may change at overlaps.' : 'No skeletons selected for this part of the footage.'
      : overlap ? 'People overlap here. Check the estimates against the footage.' : 'Compare the skeleton with the footage at overlaps.';
    $('stage').classList.toggle('seeking',video.seeking);
    drawSkeleton(); renderAnnotations();
  }
  function tick() {
    renderRequest = null;
    if (video.paused || video.ended) return;
    if (selected && sourceTime() >= selected.end - .01) {
      if ($('loopPassage').checked) video.currentTime = selected.start - motion.sourceStart;
      else { video.pause(); seek(selected.end); return; }
    }
    render(); renderRequest = requestAnimationFrame(tick);
  }
  function seek(sourceSeconds) {
    const time = Math.max(0,Math.min((frameCount-1)/motion.fps,sourceSeconds-motion.sourceStart));
    video.currentTime = time;
    render();
  }
  async function play() {
    $('detailAudio').pause(); $('editorAudio').pause();
    try { await video.play(); } catch { toast('Tap Play again to start the footage.'); }
  }
  function renderList() {
    const list = $('noteList'); list.replaceChildren();
    $('noteCount').textContent = `(${lesson.notes.length})`;
    $('noteTicks').replaceChildren();
    lesson.notes.forEach((note,index) => {
      const card = document.createElement('button'); card.type = 'button'; card.className = 'note-card';
      card.dataset.noteId = note.id; card.classList.toggle('active',selected?.id === note.id);
      const number = document.createElement('span'); number.className = 'note-number'; number.textContent = String(index+1);
      const content = document.createElement('span'); const title = document.createElement('strong'); title.textContent = note.title;
      const meta = document.createElement('span'); meta.className = 'note-meta'; meta.textContent = `${seconds(note.start)}–${seconds(note.end)} · ${noteTarget(note)}`;
      if (note.personal) { const badge = document.createElement('span'); badge.className = 'personal-label'; badge.textContent = 'Yours'; meta.append(badge); }
      if (note.sample) { const badge = document.createElement('span'); badge.className = 'sample-label'; badge.textContent = 'Sample'; meta.append(badge); }
      if (note.audio) { const voice = document.createElement('span'); voice.className = 'voice-label'; voice.textContent = '♪ Voice'; meta.append(voice); }
      const excerpt = document.createElement('span'); excerpt.className = 'note-excerpt'; excerpt.textContent = note.text.length > 145 ? note.text.slice(0,142)+'…' : note.text || 'Open to listen to the explanation.';
      content.append(title,meta,excerpt); card.append(number,content);
      card.addEventListener('click',() => openNote(note)); list.append(card);
      const duration = motion.sourceEnd-motion.sourceStart;
      const bar = document.createElement('span'); bar.style.left = `${(note.start-motion.sourceStart)/duration*100}%`;
      bar.style.width = `${(note.end-note.start)/duration*100}%`; $('noteTicks').append(bar);
    });
    if (!lesson.notes.length) {
      const empty = document.createElement('p'); empty.className = 'empty-notes';
      empty.textContent = 'Pause the footage and choose “Add annotation” to record your observations.';
      list.append(empty);
    }
  }
  function closeDetail() {
    selected = null; $('detailAudio').pause(); $('noteDetail').hidden = true;
    $('noteList').hidden = false; $('closeDetail').hidden = true; $('replayPassage').disabled = true;
    renderList(); render();
  }
  function openNote(note) {
    if (draft) return;
    applyViews({...views, list:true});
    video.pause(); selected = note; seek(note.start);
    $('detailTitle').textContent = note.title;
    $('detailMeta').textContent = `${seconds(note.start)}–${seconds(note.end)} · ${noteTarget(note)}${note.sample ? ' · Sample prompt' : ''}`;
    $('detailText').textContent = note.text;
    $('detailText').hidden = !note.text;
    const audio = $('detailAudio'); audio.pause(); audio.removeAttribute('src');
    audio.hidden = !note.audio; if (note.audio) audio.src = audioUrl(note);
    $('noteList').hidden = true; $('noteDetail').hidden = false; $('closeDetail').hidden = false;
    $('detailAuthorActions').hidden = !note.personal;
    $('replayPassage').disabled = false; render();
  }
  function showAudioPreview() {
    const audio = $('editorAudio'); audio.pause();
    if (previewUrl) { URL.revokeObjectURL(previewUrl); previewUrl = null; }
    audio.removeAttribute('src'); audio.hidden = !audioBlob && !audioName;
    if (audioBlob) { previewUrl = URL.createObjectURL(audioBlob); audio.src = previewUrl; }
    else if (audioName) audio.src = audioBase + encodeURIComponent(audioName);
    $('removeAudio').hidden = !audioBlob && !audioName;
  }
  function error(message) { $('editorError').textContent = message; $('editorError').hidden = false; }
  function updateTarget() {
    if (!draft) return;
    draft.trackId = Number($('notePerson').value);
    $('noteJoint').disabled = !draft.trackId;
    if (!draft.trackId) $('noteJoint').value = '';
    draft.jointIndex = $('noteJoint').value === '' ? null : Number($('noteJoint').value);
    const position = markerPosition(draft);
    $('anchorStatus').textContent = draft.trackId
      ? `${noteTarget(draft)}. ${position ? 'Marker follows the motion estimate.' : 'No estimate at this frame; the explanation stays available in the note list.'}`
      : 'Marker placed at a point in the scene. Tap the footage to move it.';
    render();
  }
  function beginEdit(note = null) {
    if (saving || recordingPending || (note && !note.personal)) return;
    video.pause(); $('detailAudio').pause();
    const start = Math.min(motion.sourceEnd-1/motion.fps,Number(sourceTime().toFixed(3)));
    draft = note ? structuredClone(note) : {title:'',text:'',start,end:Math.min(motion.sourceEnd,start+2),trackId:0,jointIndex:null,anchor:{x:.5,y:.5},audio:null};
    selected = null; audioBlob = null; audioName = draft.audio || null;
    $('editorHeading').textContent = note ? 'Edit annotation' : 'Add annotation';
    $('noteTitle').value = draft.title; $('noteText').value = draft.text;
    $('noteStart').value = String(draft.start); $('noteEnd').value = String(draft.end);
    $('notePerson').value = String(draft.trackId); $('noteJoint').value = draft.jointIndex === null ? '' : String(draft.jointIndex);
    $('noteList').hidden = true; $('noteDetail').hidden = true; $('closeDetail').hidden = true;
    $('noteEditor').hidden = false; $('placementHint').hidden = false; $('addNote').disabled = true;
    $('replayPassage').disabled = true; $('editorError').hidden = true;
    $('recordStatus').textContent = audioName ? 'A voice explanation is attached. Play it below.' : 'Record a short explanation or attach an audio file.';
    applyViews({...views, moment:true, list:true});
    showAudioPreview(); updateTarget();
    if (innerWidth <= 900) $(note ? 'noteEditor' : 'stage').scrollIntoView({behavior:'smooth',block:note ? 'start' : 'center'});
  }
  function stopRecording(discard = false) {
    clearTimeout(recordTimer);
    if (recorder && recorder.state !== 'inactive') { recorder.discard = discard; recorder.stop(); }
    if (micStream) { micStream.getTracks().forEach(track => track.stop()); micStream = null; }
    $('record').classList.remove('recording'); $('record').textContent = '● Record voice';
  }
  function cancelEdit() {
    if (saving || recordingPending) return;
    stopRecording(true); draft = null; audioBlob = null; audioName = null; showAudioPreview();
    $('noteEditor').hidden = true; $('placementHint').hidden = true; $('addNote').disabled = false;
    $('noteList').hidden = false; applyViews(); renderList(); render();
  }
  async function toggleRecording() {
    if (!draft || recordingPending || saving) return;
    if (recorder && recorder.state === 'recording') { stopRecording(); return; }
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      error('Voice recording needs a supported browser on localhost or HTTPS. You can attach a voice recording instead.'); return;
    }
    recordingPending = true; $('record').disabled = true; $('saveNote').disabled = true;
    try {
      micStream = await navigator.mediaDevices.getUserMedia({audio:true});
      const types = ['audio/mp4','audio/webm;codecs=opus','audio/webm','audio/ogg;codecs=opus'];
      const mimeType = types.find(type => MediaRecorder.isTypeSupported(type));
      const active = new MediaRecorder(micStream,mimeType ? {mimeType} : {});
      recorder = active; const chunks = [];
      active.addEventListener('dataavailable',event => { if (event.data.size) chunks.push(event.data); });
      active.addEventListener('stop',() => {
        if (recorder === active) recorder = null;
        if (!active.discard && draft) {
          audioBlob = new Blob(chunks,{type:active.mimeType || 'audio/webm'}); audioName = null;
          if (!audioBlob.size) { audioBlob = null; error('The recording was empty. Try again or attach audio.'); }
          else { $('recordStatus').textContent = 'Recording ready. Listen below, then save the note.'; showAudioPreview(); }
        }
        $('saveNote').disabled = false;
      });
      active.addEventListener('error',() => { error('The recording stopped. Try again or attach an audio file.'); stopRecording(true); });
      active.start(); $('record').classList.add('recording'); $('record').textContent = '■ Stop recording';
      $('recordStatus').textContent = 'Recording… Tap Stop when your explanation is complete.';
      $('editorError').hidden = true;
      recordTimer = setTimeout(() => { stopRecording(); toast('The three-minute recording limit was reached.'); },180000);
    } catch (failure) {
      stopRecording(true); $('saveNote').disabled = false;
      error(failure.name === 'NotAllowedError' ? 'Microphone access was not allowed. Enable it in the browser or attach an audio file.' : 'The microphone could not start. Check it or attach an audio file.');
    } finally { recordingPending = false; $('record').disabled = false; }
  }
  function audioType(file) {
    const known = {'m4a':'audio/mp4','mp4':'audio/mp4','mp3':'audio/mpeg','wav':'audio/wav','ogg':'audio/ogg','webm':'audio/webm','aac':'audio/aac'};
    return known[file.name?.split('.').pop().toLowerCase()] || file.type;
  }
  async function saveNote() {
    if (!draft || saving || recordingPending || recorder?.state === 'recording') return;
    const start = Number($('noteStart').value), end = Number($('noteEnd').value);
    const title = $('noteTitle').value.trim(), text = $('noteText').value.trim();
    if (!title) { error('Give the note a title.'); $('noteTitle').focus(); return; }
    if (!text && !audioBlob && !audioName) { error('Add a text explanation or a voice note.'); return; }
    if (!(start >= motion.sourceStart && start < end && end <= motion.sourceEnd)) { error(`Choose a time range within ${motion.sourceStart}–${motion.sourceEnd} seconds, with an end after the start.`); return; }
    saving = true; $('saveNote').disabled = true; $('cancelEdit').disabled = true; $('saveState').textContent = 'Saving…';
    try {
      if (audioBlob) {
        if (audioBlob.size > 20*1024*1024) throw new Error('Choose an audio file smaller than 20 MB.');
        const uploaded = await json('/api/audio',{method:'POST',headers:{'Content-Type':audioType(audioBlob)},body:audioBlob});
        audioName = uploaded.audio;
      }
      const result = await post(api('/api/notes'),{...draft,title,text,start,end,audio:audioName});
      mergeNotes(result.notes); const note = ownNotes.find(n => n.id === result.note.id);
      saving = false; cancelEdit(); openNote(note);
      $('saveState').textContent = 'Annotation saved'; toast('Your annotation is saved.');
    } catch (failure) { error(failure.message); $('saveState').textContent = 'Save needed'; }
    finally { saving = false; $('saveNote').disabled = false; $('cancelEdit').disabled = false; }
  }
  async function initialize() {
    try {
      if (snapshotId) {
        if (!/^[a-zA-Z0-9_-]{1,80}$/.test(snapshotId)) throw new Error('This class lesson link is invalid.');
        lesson = await json(`/published/${snapshotId}/lesson.json`);
      } else {
        lesson = await json(api('/api/lesson'));
      }
      if (projectId && lesson.status !== 'ready') throw new Error('This lesson is still being prepared. Return to the lesson library.');
      sharedNotes = (lesson.notes || []).map(note => ({...note,personal:false}));
      const personal = await json(api('/api/annotations'));
      mergeNotes(personal.notes);
      if ($('sceneLink') && !projectId && !snapshotId && lesson.schemaVersion !== 2) {
        fetch('/3d-pilot/manifest.json', {cache:'no-store'}).then(response => response.ok ? response.json() : null).then(manifest => {
          if (manifest?.status === 'reconstructed_awaiting_review') $('sceneLink').hidden = false;
        }).catch(() => {});
      }
      motion = await json(snapshotId && lesson.schemaVersion === 2 ? `/published/${snapshotId}/motion.json` : lesson.motion || 'motion.json');
      if (lesson.schemaVersion === 2) {
        video.src = snapshotId ? `/published/${snapshotId}/source.mp4` : lesson.video;
        people.length = 1; shown.clear();
        $('notePerson').replaceChildren();
        const scene = document.createElement('option'); scene.value = '0'; scene.textContent = 'A point in the scene'; $('notePerson').append(scene);
        lesson.people.forEach(person => {
          people[person.id] = person; shown.add(person.id);
          const option = document.createElement('option'); option.value = String(person.id); option.textContent = person.name; $('notePerson').append(option);
        });
        $('lessonTitle').textContent = lesson.title;
        $('lessonDescription').textContent = 'Review the skeletons in your selected passages. Pause to add an explanation.';
        $('lessonEyebrow').textContent = 'YOUR MOVEMENT LESSON';
        $('lessonDuration').textContent = `${motion.sourceEnd.toFixed(1)} seconds`;
        $('participantCount').textContent = `${lesson.people.length} estimated tracks`;
        $('stage').style.aspectRatio = `${motion.width} / ${motion.height}`;
      }
      frameCount = Math.ceil((motion.sourceEnd-motion.sourceStart)*motion.fps);
      frameMap = new Map(motion.frames.map((frame,index) => [lesson.schemaVersion === 2 ? frame.frame : index,frame]));
      document.querySelector('.time-row>span:last-child').textContent = `${motion.sourceEnd.toFixed(3)}s`;
      $('noteStart').min = String(motion.sourceStart); $('noteStart').max = String(motion.sourceEnd-1/motion.fps);
      $('noteEnd').min = String(motion.sourceStart+1/motion.fps); $('noteEnd').max = String(motion.sourceEnd);
      $('lessonTitle').textContent = lesson.title;
      $('lessonDescription').textContent = 'Explore the movement. Pause to add your own text or voice annotations.';
      canvas.width = motion.width; canvas.height = motion.height;
      $('scrub').max = String(frameCount-1);
      joints.forEach((name,index) => { const option = document.createElement('option'); option.value = String(index); option.textContent = name; $('noteJoint').append(option); });
      people.slice(1).forEach((person,index) => {
        const id = person.id || index+1, button = document.createElement('button'); button.type = 'button'; button.dataset.trackId = String(id);
        button.setAttribute('aria-pressed','true'); const swatch = document.createElement('span'); swatch.className = 'swatch'; swatch.style.background = person.color;
        button.append(swatch,document.createTextNode(person.name));
        button.addEventListener('click',() => { if (shown.has(id)) shown.delete(id); else shown.add(id); button.classList.toggle('off',!shown.has(id)); button.setAttribute('aria-pressed',String(shown.has(id))); render(); });
        $('participants').append(button);
      });
      renderList();
      const entryFrame = Number(query.get('frame'));
      if (query.has('frame') && Number.isInteger(entryFrame) && entryFrame >= 0 && entryFrame < frameCount) {
        if (video.readyState >= 1) seek(motion.sourceStart + entryFrame / motion.fps);
        else video.addEventListener('loadedmetadata',() => seek(motion.sourceStart + entryFrame / motion.fps),{once:true});
      }
      render();
    } catch (failure) { $('videoError').textContent = failure.message; $('videoError').hidden = false; $('addNote').disabled = true;  }
  }

  video.addEventListener('play',() => { $('play').textContent = 'Ⅱ'; $('play').setAttribute('aria-label','Pause movement'); if (!renderRequest) renderRequest = requestAnimationFrame(tick); });
  video.addEventListener('pause',() => { $('play').textContent = '▶'; $('play').setAttribute('aria-label','Play movement'); render(); });
  video.addEventListener('seeking',render); video.addEventListener('seeked',render); video.addEventListener('timeupdate',render);
  video.addEventListener('error',() => { $('videoError').hidden = true; $('videoError').textContent = 'Video could not load. Reload the lesson to try again.'; $('videoError').hidden = false; });
  $('play').addEventListener('click',() => {
    if (!motion) return;
    if (!video.paused) video.pause();
    else { if (selected && (sourceTime() >= selected.end-.01 || sourceTime() < selected.start)) seek(selected.start); else if (video.ended) seek(motion.sourceStart); play(); }
  });
  $('scrub').addEventListener('input',() => { if (motion) { video.pause(); seek(motion.sourceStart + Number($('scrub').value)/motion.fps); } });
  $('previousFrame').addEventListener('click',() => { if (motion) { video.pause(); seek(motion.sourceStart+(frameIndex-1)/motion.fps); } });
  $('nextFrame').addEventListener('click',() => { if (motion) { video.pause(); seek(motion.sourceStart+(frameIndex+1)/motion.fps); } });
  $('speed').addEventListener('change',() => { video.playbackRate = Number($('speed').value); });
  $('replayPassage').addEventListener('click',() => { if (selected) { seek(selected.start); play(); } });
  document.querySelectorAll('[data-preset]').forEach(button => button.addEventListener('click',() => applyViews(presets[button.dataset.preset])));
  $('chooseViews').addEventListener('click',() => { $('viewPicker').showModal(); document.body.classList.add('view-picker-open'); });
  $('closeViews').addEventListener('click',closeViews);
  $('doneViews').addEventListener('click',closeViews);
  $('viewPicker').addEventListener('close',() => { document.body.classList.remove('view-picker-open'); $('chooseViews').focus({preventScroll:true}); });
  $('viewPicker').addEventListener('keydown',event => {
    if (event.key !== 'Tab') return;
    const focusable = [...$('viewPicker').querySelectorAll('button:not([disabled]), a[href], input:not([disabled])')]
      .filter(element => element.getClientRects().length && (element.type !== 'radio' || element.checked));
    const first = focusable[0], last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });
  $('viewPicker').addEventListener('click',event => {
    if (event.target !== $('viewPicker')) return;
    const rect = $('viewPicker').getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closeViews();
  });
  document.querySelectorAll('input[name="movementView"]').forEach(input => input.addEventListener('change',() => applyViews({...views, visual:input.value})));
  $('showMomentNotes').addEventListener('change',() => applyViews({...views, moment:$('showMomentNotes').checked}));
  $('showAnnotationList').addEventListener('change',() => applyViews({...views, list:$('showAnnotationList').checked}));
  $('sceneLink').addEventListener('click',event => {
    if (draft) { event.preventDefault(); toast('Save or cancel your annotation before opening the 3D scene.'); return; }
    $('sceneLink').href = `/scene.html?frame=${frameIndex}`;
  });
  $('closeDetail').addEventListener('click',closeDetail);
  $('jumpToNote').addEventListener('click',() => { if (selected) { video.pause(); seek(selected.start); if (innerWidth <= 900) $('stage').scrollIntoView({behavior:'smooth',block:'center'}); } });
  $('addNote').addEventListener('click',() => beginEdit());
  $('editNote').addEventListener('click',() => { if (selected) beginEdit(selected); });
  $('cancelEdit').addEventListener('click',cancelEdit);
  $('saveNote').addEventListener('click',saveNote);
  $('notePerson').addEventListener('change',updateTarget); $('noteJoint').addEventListener('change',updateTarget);
  $('startHere').addEventListener('click',() => { $('noteStart').value = Math.min(motion.sourceEnd-1/motion.fps,sourceTime()).toFixed(3); });
  $('endHere').addEventListener('click',() => { $('noteEnd').value = Math.min(motion.sourceEnd,sourceTime()+1/motion.fps).toFixed(3); });
  $('stage').addEventListener('click',event => {
    if (!draft) return;
    if (video.seeking) { toast('Wait for this moment to load, then place the note.'); return; }
    const rect = $('stage').getBoundingClientRect();
    const x = Math.max(0,Math.min(1,(event.clientX-rect.left)/rect.width));
    const y = Math.max(0,Math.min(1,(event.clientY-rect.top)/rect.height));
    draft.anchor = {x,y};
    let closest = {distance:45,person:0,joint:null};
    for (const person of currentFrame().people) {
      if (!shown.has(person.id)) continue;
      person.xy.forEach((point,index) => {
        if (!validPoint(person,index)) return;
        const distance = Math.hypot((point[0]/motion.width-x)*rect.width,(point[1]/motion.height-y)*rect.height);
        if (distance < closest.distance) closest = {distance,person:person.id,joint:index};
      });
    }
    $('notePerson').value = String(closest.person); $('noteJoint').value = closest.joint === null ? '' : String(closest.joint);
    updateTarget();
    if (innerWidth <= 900) $('noteEditor').scrollIntoView({behavior:'smooth',block:'start'});
  });
  $('record').addEventListener('click',toggleRecording);
  $('audioFile').addEventListener('change',() => {
    const file = $('audioFile').files[0]; $('audioFile').value = '';
    if (!file || !draft) return;
    if (recorder?.state === 'recording') { error('Stop the recording before attaching another audio file.'); return; }
    if (file.size > 20*1024*1024) { error('Choose an audio file smaller than 20 MB.'); return; }
    audioBlob = file; audioName = null; $('recordStatus').textContent = `Attached: ${file.name}. Listen below, then save the note.`;
    $('editorError').hidden = true; showAudioPreview();
  });
  $('removeAudio').addEventListener('click',() => { if (recorder?.state === 'recording') return; audioBlob = null; audioName = null; showAudioPreview(); $('recordStatus').textContent = 'Record a short explanation or attach an audio file.'; });
  $('detailAudio').addEventListener('play',() => video.pause()); $('editorAudio').addEventListener('play',() => video.pause());
  $('deleteNote').addEventListener('click',async () => {
    if (!selected?.personal || !confirm(`Delete your annotation “${selected.title}”?`)) return;
    $('deleteNote').disabled = true;
    try { const result = await post(api('/api/notes/delete'),{id:selected.id}); mergeNotes(result.notes); closeDetail(); toast('Note deleted.'); }
    catch (failure) { toast(failure.message); }
    finally { $('deleteNote').disabled = false; }
  });
  ['noteTitle','noteText','noteStart','noteEnd'].forEach(id => $(id).addEventListener('input',render));
  new ResizeObserver(render).observe($('movementView'));
  $('annotationRail').addEventListener('scroll',render);
  document.addEventListener('keydown',event => {
    if (!motion || $('viewPicker').open || /INPUT|TEXTAREA|SELECT|BUTTON|A/.test(document.activeElement?.tagName)) return;
    if (event.code === 'Space') { event.preventDefault(); $('play').click(); }
    if (event.code === 'ArrowLeft' || event.code === 'ArrowRight') { event.preventDefault(); $(event.code === 'ArrowLeft' ? 'previousFrame' : 'nextFrame').click(); }
  });
  window.addEventListener('pagehide',() => { stopRecording(true); if (previewUrl) URL.revokeObjectURL(previewUrl); });
  applyViews();
  initialize();
})();

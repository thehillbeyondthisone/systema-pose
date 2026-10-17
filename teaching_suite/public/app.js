'use strict';

(() => {
  const $ = id => document.getElementById(id);
  const query = new URLSearchParams(location.search);
  const site = window.SystemaSite;
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
  let renderRequest = null, fitRequest = null, playbackMode = 'clip';
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
  let toastTimer, saving = false, annotationSignature = '';
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
    if (site && url.startsWith('/api/')) return site.request(url, options);
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
  function fitViewer() {
    cancelAnimationFrame(fitRequest);
    fitRequest = requestAnimationFrame(() => {
      const view = $('movementView');
      if (innerWidth <= 900 || innerHeight < 580) {
        view.style.removeProperty('--stage-max-height');
        return;
      }
      const primaryControls = $('lessonTransport').offsetHeight + $('lessonPlaybackOptions').offsetHeight;
      const available = innerHeight - Math.max(0,view.getBoundingClientRect().top) - primaryControls - 20;
      view.style.setProperty('--stage-max-height',`${Math.max(160,Math.floor(available))}px`);
    });
  }
  function updatePlayback() {
    const passage = playbackMode === 'passage' && selected;
    $('play').classList.toggle('is-playing',!video.paused && !video.ended);
    $('play').setAttribute('aria-label',`${video.paused ? 'Play' : 'Pause'} ${passage ? 'passage' : 'full clip'}`);
    $('playbackScope').textContent = passage ? `Passage · ${seconds(selected.start)}–${seconds(selected.end)}` : 'Full clip';
    $('playbackScope').classList.toggle('passage-mode',Boolean(passage));
    $('playFullClip').hidden = !passage;
    $('replayPassage').hidden = !selected;
    $('loopPassage').closest('label').hidden = !selected;
    $('loopPassage').disabled = !selected;
    $('selectedPassage').hidden = !selected;
    if (selected && motion) {
      const duration = motion.sourceEnd-motion.sourceStart;
      $('selectedPassage').style.left = `${(selected.start-motion.sourceStart)/duration*100}%`;
      $('selectedPassage').style.width = `${(selected.end-selected.start)/duration*100}%`;
      $('scrub').setAttribute('aria-description',`Selected passage: ${seconds(selected.start)} to ${seconds(selected.end)}. Use Play passage to replay it.`);
    } else $('scrub').removeAttribute('aria-description');
  }
  function fullClipMode() {
    playbackMode = 'clip';
    $('loopPassage').checked = false;
    updatePlayback();
  }
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
    const signature = JSON.stringify(active.map(note => [note.id,note.title,note.text,note.start,note.end]));
    if (signature !== annotationSignature) {
      annotationSignature = signature; $('activeAnnotations').replaceChildren();
      active.forEach(note => {
        const card = document.createElement(pending ? 'div' : 'button');
        card.className = 'annotation-callout'; card.dataset.noteId = note.id;
        if (!pending) { card.type = 'button'; card.addEventListener('click',() => openNote(note)); }
        const title = document.createElement('strong'); title.textContent = note.title;
        const text = document.createElement('span'); text.className = 'callout-text'; text.textContent = note.text || 'This older annotation has no text explanation.';
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
    $('scrub').setAttribute('aria-valuetext',`${sourceTime().toFixed(3)} source seconds`);
    const sceneHref = site ? site.link('scene.html',lesson.id,frameIndex) : `/scene.html?frame=${frameIndex}`;
    for (const id of ['sceneLink','sceneShortcut']) {
      if ($(id).getAttribute('href') !== sceneHref) $(id).setAttribute('href',sceneHref);
    }
    const time = sourceTime();
    const overlap = (time >= 20.5 && time <= 25.5) || time >= 28;
    $('motionCaution').textContent = lesson.schemaVersion === 2
      ? frameMap.has(frameIndex) ? 'Unreviewed estimates. Participant identities may change at overlaps.' : 'No skeletons selected for this part of the footage.'
      : overlap ? 'People overlap here. Check the estimates against the footage.' : 'Compare the skeleton with the footage at overlaps.';
    $('stage').classList.toggle('seeking',video.seeking);
    drawSkeleton(); renderAnnotations(); updatePlayback();
  }
  function tick() {
    renderRequest = null;
    if (video.paused || video.ended) return;
    if (playbackMode === 'passage' && selected && sourceTime() >= selected.end - .01) {
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
      const excerpt = document.createElement('span'); excerpt.className = 'note-excerpt'; excerpt.textContent = note.text.length > 145 ? note.text.slice(0,142)+'…' : note.text || 'This older annotation has no text explanation.';
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
    selected = null; $('noteDetail').hidden = true;
    fullClipMode();
    $('noteList').hidden = false; $('closeDetail').hidden = true; $('replayPassage').disabled = true;
    renderList(); render();
  }
  function openNote(note) {
    if (draft) return;
    applyViews({...views, list:true});
    video.pause(); selected = note; fullClipMode(); seek(note.start);
    $('detailTitle').textContent = note.title;
    $('detailMeta').textContent = `${seconds(note.start)}–${seconds(note.end)} · ${noteTarget(note)}${note.sample ? ' · Sample prompt' : ''}`;
    $('detailText').textContent = note.text || 'This older annotation has no text explanation. Edit it to add your observation.';
    $('noteList').hidden = true; $('noteDetail').hidden = false; $('closeDetail').hidden = false;
    $('detailAuthorActions').hidden = !note.personal;
    $('replayPassage').disabled = false; render();
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
    if (saving || (note && !note.personal)) return;
    video.pause();
    const start = Math.min(motion.sourceEnd-1/motion.fps,Number(sourceTime().toFixed(3)));
    draft = note ? structuredClone(note) : {title:'',text:'',start,end:Math.min(motion.sourceEnd,start+2),trackId:0,jointIndex:null,anchor:{x:.5,y:.5}};
    delete draft.audio;
    selected = null;
    fullClipMode();
    $('editorHeading').textContent = note ? 'Edit annotation' : 'Add annotation';
    $('noteTitle').value = draft.title; $('noteText').value = draft.text;
    $('noteStart').value = String(draft.start); $('noteEnd').value = String(draft.end);
    $('notePerson').value = String(draft.trackId); $('noteJoint').value = draft.jointIndex === null ? '' : String(draft.jointIndex);
    $('noteList').hidden = true; $('noteDetail').hidden = true; $('closeDetail').hidden = true;
    $('noteEditor').hidden = false; $('placementHint').hidden = false; $('addNote').disabled = true;
    $('replayPassage').disabled = true; $('editorError').hidden = true;
    applyViews({...views, moment:true, list:true});
    updateTarget();
    if (innerWidth <= 900) $(note ? 'noteEditor' : 'stage').scrollIntoView({behavior:'smooth',block:note ? 'start' : 'center'});
  }
  function cancelEdit() {
    if (saving) return;
    draft = null;
    $('noteEditor').hidden = true; $('placementHint').hidden = true; $('addNote').disabled = false;
    $('noteList').hidden = false; applyViews(); renderList(); render();
  }
  async function saveNote() {
    if (!draft || saving) return;
    const start = Number($('noteStart').value), end = Number($('noteEnd').value);
    const title = $('noteTitle').value.trim(), text = $('noteText').value.trim();
    if (!title) { error('Give the note a title.'); $('noteTitle').focus(); return; }
    if (!text) { error('Add a text explanation.'); $('noteText').focus(); return; }
    if (!(start >= motion.sourceStart && start < end && end <= motion.sourceEnd)) { error(`Choose a time range within ${motion.sourceStart}–${motion.sourceEnd} seconds, with an end after the start.`); return; }
    saving = true; $('saveNote').disabled = true; $('cancelEdit').disabled = true; $('saveState').textContent = 'Saving…';
    try {
      const result = await post(api('/api/notes'),{...draft,title,text,start,end});
      mergeNotes(result.notes); const note = ownNotes.find(n => n.id === result.note.id);
      saving = false; cancelEdit(); openNote(note);
      $('saveState').textContent = 'Annotation saved'; toast('Your annotation is saved.');
    } catch (failure) { error(failure.message); $('saveState').textContent = 'Save needed'; }
    finally { saving = false; $('saveNote').disabled = false; $('cancelEdit').disabled = false; }
  }
  async function initialize() {
    try {
      if (site) {
        lesson = await site.lesson();
      } else if (snapshotId) {
        if (!/^[a-zA-Z0-9_-]{1,80}$/.test(snapshotId)) throw new Error('This class lesson link is invalid.');
        lesson = await json(`/published/${snapshotId}/lesson.json`);
      } else {
        lesson = await json(api('/api/lesson'));
      }
      if (projectId && lesson.status !== 'ready') throw new Error('This lesson is still being prepared. Return to the lesson library.');
      sharedNotes = (lesson.notes || []).map(note => ({...note,personal:false,
        text:note.sample && note.id==='sample-hands' && note.text.includes('attach a voice or text explanation')
          ? 'Sample prompt: Add a text explanation to this hand and this moment. The marker follows the joint estimate when one is available.' : note.text}));
      const personal = await json(api('/api/annotations'));
      mergeNotes(personal.notes);
      if (site) {
        $('sceneLink').hidden = $('sceneShortcut').hidden = !lesson.scene;
        document.querySelector('.author-footer p').textContent = 'Your annotations stay in this browser on this device. Back them up before clearing site data or switching browsers.';
        $('noteBackup').hidden = false;
      } else if ($('sceneLink') && !projectId && !snapshotId && lesson.schemaVersion !== 2) {
        fetch('/3d-pilot/manifest.json', {cache:'no-store'}).then(response => response.ok ? response.json() : null).then(manifest => {
          if (manifest?.status === 'reconstructed_awaiting_review') $('sceneLink').hidden = $('sceneShortcut').hidden = false;
        }).catch(() => {});
      }
      motion = await json(!site && snapshotId && lesson.schemaVersion === 2 ? `/published/${snapshotId}/motion.json` : lesson.motion || 'motion.json');
      if (lesson.schemaVersion === 2) {
        video.src = !site && snapshotId ? `/published/${snapshotId}/source.mp4` : lesson.video;
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
        $('lessonDuration').textContent = `${Number((motion.sourceEnd-motion.sourceStart).toFixed(1))} seconds`;
        $('participantCount').textContent = `${lesson.people.length} participants`;
        $('stage').style.aspectRatio = `${motion.width} / ${motion.height}`;
      }
      frameCount = Math.ceil((motion.sourceEnd-motion.sourceStart)*motion.fps);
      frameMap = new Map(motion.frames.map((frame,index) => [lesson.schemaVersion === 2 ? frame.frame : index,frame]));
      document.querySelector('.time-row>span:last-child').textContent = `${motion.sourceEnd.toFixed(3)}s`;
      $('noteStart').min = String(motion.sourceStart); $('noteStart').max = String(motion.sourceEnd-1/motion.fps);
      $('noteEnd').min = String(motion.sourceStart+1/motion.fps); $('noteEnd').max = String(motion.sourceEnd);
      $('lessonTitle').textContent = lesson.title;
      $('lessonDescription').textContent = site ? lesson.description : 'Explore the movement. Pause to add your own text annotations.';
      if (site) $('lessonEyebrow').textContent = `${lesson.category.toUpperCase()} · MOVEMENT LESSON`;
      canvas.width = motion.width; canvas.height = motion.height;
      $('movementView').style.setProperty('--media-ratio',String(motion.width/motion.height));
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
      render(); fitViewer();
    } catch (failure) { $('videoError').textContent = failure.message; $('videoError').hidden = false; $('addNote').disabled = true;  }
  }

  video.addEventListener('play',() => { updatePlayback(); if (!renderRequest) renderRequest = requestAnimationFrame(tick); });
  video.addEventListener('pause',render);
  video.addEventListener('seeking',render); video.addEventListener('seeked',render); video.addEventListener('timeupdate',render);
  video.addEventListener('error',() => { $('videoError').hidden = true; $('videoError').textContent = 'Video could not load. Reload the lesson to try again.'; $('videoError').hidden = false; });
  $('play').addEventListener('click',() => {
    if (!motion) return;
    if (!video.paused) video.pause();
    else { if (playbackMode === 'passage' && selected && (sourceTime() >= selected.end-.01 || sourceTime() < selected.start)) seek(selected.start); else if (video.ended) seek(motion.sourceStart); play(); }
  });
  $('scrub').addEventListener('input',() => { if (motion) { video.pause(); fullClipMode(); seek(motion.sourceStart + Number($('scrub').value)/motion.fps); } });
  $('previousFrame').addEventListener('click',() => { if (motion) { video.pause(); fullClipMode(); seek(motion.sourceStart+(frameIndex-1)/motion.fps); } });
  $('nextFrame').addEventListener('click',() => { if (motion) { video.pause(); fullClipMode(); seek(motion.sourceStart+(frameIndex+1)/motion.fps); } });
  $('speed').addEventListener('change',() => { video.playbackRate = Number($('speed').value); });
  $('replayPassage').addEventListener('click',() => { if (selected) { playbackMode = 'passage'; seek(selected.start); play(); } });
  $('playFullClip').addEventListener('click',() => { fullClipMode(); $('play').focus({preventScroll:true}); if (video.ended) seek(motion.sourceStart); play(); });
  $('loopPassage').addEventListener('change',() => {
    if (!selected) return;
    if ($('loopPassage').checked) {
      playbackMode = 'passage';
      if (sourceTime() < selected.start || sourceTime() >= selected.end) seek(selected.start);
    }
    updatePlayback();
  });
  $('lessonMute').addEventListener('click',() => { video.muted = !video.muted; });
  video.addEventListener('volumechange',() => {
    $('lessonMute').classList.toggle('is-muted',video.muted);
    $('lessonMute').setAttribute('aria-pressed',String(video.muted));
    $('lessonMute').setAttribute('aria-label',video.muted ? 'Unmute source audio' : 'Mute source audio');
  });
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
  ['sceneLink','sceneShortcut'].forEach(id => $(id).addEventListener('click',event => {
    if (draft) { event.preventDefault(); toast('Save or cancel your annotation before opening the 3D scene.'); return; }
    event.currentTarget.href = site ? site.link('scene.html',lesson.id,frameIndex) : `/scene.html?frame=${frameIndex}`;
  }));
  $('closeDetail').addEventListener('click',closeDetail);
  $('jumpToNote').addEventListener('click',() => { if (selected) { video.pause(); seek(selected.start); if (innerWidth <= 900) $('stage').scrollIntoView({behavior:'smooth',block:'center'}); } });
  $('addNote').addEventListener('click',() => beginEdit());
  $('editNote').addEventListener('click',() => { if (selected) beginEdit(selected); });
  $('cancelEdit').addEventListener('click',cancelEdit);
  $('saveNote').addEventListener('click',saveNote);
  $('exportNotes').addEventListener('click',async () => {
    try { await site.exportNotes(); toast('Notes backup downloaded.'); }
    catch (failure) { toast(failure.message); }
  });
  $('importNotes').addEventListener('click',() => {
    if (draft) { toast('Save or cancel your draft before restoring notes.'); return; }
    $('notesFile').click();
  });
  $('notesFile').addEventListener('change',async () => {
    try { const result = await site.importNotes($('notesFile').files[0]); mergeNotes(result.notes); closeDetail(); render(); toast('Notes restored. Existing observations were kept.'); }
    catch (failure) { toast(failure.message); }
    finally { $('notesFile').value = ''; }
  });
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
  $('deleteNote').addEventListener('click',async () => {
    if (!selected?.personal || !confirm(`Delete your annotation “${selected.title}”?`)) return;
    $('deleteNote').disabled = true;
    try { const result = await post(api('/api/notes/delete'),{id:selected.id}); mergeNotes(result.notes); closeDetail(); toast('Note deleted.'); }
    catch (failure) { toast(failure.message); }
    finally { $('deleteNote').disabled = false; }
  });
  ['noteTitle','noteText','noteStart','noteEnd'].forEach(id => $(id).addEventListener('input',render));
  new ResizeObserver(() => { render(); fitViewer(); }).observe($('movementView'));
  new ResizeObserver(fitViewer).observe($('lessonPlaybackOptions'));
  window.addEventListener('resize',fitViewer);
  $('annotationRail').addEventListener('scroll',render);
  document.addEventListener('keydown',event => {
    if (!motion || $('viewPicker').open || /INPUT|TEXTAREA|SELECT|BUTTON|A/.test(document.activeElement?.tagName)) return;
    if (event.code === 'Space') { event.preventDefault(); $('play').click(); }
    if (event.code === 'ArrowLeft' || event.code === 'ArrowRight') { event.preventDefault(); $(event.code === 'ArrowLeft' ? 'previousFrame' : 'nextFrame').click(); }
  });
  applyViews();
  initialize();
})();

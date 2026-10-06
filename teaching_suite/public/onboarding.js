'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const statuses = {requested:'Awaiting review',processing:'Being processed',ready:'Lesson ready',declined:'Closed'};
  let busy = false;
  async function json(url, options) {
    const response = await fetch(url,options), value = await response.json();
    if (!response.ok) throw new Error(value.error || 'Could not load. Please try again.');
    return value;
  }
  function message(parent, text) {
    const p = document.createElement('p'); p.className = 'helper'; p.textContent = text; parent.append(p);
  }
  async function library() {
    try {
      const data = await json('/api/projects'); $('lessonLibrary').replaceChildren();
      if (!data.lessons.length) message($('lessonLibrary'),'New lessons will appear here after your teacher prepares them. Start with the sample lesson above.');
      data.lessons.forEach(lesson => {
        const card = document.createElement('article'); card.className = 'library-card';
        const title = document.createElement('h3'); title.textContent = lesson.title;
        const summary = document.createElement('p'); summary.textContent = `${lesson.sourceEnd.toFixed(1)}s footage · ${lesson.segments.length} prepared passages`;
        const link = document.createElement('a'); link.className = 'file-button'; link.href = `/?project=${encodeURIComponent(lesson.id)}`; link.textContent = 'Open lesson';
        card.append(title,summary,link); $('lessonLibrary').append(card);
      });
      $('setupError').hidden = true;
    } catch (failure) { $('setupError').textContent = failure.message; $('setupError').hidden = false; }
  }
  async function requests() {
    try {
      const data = await json('/api/video-requests'); $('requestList').replaceChildren();
      if (!data.requests.length) message($('requestList'),'Your submitted links will appear here, along with their processing status.');
      data.requests.forEach(request => {
        const card = document.createElement('article'); card.className = 'request-item';
        const badge = document.createElement('span'); badge.className = 'status '+request.status; badge.textContent = statuses[request.status] || request.status;
        const title = document.createElement('h3'); title.textContent = request.title;
        const link = document.createElement('a'); link.href = request.url; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = request.url;
        const meta = document.createElement('p'); meta.className = 'helper'; meta.textContent = `${request.name} · ${new Date(request.createdAt).toLocaleDateString()}`;
        card.append(badge,title,link,meta);
        if (request.passage) message(card,'Passage: '+request.passage);
        if (request.message) message(card,request.message);
        if (request.status === 'ready' && request.lessonId) {
          const lesson = document.createElement('a'); lesson.className = 'file-button primary'; lesson.href = `/?project=${encodeURIComponent(request.lessonId)}`; lesson.textContent = 'Open prepared lesson'; card.append(lesson);
        }
        $('requestList').append(card);
      });
    } catch (failure) { $('requestList').replaceChildren(); message($('requestList'),failure.message); }
  }
  $('requestForm').addEventListener('submit',async event => {
    event.preventDefault(); if (busy) return;
    busy = true; $('submitRequest').disabled = true; $('requestError').hidden = true; $('requestStatus').textContent = 'Submitting…';
    const value = {name:$('requestName').value,title:$('requestTitle').value,url:$('requestUrl').value,passage:$('requestPassage').value,message:$('requestMessage').value};
    try {
      await json('/api/video-requests',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(value)});
      try { localStorage.setItem('systema-request-name',value.name); } catch {}
      $('requestForm').reset(); $('requestName').value = value.name;
      $('requestStatus').textContent = 'Request submitted. Your teacher will review the link and process the video.';
      await requests();
    } catch (failure) { $('requestStatus').textContent = ''; $('requestError').textContent = failure.message; $('requestError').hidden = false; }
    finally { busy = false; $('submitRequest').disabled = false; }
  });
  $('refreshLessons').addEventListener('click',library); $('refreshRequests').addEventListener('click',requests);
  try { $('requestName').value = localStorage.getItem('systema-request-name') || ''; } catch {}
  library(); requests();
})();

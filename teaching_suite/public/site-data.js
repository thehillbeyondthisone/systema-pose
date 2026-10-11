'use strict';

// Included only in the static site. The workstation keeps using its server APIs.
window.SystemaSite = (() => {
  let lessonPromise;
  const base = new URL('./', location.href);
  const fetchJSON = async path => {
    const response = await fetch(new URL(path, base));
    if (!response.ok) throw Error('This lesson could not load. Return to the library and try again.');
    return response.json();
  };
  const catalog = () => fetchJSON('catalog.json');
  const lesson = () => lessonPromise ||= (async () => {
    const data = await catalog();
    const id = new URLSearchParams(location.search).get('clip') || data.lessons[0]?.id;
    const entry = data.lessons.find(item => item.id === id);
    if (!entry) throw Error('That clip is not in this library. Return to the library to choose one.');
    return fetchJSON(entry.lesson);
  })();
  const keyFor = item => `systema-notes-v1:${base.pathname}:${item.id}:${item.sourceSha256}`;
  const fingerprint = item => `${item.id}:${item.sourceSha256}`;
  function warning(message) {
    const banner = document.getElementById('siteNotice');
    if (banner) { banner.textContent = message; banner.hidden = false; }
  }
  function validateNote(note, item) {
    const fail = () => { throw Error('The annotation data is invalid for this clip.'); };
    if (!note || typeof note !== 'object') fail();
    if (typeof note.id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(note.id)) fail();
    if (typeof note.title !== 'string' || !note.title.trim() || note.title.length > 120) fail();
    if (typeof note.text !== 'string' || !note.text.trim() || note.text.length > 12000) fail();
    if (![note.start, note.end].every(Number.isFinite) || note.start < item.sourceStart || note.start >= note.end || note.end > item.sourceEnd) fail();
    if (!Number.isInteger(note.trackId) || (note.trackId !== 0 && !item.people.some(person => person.id === note.trackId))) fail();
    if (note.jointIndex !== null && (!Number.isInteger(note.jointIndex) || note.jointIndex < 0 || note.jointIndex > 22 || note.trackId === 0)) fail();
    if (!note.anchor || ![note.anchor.x, note.anchor.y].every(value => Number.isFinite(value) && value >= 0 && value <= 1)) fail();
    return {id:note.id, title:note.title.trim(), text:note.text.trim(), start:note.start, end:note.end,
      trackId:note.trackId, jointIndex:note.jointIndex, anchor:{x:note.anchor.x,y:note.anchor.y}};
  }
  function validateBundle(data, item) {
    if (!data || data.version !== 1 || data.lesson !== fingerprint(item) || !Array.isArray(data.notes) || data.notes.length > 2000) {
      throw Error('Choose a Systema notes backup made for this exact clip.');
    }
    const notes = data.notes.map(note => validateNote(note, item));
    if (new Set(notes.map(note => note.id)).size !== notes.length) throw Error('This backup contains duplicate annotation IDs.');
    return notes;
  }
  function readNotes(item) {
    let raw;
    try { raw = localStorage.getItem(keyFor(item)); }
    catch { throw Error('Browser storage is unavailable. Allow site storage to save annotations.'); }
    if (raw === null) return [];
    try { return validateBundle(JSON.parse(raw), item); }
    catch { throw Error('Saved annotations could not be read. Existing data has been kept; use another browser profile to continue annotating.'); }
  }
  const bundle = (item, notes) => ({version:1, lesson:fingerprint(item), title:item.title, notes});
  function writeNotes(item, notes) {
    validateBundle(bundle(item, notes), item);
    try { localStorage.setItem(keyFor(item), JSON.stringify(bundle(item, notes))); }
    catch { throw Error('Annotations could not be saved in this browser. Free some site storage and try again. Your draft is still open.'); }
  }
  const newId = () => 'note-' + Array.from(crypto.getRandomValues(new Uint8Array(16)), n => n.toString(16).padStart(2,'0')).join('');
  async function request(url, options) {
    const item = await lesson();
    const path = new URL(url, base).pathname;
    if (path === '/api/lesson') return item;
    if (path === '/api/annotations') {
      try { return {notes:readNotes(item)}; }
      catch (error) { warning(error.message); return {notes:[]}; }
    }
    const notes = readNotes(item);
    const value = JSON.parse(options.body);
    if (path === '/api/notes') {
      const note = validateNote({...value, id:value.id || newId()}, item);
      const index = notes.findIndex(existing => existing.id === note.id);
      if (index < 0) notes.push(note); else notes[index] = note;
      writeNotes(item, notes);
      return {notes, note};
    }
    if (path === '/api/notes/delete') {
      const remaining = notes.filter(note => note.id !== value.id);
      writeNotes(item, remaining);
      return {notes:remaining};
    }
    throw Error('This action needs the teacher workstation.');
  }
  function link(page, id, frame) {
    const url = new URL(page, base);
    url.searchParams.set('clip', id);
    if (frame !== undefined) url.searchParams.set('frame', frame);
    return url.href;
  }
  async function exportNotes() {
    const item = await lesson();
    const blob = new Blob([JSON.stringify(bundle(item, readNotes(item)), null, 2)], {type:'application/json'});
    const url = URL.createObjectURL(blob), anchor = document.createElement('a');
    anchor.href = url; anchor.download = `${item.id}-notes.json`; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function importNotes(file) {
    if (!file || file.size > 2 * 1024 * 1024) throw Error('Choose a notes backup smaller than 2 MB.');
    const item = await lesson();
    let data;
    try { data = JSON.parse(await file.text()); }
    catch { throw Error('This file is not a readable notes backup.'); }
    const incoming = validateBundle(data, item), existing = readNotes(item);
    // Keep existing observations; a conflicting import gets its own ID.
    const merged = [...existing];
    for (const note of incoming) {
      if (merged.some(other => JSON.stringify({...other,id:note.id}) === JSON.stringify(note))) continue;
      const match = merged.find(other => other.id === note.id);
      merged.push(match ? {...note, id:newId()} : note);
    }
    writeNotes(item, merged);
    return {notes:merged};
  }
  return {catalog, lesson, request, link, exportNotes, importNotes, warning};
})();

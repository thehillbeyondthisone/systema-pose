'use strict';
(() => {
  const $ = id => document.getElementById(id);
  let lessons = [];
  function icon(kind) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg','svg');
    svg.setAttribute('viewBox','0 0 24 24');
    svg.setAttribute('aria-hidden','true');
    svg.setAttribute('focusable','false');
    const path = document.createElementNS('http://www.w3.org/2000/svg','path');
    path.setAttribute('d',kind === 'play' ? 'M7 4.5 20 12 7 19.5Z' : 'M5 12h14m-6-6 6 6-6 6');
    svg.append(path);
    return svg;
  }
  function list(className,label,items) {
    const element = document.createElement('ul'); element.className = className;
    element.setAttribute('aria-label',label);
    for (const text of items) {
      const item = document.createElement('li'); item.textContent = text; element.append(item);
    }
    return element;
  }
  function render() {
    const query = $('clipSearch').value.trim().toLocaleLowerCase(), category = $('clipCategory').value;
    const visible = lessons.filter(item => (!category || item.category === category) &&
      [item.title,item.description,...item.tags].join(' ').toLocaleLowerCase().includes(query));
    const featured = lessons.length === 1;
    $('libraryTitle').textContent = featured ? 'Featured lesson' : 'Choose a clip';
    $('lessonLibrary').classList.toggle('featured',featured);
    $('lessonLibrary').replaceChildren();
    $('clipCount').textContent = `${visible.length} clip${visible.length === 1 ? '' : 's'}`;
    $('libraryStatus').hidden = visible.length > 0;
    $('libraryStatus').textContent = lessons.length ? 'No clips match. Try another search or footage type.' : 'Class clips are being prepared. Check back soon.';
    for (const item of visible) {
      const card = document.createElement('article'); card.className = 'clip-card';
      const preview = document.createElement('a'); preview.className = 'clip-preview'; preview.href = SystemaSite.link(item.has3d ? 'scene.html' : 'lesson.html',item.id);
      preview.setAttribute('aria-label',`Open ${item.title}`);
      const image = document.createElement('img'); image.src = item.poster; image.alt = ''; image.loading = featured ? 'eager' : 'lazy';
      const play = document.createElement('span'); play.className = 'clip-play'; play.setAttribute('aria-hidden','true'); play.append(icon('play'));
      preview.append(image,play);
      const content = document.createElement('div'); content.className = 'clip-content';
      const meta = document.createElement('p'); meta.className = 'eyebrow'; meta.textContent = `${item.category} · ${item.duration.toFixed(0)} seconds`;
      const heading = document.createElement('h3'); heading.textContent = item.title;
      const description = document.createElement('p'); description.className = 'clip-description'; description.textContent = item.description;
      const tags = list('clip-tags','Topics',item.tags);
      const capabilities = list('clip-capabilities','Study tools',item.has3d ? ['2D motion','3D scene','Contact effects','Annotations'] : ['2D motion','Annotations']);
      const link = document.createElement('a'); link.className = 'file-button'; link.href = preview.href; link.textContent = 'Open lesson'; link.setAttribute('aria-label',`Open lesson: ${item.title}`); link.append(icon('arrow'));
      content.append(meta,heading,description,tags,capabilities,link); card.append(preview,content); $('lessonLibrary').append(card);
    }
  }
  $('clipSearch').addEventListener('input',render); $('clipCategory').addEventListener('change',render);
  SystemaSite.catalog().then(data => {
    lessons = data.lessons;
    $('libraryFilters').hidden = lessons.length === 0;
    $('libraryFilters').open = lessons.length > 1;
    $('libraryFilters').querySelector('summary').hidden = lessons.length > 1;
    render();
  }).catch(() => {
    $('clipCount').textContent = ''; $('libraryStatus').textContent = 'The library could not load. Reload to try again.'; $('libraryStatus').hidden = false;
  });
})();

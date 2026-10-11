'use strict';
(() => {
  const $ = id => document.getElementById(id);
  let lessons = [];
  function render() {
    const query = $('clipSearch').value.trim().toLocaleLowerCase(), category = $('clipCategory').value;
    const visible = lessons.filter(item => (!category || item.category === category) &&
      [item.title,item.description,...item.tags].join(' ').toLocaleLowerCase().includes(query));
    $('lessonLibrary').replaceChildren();
    $('clipCount').textContent = `${visible.length} clip${visible.length === 1 ? '' : 's'}`;
    $('libraryStatus').hidden = visible.length > 0;
    $('libraryStatus').textContent = lessons.length ? 'No clips match. Try another search or footage type.' : 'Class clips are being prepared. Check back soon.';
    for (const item of visible) {
      const card = document.createElement('article'); card.className = 'clip-card';
      const preview = document.createElement('a'); preview.className = 'clip-preview'; preview.href = SystemaSite.link('lesson.html',item.id);
      preview.setAttribute('aria-label',`Open ${item.title}`);
      const image = document.createElement('img'); image.src = item.poster; image.alt = ''; image.loading = 'lazy';
      const play = document.createElement('span'); play.textContent = '▶'; play.className = 'clip-play'; play.setAttribute('aria-hidden','true');
      preview.append(image,play);
      const content = document.createElement('div'); content.className = 'clip-content';
      const meta = document.createElement('p'); meta.className = 'eyebrow'; meta.textContent = `${item.category} · ${item.duration.toFixed(0)} seconds`;
      const heading = document.createElement('h3'); heading.textContent = item.title;
      const description = document.createElement('p'); description.className = 'clip-description'; description.textContent = item.description;
      const tags = document.createElement('p'); tags.className = 'clip-tags'; tags.textContent = item.tags.join(' · ');
      const capabilities = document.createElement('p'); capabilities.className = 'clip-capabilities'; capabilities.textContent = item.has3d ? '2D motion · 3D scene · Contact effects' : '2D motion · Text annotations';
      const link = document.createElement('a'); link.className = 'file-button'; link.href = preview.href; link.textContent = 'Open lesson →';
      content.append(meta,heading,description,tags,capabilities,link); card.append(preview,content); $('lessonLibrary').append(card);
    }
  }
  $('clipSearch').addEventListener('input',render); $('clipCategory').addEventListener('change',render);
  SystemaSite.catalog().then(data => { lessons = data.lessons; render(); }).catch(() => {
    $('clipCount').textContent = ''; $('libraryStatus').textContent = 'The library could not load. Reload to try again.'; $('libraryStatus').hidden = false;
  });
})();

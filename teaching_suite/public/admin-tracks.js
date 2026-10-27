/* Participant corrections are reviewed against the original, unmodified 2D detections. */
class ParticipantEditor {
  constructor({save,onSaved}){
    this.save=save;this.onSaved=onSaved;this.dialog=document.getElementById('participantEditor');
    this.video=document.getElementById('participantVideo');this.canvas=document.getElementById('participantOverlay');this.context=this.canvas.getContext('2d');
    this.rows=document.getElementById('participantRows');this.edits=new Map();this.busy=false;
    document.getElementById('closeParticipants').addEventListener('click',()=>this.close());
    this.dialog.addEventListener('cancel',event=>{if(this.busy)event.preventDefault();else this.video.pause();});
    this.video.addEventListener('timeupdate',()=>this.draw());this.video.addEventListener('seeked',()=>this.draw());this.video.addEventListener('loadedmetadata',()=>this.draw());
    document.getElementById('participantScrub').addEventListener('input',event=>{if(!this.data)return;this.video.currentTime=Number(event.target.value)/this.data.motion.fps;this.draw();});
    document.getElementById('participantPlay').addEventListener('click',()=>{if(this.data)this.video.paused?this.video.play().catch(error=>this.status(error.message,true)):this.video.pause();});
    this.video.addEventListener('play',()=>document.getElementById('participantPlay').textContent='Pause');this.video.addEventListener('pause',()=>document.getElementById('participantPlay').textContent='Play');
    document.getElementById('participantPrevious').addEventListener('click',()=>this.seek(this.frame()-1));
    document.getElementById('participantNext').addEventListener('click',()=>this.seek(this.frame()+1));
    document.getElementById('showExcludedTracks').addEventListener('change',()=>this.draw());
    document.getElementById('includeAllTracks').addEventListener('click',()=>this.reset(false));
    document.getElementById('excludeBriefTracks').addEventListener('click',()=>{if(!this.data||this.busy)return;for(const track of this.data.tracks)if(track.count<2)this.edits.get(track.id).targetId=null;this.renderRows();});
    document.getElementById('resetTrackCorrections').addEventListener('click',()=>this.reset(true));
    document.getElementById('saveParticipants').addEventListener('click',()=>this.commit());
    this.canvas.addEventListener('click',event=>{
      if(!this.data)return;
      const bounds=this.canvas.getBoundingClientRect(),x=(event.clientX-bounds.left)*this.canvas.width/bounds.width,y=(event.clientY-bounds.top)*this.canvas.height/bounds.height;
      const people=this.data.motion.frames[this.frame()]?.people||[];
      const hit=people.filter(person=>person.bbox&&x>=person.bbox[0]&&x<=person.bbox[2]&&y>=person.bbox[1]&&y<=person.bbox[3]).sort((a,b)=>(a.bbox[2]-a.bbox[0])*(a.bbox[3]-a.bbox[1])-(b.bbox[2]-b.bbox[0])*(b.bbox[3]-b.bbox[1]))[0];
      if(hit)this.select(hit.id,false);
    });
    const animate=()=>{if(this.dialog.open&&!this.video.paused)this.draw();requestAnimationFrame(animate);};requestAnimationFrame(animate);
  }
  status(text,error=false){const node=document.getElementById('participantStatus');node.textContent=text;node.dataset.error=String(error);node.setAttribute('role',error?'alert':'status');}
  async open(clip){
    this.clip=clip;this.data=null;this.active=null;this.rows.replaceChildren();this.status('Loading original tracks…');this.video.removeAttribute('src');this.context.clearRect(0,0,this.canvas.width,this.canvas.height);this.dialog.showModal();this.dialog.querySelectorAll('button,input,select').forEach(control=>control.disabled=control.id!=='closeParticipants');document.getElementById('participantSummary').textContent='';
    document.getElementById('participantEditorTitle').textContent='Participants · '+clip.title;
    document.getElementById('saveParticipants').disabled=true;
    try{
      const response=await fetch(`/api/admin/clips/${clip.id}/tracks`,{cache:'no-store'}),data=await response.json();if(!response.ok)throw Error(data.error||'Could not load tracks.');
      if(!this.dialog.open||this.clip.id!==clip.id)return;
      this.data=data;document.getElementById('resolveTrackOverlaps').checked=data.overlapPolicy==='prefer-primary';this.edits=new Map(data.corrections.map(edit=>[edit.sourceId,{...edit}]));
      this.canvas.width=data.motion.width;this.canvas.height=data.motion.height;
      this.video.src=`/admin-assets/${clip.id}/source.mp4`;
      document.getElementById('participantScrub').max=String(data.motion.frames.length-1);
      this.dialog.querySelectorAll('button,input,select').forEach(control=>control.disabled=false);this.renderRows();this.status('Choose who to reconstruct. Join fragments under the same participant ID; trim overlaps or explicitly resolve duplicate boxes after visual review.');
    }catch(error){this.status(error.message,true);}
  }
  close(){if(this.busy)return;this.video.pause();this.dialog.close();}
  frame(){return this.data?Math.max(0,Math.min(this.data.motion.frames.length-1,Math.floor(this.video.currentTime*this.data.motion.fps+0.000001))):0;}
  seek(frame){if(!this.data)return;this.video.pause();this.video.currentTime=Math.max(0,Math.min(this.data.motion.frames.length-1,frame))/this.data.motion.fps;this.draw();}
  reset(original){
    if(!this.data||this.busy)return;
    for(const track of this.data.tracks){const edit=this.edits.get(track.id);edit.targetId=track.id;if(original)Object.assign(edit,{startFrame:track.firstFrame,endFrame:track.lastFrame+1,name:track.name});}
    if(original)document.getElementById('resolveTrackOverlaps').checked=false;this.renderRows();this.status(original?'Original identities and full track ranges restored in this draft. Save to apply.':'All tracks included as separate participants. Save to apply.');
  }
  select(id,seek=true){
    this.active=id;for(const row of this.rows.children)row.dataset.active=String(Number(row.dataset.sourceId)===id);
    const row=document.getElementById('participant-row-'+id);row?.scrollIntoView({block:'nearest'});
    if(seek){const edit=this.edits.get(id),first=this.data.motion.frames.find(frame=>frame.frame>=edit.startFrame&&frame.frame<edit.endFrame&&frame.people.some(person=>person.id===id));if(first)this.seek(first.frame);else this.status('This track has no detections in the selected time range.',true);}else this.draw();
  }
  renderRows(){
    this.rows.replaceChildren();const make=(tag,text)=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=text;return node;};
    for(const track of this.data.tracks){
      const edit=this.edits.get(track.id),row=make('tr');row.dataset.sourceId=track.id;row.id='participant-row-'+track.id;row.dataset.active=String(this.active===track.id);
      const includeCell=make('td'),include=make('input');include.type='checkbox';include.checked=edit.targetId!==null;include.setAttribute('aria-label','Include track '+track.id);include.dataset.includeTrack=track.id;
      include.addEventListener('change',()=>{edit.targetId=include.checked?track.id:null;this.renderRows();});includeCell.append(include);row.append(includeCell);
      const source=make('td'),jump=make('button','Track '+track.id);jump.type='button';jump.dataset.seekTrack=track.id;jump.addEventListener('click',()=>this.select(track.id));
      source.append(jump,make('small',`${track.count} frame${track.count===1?'':'s'} · ${(track.firstFrame/this.data.motion.fps).toFixed(2)}–${((track.lastFrame+1)/this.data.motion.fps).toFixed(2)}s`));row.append(source);
      const identityCell=make('td'),identity=make('select');identity.setAttribute('aria-label','Participant for track '+track.id);identity.dataset.targetTrack=track.id;identity.disabled=edit.targetId===null;
      for(const other of this.data.tracks){const option=make('option',`ID ${other.id} · ${this.edits.get(other.id).name}`);option.value=String(other.id);identity.append(option);}identity.value=String(edit.targetId??track.id);
      identity.addEventListener('change',()=>{edit.targetId=Number(identity.value);this.renderRows();});identityCell.append(identity);row.append(identityCell);
      const nameCell=make('td'),name=make('input');name.type='text';name.maxLength=80;name.value=this.edits.get(edit.targetId??track.id).name;name.disabled=edit.targetId===null;name.setAttribute('aria-label','Name for track '+track.id);name.dataset.trackName=track.id;
      name.addEventListener('input',()=>{this.edits.get(edit.targetId).name=name.value;for(const input of this.rows.querySelectorAll('[data-track-name]'))if(this.edits.get(Number(input.dataset.trackName)).targetId===edit.targetId)input.value=name.value;this.draw();});nameCell.append(name);row.append(nameCell);
      for(const [field,label] of [['startFrame','Start'],['endFrame','End']]){
        const cell=make('td'),input=make('input');input.type='number';input.min='0';input.max=String(this.data.motion.frames.length/this.data.motion.fps);input.step=String(1/this.data.motion.fps);input.value=(edit[field]/this.data.motion.fps).toFixed(3);input.disabled=edit.targetId===null;input.setAttribute('aria-label',`${label} seconds for track ${track.id}`);input.dataset[field]=track.id;
        input.addEventListener('change',()=>{edit[field]=Math.round(Number(input.value)*this.data.motion.fps);this.summary();this.draw();});
        const mark=make('button',label==='Start'?'Set start here':'Set end here');mark.type='button';mark.disabled=edit.targetId===null;mark.addEventListener('click',()=>{edit[field]=this.frame()+(field==='endFrame'?1:0);this.renderRows();});cell.append(input,mark);row.append(cell);
      }
      this.rows.append(row);
    }
    this.summary();this.draw();
  }
  summary(){
    const included=[...this.edits.values()].filter(edit=>edit.targetId!==null),identities=new Set(included.map(edit=>edit.targetId));
    document.getElementById('participantSummary').textContent=`${this.data.tracks.length} source tracks · ${included.length} included · ${identities.size} participants after joining · ${this.data.tracks.length-included.length} excluded`;
  }
  draw(){
    if(!this.data)return;const ctx=this.context,index=this.frame(),frame=this.data.motion.frames[index];ctx.clearRect(0,0,this.canvas.width,this.canvas.height);
    document.getElementById('participantScrub').value=String(index);document.getElementById('participantFrame').textContent=`Frame ${index+1} / ${this.data.motion.frames.length} · ${(index/this.data.motion.fps).toFixed(2)}s`;
    for(const person of frame?.people||[]){
      const edit=this.edits.get(person.id);if(!edit||!person.bbox)continue;const included=edit.targetId!==null&&index>=edit.startFrame&&index<edit.endFrame;
      if(!included&&!document.getElementById('showExcludedTracks').checked)continue;
      const [x,y,right,bottom]=person.bbox,color=included?(this.data.tracks.find(track=>track.id===edit.targetId)?.color||'#ffda47'):'#aab4bf';
      ctx.strokeStyle=this.active===person.id?'#ffffff':color;ctx.lineWidth=Math.max(2,this.canvas.width/400)*(this.active===person.id?2:1);ctx.setLineDash(included?[]:[10,6]);ctx.strokeRect(x,y,right-x,bottom-y);ctx.setLineDash([]);
      const label=`${included?(this.edits.get(edit.targetId).name||'Participant '+edit.targetId):'Excluded'} · track ${person.id}`;ctx.font=`bold ${Math.max(14,this.canvas.width/65)}px sans-serif`;const textWidth=ctx.measureText(label).width;const textY=Math.max(22,y);ctx.fillStyle='rgba(10,20,30,.88)';ctx.fillRect(x,textY-24,textWidth+12,28);ctx.fillStyle=color;ctx.fillText(label,x+6,textY-4);
    }
  }
  async commit(){
    if(this.busy||!this.data)return;this.busy=true;this.video.pause();this.dialog.querySelectorAll('button,input,select').forEach(input=>input.disabled=true);this.status('Saving participant corrections…');
    try{
      const result=await this.save(`clips/${this.clip.id}/tracks`,{revision:this.data.revision,overlapPolicy:document.getElementById('resolveTrackOverlaps').checked?'prefer-primary':'reject',corrections:[...this.edits.values()]});
      await this.onSaved(result);this.busy=false;this.dialog.close();
    }catch(error){this.status(error.message,true);document.getElementById('participantStatus').focus();}
    finally{this.busy=false;this.dialog.querySelectorAll('button,input,select').forEach(input=>input.disabled=false);this.renderRows();}
  }
}

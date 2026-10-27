import * as THREE from 'three';
import {validAlignment, DEFAULT_ALIGNMENT} from './studio-registration.mjs';

const $=id=>document.getElementById(id);
const fields=['x','y','z','pitch','yaw','roll','scale'];
const degrees=180/Math.PI;

export class StudioEnvironment {
  constructor({world,renderer,camera,orbit,canvas,grid,motion,configUrl,onChange,initialFrame=0}){
    Object.assign(this,{world,renderer,camera,orbit,canvas,grid,motion,configUrl,onChange});
    this.group=new THREE.Group();world.add(this.group);
    this.alignment={...DEFAULT_ALIGNMENT};this.ready=false;this.visible=false;this.xray=true;this.pickPoints=[];
    this.frame=initialFrame;
    this.markers=new THREE.Group();world.add(this.markers);
    this.status=$('studioStatus');this.status.textContent='Loading studio scan…';
    this.bind();this.load();
  }
  async load(){
    $('studioRetry').hidden=true;
    try{
      const response=await fetch(this.configUrl,{cache:'no-store'});
      if(!response.ok)throw Error('Studio configuration is missing.');
      const config=await response.json();
      if(config.schemaVersion!==1||!config.asset||!validAlignment(config.alignment))throw Error('Invalid studio configuration.');
      if(config.shots){
        let end=0;
        if(!Array.isArray(config.shots)||!config.shots.length)throw Error('Invalid studio shot placements.');
        for(const shot of config.shots){
          if(!Number.isInteger(shot.startFrame)||!Number.isInteger(shot.endFrame)||shot.startFrame!==end||shot.endFrame<=end||!validAlignment(shot.alignment))throw Error('Invalid studio shot placements.');
          end=shot.endFrame;
        }
        if(end!==this.motion.frames.length)throw Error('Studio shot placements do not cover this lesson.');
      }
      this.config=config;
      this.calibrationId=config.calibration?.id||null;
      this.matched=Boolean(this.calibrationId&&this.calibrationId===this.motion.roomCalibration?.id);
      this.baseKey=`systema-studio-v2:${this.motion.sourceSha256}:${config.id}:${this.calibrationId||'unregistered'}`;
      this.placement=null;this.syncFrame(this.frame);
      this.fill();this.updateCalibrationLabel();
      const {SparkRenderer,SplatMesh,dyno}=await import('./vendor/spark/spark.module.js');
      const asset=new URL(config.asset,new URL(this.configUrl,location.href));
      if(config.sourceSha256)asset.searchParams.set('v',config.sourceSha256);
      const assetUrl=asset.href;
      // Distinguish a missing local asset before starting the decoder worker.
      const probe=await fetch(assetUrl,{method:'HEAD'});
      if(!probe.ok)throw Error('Prepare the studio scan with work/prepare_studio.py, then choose Retry.');
      this.spark??=new SparkRenderer({renderer:this.renderer,minSortIntervalMs:24});
      // The scan already contains its photographed exposure and lighting.
      this.spark.material.toneMapped=false;
      if(!this.spark.parent)this.world.add(this.spark);
      this.mesh=new SplatMesh({url:assetUrl,minRaycastOpacity:.04,onProgress:event=>{
        if(event.total)this.status.textContent=`Loading studio scan · ${Math.round(event.loaded/event.total*100)}%`;
      }});
      this.group.add(this.mesh);await this.mesh.initialized;
      this.installCutaway(dyno);
      this.ready=true;this.visible=$('studioVisible').checked;
      $('studioControls').disabled=false;this.apply();
      this.status.textContent=this.readyMessage();
      this.status.dataset.state='ready';
      this.canvas.dataset.studioReady='true';
    }catch(error){
      this.mesh?.removeFromParent();this.mesh?.dispose();this.mesh=null;
      this.ready=false;this.visible=false;this.group.visible=false;this.grid.visible=true;
      this.status.textContent=error.message;this.status.dataset.state='error';
      $('studioRetry').hidden=false;$('studioControls').disabled=true;this.onChange();
    }
  }
  installCutaway(dyno){
    const focus=new dyno.DynoVec3({value:new THREE.Vector3()}),direction=new dyno.DynoVec3({value:new THREE.Vector3(0,0,1)});
    const floor=new dyno.DynoVec4({value:new THREE.Vector4(0,1,0,0)}),strength=new dyno.DynoFloat({value:0});
    this.cutaway={focus,direction,floor,strength};
    this.mesh.worldModifier=dyno.dynoBlock({gsplat:dyno.Gsplat},{gsplat:dyno.Gsplat},({gsplat})=>({gsplat:new dyno.Dyno({
      inTypes:{gsplat:dyno.Gsplat,focus:'vec3',direction:'vec3',floor:'vec4',strength:'float'},outTypes:{gsplat:dyno.Gsplat},
      inputs:{gsplat,focus,direction,floor,strength},
      statements:({inputs:i,outputs:o})=>[
        `${o.gsplat} = ${i.gsplat};`,
        `${o.gsplat}.rgba.a *= 1.0 - ${i.strength} * smoothstep(0.45, 0.85, dot(${i.gsplat}.center - ${i.focus}, ${i.direction})) * smoothstep(0.08, 0.25, dot(vec4(${i.gsplat}.center, 1.0), ${i.floor}));`,
      ],
    }).outputs.gsplat}));
    this.mesh.updateGenerator();
  }
  syncCutaway({enabled,focus}){
    if(!this.ready||!this.cutaway)return;
    const active=enabled&&this.visible,nextStrength=active?1:0,{cutaway}=this;
    if(!active&&cutaway.strength.value===0)return;
    const direction=this.camera.position.clone().sub(focus).normalize();
    this.group.updateWorldMatrix(true,false);
    const nav=this.config.navigation,normal=new THREE.Vector3(0,1,0),point=new THREE.Vector3();
    if(nav?.coordinateSpace==='scan-local'&&Number.isFinite(nav.min?.[2])){
      normal.set(0,0,1).applyNormalMatrix(new THREE.Matrix3().getNormalMatrix(this.group.matrixWorld));
      point.set(0,0,nav.min[2]).applyMatrix4(this.group.matrixWorld);
    }
    const floor=new THREE.Vector4(normal.x,normal.y,normal.z,-normal.dot(point));
    if(cutaway.strength.value===nextStrength&&cutaway.focus.value.distanceToSquared(focus)<1e-10&&cutaway.direction.value.distanceToSquared(direction)<1e-10&&cutaway.floor.value.clone().sub(floor).lengthSq()<1e-10)return;
    cutaway.strength.value=nextStrength;cutaway.focus.value.copy(focus);cutaway.direction.value.copy(direction);cutaway.floor.value.copy(floor);
    // Only regenerate when the view changes; normal paused frames reuse the
    // scan buffers. The floor and far walls retain their original appearance.
    this.mesh.updateVersion();
  }
  bind(){
    window.addEventListener('message',event=>{
      if(window.parent===window||event.source!==window.parent||event.origin!==location.origin||event.data?.type!=='systema-room-placement-request'||!this.ready)return;
      event.source.postMessage({type:'systema-room-placement',requestId:event.data.requestId,record:this.record()},event.origin);
    });
    for(const field of fields)$('studio-'+field).addEventListener('change',()=>{
      const next=Object.fromEntries(fields.map(key=>[key,Number($('studio-'+key).value)]));
      if(!validAlignment(next)){this.status.textContent='Use finite values within the alignment limits.';this.fill();return;}
      this.alignment=next;this.cancelPick();this.apply();this.save();this.status.textContent='Custom alignment saved. Restore calibration to return to the footage match.';
    });
    $('studioVisible').addEventListener('change',()=>{
      this.visible=$('studioVisible').checked;this.cancelPick();this.apply();
    });
    $('studioOpacity').addEventListener('input',()=>this.apply());
    $('studioGrid').addEventListener('change',()=>this.apply());
    $('studioXray').addEventListener('change',()=>{this.xray=$('studioXray').checked;this.onChange();});
    $('studioReset').addEventListener('click',()=>{
      this.alignment={...this.placement.alignment};this.cancelPick();this.apply();this.save();
      this.status.textContent=this.matched?'Matched studio calibration restored.':'Initial studio alignment restored.';
    });
    $('studioRetry').addEventListener('click',()=>this.load());
    $('studioFloor').addEventListener('click',()=>{
      if(this.picking){this.cancelPick();return;}
      if(!this.visible){this.status.textContent='Show the studio before selecting its floor.';return;}
      this.pickPoints=[];this.picking=true;$('studioFloor').textContent='Cancel floor selection';
      this.status.textContent='Click three widely spaced points on the studio floor. Drag still orbits.';
    });
    this.canvas.addEventListener('pointerdown',event=>{this.down=[event.clientX,event.clientY];});
    this.canvas.addEventListener('pointerup',event=>{
      if(!this.picking||!this.down||Math.hypot(event.clientX-this.down[0],event.clientY-this.down[1])>5)return;
      this.pickFloor(event);
    });
    $('studioExport').addEventListener('click',()=>{
      const record=this.record();
      const url=URL.createObjectURL(new Blob([JSON.stringify(record,null,2)+'\n'],{type:'application/json'}));
      const link=document.createElement('a');link.href=url;link.download='studio-alignment.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    });
    $('studioImport').addEventListener('change',async event=>{
      try{
        const file=event.target.files[0];if(!file)return;if(file.size>20000)throw Error('Alignment file is too large.');
        const value=JSON.parse(await file.text());
        if(!this.matchesRecord(value))throw Error('Alignment does not match this studio calibration and lesson.');
        this.alignment={...value.alignment};this.cancelPick();this.apply();this.save();this.status.textContent='Alignment imported for this studio calibration. Compare it with the footage.';
      }catch(error){this.status.textContent=error.message;}finally{event.target.value='';}
    });
  }
  syncFrame(frame){
    this.frame=frame;if(!this.config)return;
    const placement=this.config.shots?.find(shot=>shot.startFrame<=frame&&frame<shot.endFrame)||this.config;
    if(this.placement===placement)return;
    this.placement=placement;this.key=this.baseKey+(this.config.shots?`:${placement.startFrame}-${placement.endFrame}`:'');
    this.alignment={...placement.alignment};
    try{const saved=JSON.parse(localStorage.getItem(this.key));if(this.matchesRecord(saved))this.alignment={...saved.alignment};}catch{}
    this.cancelPick();this.apply(false);
  }
  record(){return {schemaVersion:2,studio:this.config.id,sourceSha256:this.motion.sourceSha256,calibrationId:this.calibrationId,shotStartFrame:this.config.shots?this.placement.startFrame:null,alignment:{...this.alignment}};}
  matchesRecord(value){
    return Boolean(value&&[1,2].includes(value.schemaVersion)&&value.studio===this.config.id&&
      value.sourceSha256===this.motion.sourceSha256&&(value.calibrationId||null)===this.calibrationId&&
      (value.shotStartFrame??null)===(this.config.shots?this.placement.startFrame:null)&&validAlignment(value.alignment));
  }
  readyMessage(){
    if(!this.matched)return 'Studio loaded · alignment estimate. Compare it with the footage.';
    const residuals=this.config.calibration.residualPixels;
    const residual=typeof residuals==='number'?residuals:residuals?.medianAnchorRms;
    return `Studio matched to footage${Number.isFinite(residual)?` · ${residual.toFixed(1)} px median fitted room landmark error`:''}. Figure scale remains a model estimate.`;
  }
  updateCalibrationLabel(){
    const custom=fields.some(key=>Math.abs(this.alignment[key]-this.placement.alignment[key])>1e-8);
    $('studioBadge').textContent=custom?'Custom alignment':this.matched?'Matched to footage':'Alignment estimate';
    $('studioBadge').classList.toggle('calibrated',this.matched&&!custom);
    $('studioCalibrationHelp').textContent=this.matched
      ? 'The studio and source camera are matched to room landmarks in the footage. Figure size and depth use model estimates; room dimensions have not been physically measured. Turn off Figures through walls to study occlusion.'
      : 'The scan is fixed in 3D while the figures follow the reconstructed motion. Match the floor, room size and orientation against the footage. Turn off Figures through walls to study occlusion.';
    $('studioReset').textContent=this.matched?'Restore calibration':'Reset alignment';
  }
  fill(){for(const key of fields)$('studio-'+key).value=String(Math.round(this.alignment[key]*10000)/10000);}
  apply(notify=true){
    const a=this.alignment;this.group.position.set(a.x,a.y,a.z);
    this.group.rotation.set(a.pitch/degrees,a.yaw/degrees,a.roll/degrees,'YXZ');this.group.scale.setScalar(a.scale);
    this.group.visible=this.visible&&this.ready;
    if(this.mesh)this.mesh.opacity=Number($('studioOpacity').value);
    this.grid.visible=!this.visible||!this.ready||$('studioGrid').checked;
    this.fill();this.updateCalibrationLabel();if(notify)this.onChange();
  }
  save(){try{localStorage.setItem(this.key,JSON.stringify(this.record()));}catch{this.status.textContent='Browser storage is unavailable. Export alignment to keep it.';}}
  cancelPick(){
    this.picking=false;this.pickPoints=[];$('studioFloor').textContent='Pick three floor points';
    for(const child of [...this.markers.children]){child.geometry.dispose();child.material.dispose();child.removeFromParent();}
  }
  pickFloor(event){
    const rect=this.canvas.getBoundingClientRect();
    if(!rect.width||!rect.height||event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)return;
    const pointer=new THREE.Vector2((event.clientX-rect.left)/rect.width*2-1,-(event.clientY-rect.top)/rect.height*2+1);
    const ray=new THREE.Raycaster();ray.setFromCamera(pointer,this.camera);ray.near=.25;ray.far=100;this.world.updateMatrixWorld(true);
    const hit=ray.intersectObject(this.mesh,false)[0];
    if(!hit){this.status.textContent='No studio surface there. Pick a visible point on the floor.';return;}
    this.pickPoints.push(hit.point.clone());
    const marker=new THREE.Mesh(new THREE.SphereGeometry(.035,12,8),new THREE.MeshBasicMaterial({color:'#ffe17a',depthTest:false}));
    marker.position.copy(hit.point);marker.renderOrder=999;this.markers.add(marker);
    if(this.pickPoints.length<3){this.status.textContent=`Floor point ${this.pickPoints.length} of 3 selected.`;return;}
    const [a,b,c]=this.pickPoints;const normal=b.clone().sub(a).cross(c.clone().sub(a));
    if(normal.length()<.015){this.cancelPick();this.status.textContent='Those points are too close or lie on a line. Try a wider triangle.';return;}
    normal.normalize();if(normal.y<0)normal.negate();
    const rotation=new THREE.Quaternion().setFromUnitVectors(normal,new THREE.Vector3(0,1,0));
    const position=this.group.position.clone().applyQuaternion(rotation);position.y-=a.clone().applyQuaternion(rotation).y;
    const quaternion=this.group.quaternion.clone().premultiply(rotation),euler=new THREE.Euler().setFromQuaternion(quaternion,'YXZ');
    this.alignment={x:position.x,y:position.y,z:position.z,pitch:euler.x*degrees,yaw:euler.y*degrees,roll:euler.z*degrees,scale:this.alignment.scale};
    this.cancelPick();this.apply();this.save();this.status.textContent='Selected floor aligned to the motion ground. Check room size and position against the footage.';
  }
}

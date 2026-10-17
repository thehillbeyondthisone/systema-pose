import * as THREE from 'three';
import {validAlignment, DEFAULT_ALIGNMENT} from './studio-registration.mjs';

const $=id=>document.getElementById(id);
const fields=['x','y','z','pitch','yaw','roll','scale'];
const degrees=180/Math.PI;

export class StudioEnvironment {
  constructor({world,renderer,camera,orbit,canvas,grid,motion,configUrl,onChange}){
    Object.assign(this,{world,renderer,camera,orbit,canvas,grid,motion,configUrl,onChange});
    this.group=new THREE.Group();world.add(this.group);
    this.alignment={...DEFAULT_ALIGNMENT};this.ready=false;this.visible=false;this.xray=true;this.pickPoints=[];
    this.markers=new THREE.Group();world.add(this.markers);
    this.status=$('studioStatus');this.status.textContent='Loading studio scan…';
    this.bind();this.load();
  }
  async load(){
    $('studioRetry').hidden=true;
    try{
      const response=await fetch(this.configUrl);
      if(!response.ok)throw Error('Studio configuration is missing.');
      const config=await response.json();
      if(config.schemaVersion!==1||!config.asset||!validAlignment(config.alignment))throw Error('Invalid studio configuration.');
      this.config=config;
      this.key=`systema-studio-v1:${this.motion.sourceSha256}:${config.id}`;
      this.alignment={...config.alignment};
      try{const saved=JSON.parse(localStorage.getItem(this.key));if(validAlignment(saved))this.alignment=saved;}catch{}
      const {SparkRenderer,SplatMesh}=await import('./vendor/spark/spark.module.js');
      const assetUrl=new URL(config.asset,new URL(this.configUrl,location.href)).href;
      // Distinguish a missing local asset before starting the decoder worker.
      const probe=await fetch(assetUrl,{method:'HEAD'});
      if(!probe.ok)throw Error('Prepare the studio scan with work/prepare_studio.py, then choose Retry.');
      this.spark??=new SparkRenderer({renderer:this.renderer,minSortIntervalMs:24});
      if(!this.spark.parent)this.world.add(this.spark);
      this.mesh=new SplatMesh({url:assetUrl,minRaycastOpacity:.04,onProgress:event=>{
        if(event.total)this.status.textContent=`Loading studio scan · ${Math.round(event.loaded/event.total*100)}%`;
      }});
      this.group.add(this.mesh);await this.mesh.initialized;
      this.ready=true;this.visible=$('studioVisible').checked;
      $('studioControls').disabled=false;this.apply();
      this.status.textContent='Studio loaded · approximate placement. Align against the footage.';
      this.status.dataset.state='ready';
      this.canvas.dataset.studioReady='true';
    }catch(error){
      this.mesh?.removeFromParent();this.mesh?.dispose();this.mesh=null;
      this.ready=false;this.visible=false;this.group.visible=false;this.grid.visible=true;
      this.status.textContent=error.message;this.status.dataset.state='error';
      $('studioRetry').hidden=false;$('studioControls').disabled=true;this.onChange();
    }
  }
  bind(){
    for(const field of fields)$('studio-'+field).addEventListener('change',()=>{
      const next=Object.fromEntries(fields.map(key=>[key,Number($('studio-'+key).value)]));
      if(!validAlignment(next)){this.status.textContent='Use finite values within the alignment limits.';this.fill();return;}
      this.alignment=next;this.cancelPick();this.apply();this.save();
    });
    $('studioVisible').addEventListener('change',()=>{
      this.visible=$('studioVisible').checked;this.cancelPick();this.apply();
    });
    $('studioOpacity').addEventListener('input',()=>this.apply());
    $('studioGrid').addEventListener('change',()=>this.apply());
    $('studioXray').addEventListener('change',()=>{this.xray=$('studioXray').checked;this.onChange();});
    $('studioReset').addEventListener('click',()=>{
      this.alignment={...this.config.alignment};this.cancelPick();this.apply();this.save();
      this.status.textContent='Initial approximate alignment restored.';
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
      const record={schemaVersion:1,studio:this.config.id,sourceSha256:this.motion.sourceSha256,alignment:this.alignment};
      const url=URL.createObjectURL(new Blob([JSON.stringify(record,null,2)+'\n'],{type:'application/json'}));
      const link=document.createElement('a');link.href=url;link.download='studio-alignment.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    });
    $('studioImport').addEventListener('change',async event=>{
      try{
        const file=event.target.files[0];if(!file)return;if(file.size>20000)throw Error('Alignment file is too large.');
        const value=JSON.parse(await file.text());
        if(value.schemaVersion!==1||value.studio!==this.config.id||value.sourceSha256!==this.motion.sourceSha256||!validAlignment(value.alignment))throw Error('Alignment does not match this studio and lesson.');
        this.alignment={...value.alignment};this.cancelPick();this.apply();this.save();this.status.textContent='Alignment imported. Compare it with the source footage.';
      }catch(error){this.status.textContent=error.message;}finally{event.target.value='';}
    });
  }
  fill(){for(const key of fields)$('studio-'+key).value=String(Math.round(this.alignment[key]*10000)/10000);}
  apply(){
    const a=this.alignment;this.group.position.set(a.x,a.y,a.z);
    this.group.rotation.set(a.pitch/degrees,a.yaw/degrees,a.roll/degrees,'YXZ');this.group.scale.setScalar(a.scale);
    this.group.visible=this.visible&&this.ready;
    if(this.mesh)this.mesh.opacity=Number($('studioOpacity').value);
    this.grid.visible=!this.visible||!this.ready||$('studioGrid').checked;
    this.fill();this.onChange();
  }
  save(){try{localStorage.setItem(this.key,JSON.stringify(this.alignment));}catch{this.status.textContent='Browser storage is unavailable. Export alignment to keep it.';}}
  cancelPick(){
    this.picking=false;this.pickPoints=[];$('studioFloor').textContent='Pick three floor points';
    for(const child of [...this.markers.children]){child.geometry.dispose();child.material.dispose();child.removeFromParent();}
  }
  pickFloor(event){
    const rect=this.canvas.getBoundingClientRect();
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

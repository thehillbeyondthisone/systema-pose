// Focused CPU skinning and real WebGL smoke checks for the procedural body rig.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const http=require('node:http');
const path=require('node:path');
const os=require('node:os');
const {chromium}=require(process.env.SYSTEMA_PLAYWRIGHT||'C:/Users/thefo/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const root=path.resolve(__dirname,'..'),publicRoot=path.join(root,'teaching_suite/public');
const fixture=`<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:#101b23}canvas{display:block}</style><script type="importmap">{"imports":{"three":"/vendor/three/three.module.js"}}</script></head><body><script type="module">
import * as THREE from 'three';
import {FigureRig} from '/figure-rig.js';
window.THREE=THREE;window.FigureRig=FigureRig;window.motion=await (await fetch('/motion.json')).json();window.ready=true;
</script></body></html>`;
const errors=[];
const server=http.createServer((request,response)=>{
  const pathname=new URL(request.url,'http://localhost').pathname;
  if(pathname==='/'){response.setHeader('content-type','text/html');response.end(fixture);return;}
  const filename=pathname==='/motion.json'?path.join(root,'outputs/3d-pilot/scene.json'):path.join(publicRoot,pathname);
  if(pathname!=='/motion.json'&&!filename.startsWith(publicRoot+path.sep)){response.writeHead(403);response.end();return;}
  try{response.setHeader('content-type',filename.endsWith('.js')?'application/javascript':'application/json');response.end(fs.readFileSync(filename));}
  catch{response.writeHead(404);response.end();}
});
(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const browser=await chromium.launch({channel:'msedge',headless:true});
  try{
    const page=await browser.newPage({viewport:{width:1280,height:900}});page.on('pageerror',error=>errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);await page.waitForFunction(()=>window.ready);
    const result=await page.evaluate(()=>{
      const {THREE,FigureRig,motion}=window;
      const check=(value,message)=>{if(!value)throw Error(message);};
      const rig=new FigureRig({jointNames:motion.jointNames,edges:motion.edges,color:motion.people[0].color});
      check(rig.mesh.isSkinnedMesh,'Visible body must be an actual SkinnedMesh');
      check(rig.skeleton.bones.length===22,'Must bind all 22 recorded body joints');
      check(rig.skeleton.bones.every(bone=>bone.isBone),'Skeleton must contain THREE.Bones');
      check(rig.group.children.filter(object=>object.isMesh).length===1,'Visible character must be one merged skin');
      const weights=rig.geometry.attributes.skinWeight;
      for(let vertex=0;vertex<weights.count;vertex++)check(Math.abs(weights.getX(vertex)+weights.getY(vertex)+weights.getZ(vertex)+weights.getW(vertex)-1)<1e-6,'Skin weights normalized');
      const skin=rig.geometry.attributes.skinIndex,blended={};
      for(const joint of [4,5,16,17,18,19]){
        const count=Array.from({length:weights.count},(_,i)=>i).filter(i=>rig.vertexKinds[i]==='body'&&weights.getY(i)>.05&&weights.getY(i)<.95&&skin.getY(i)===joint).length;
        check(count>=16,`Joint ${joint} needs a deforming band spanning both adjacent bones`);blended[joint]=count;
      }
      // Each arm/leg is one indexed surface instead of independent cylinders
      // meeting at floating spheres. Check actual triangle connectivity.
      const parent=Array.from({length:weights.count},(_,i)=>i),find=i=>parent[i]===i?i:(parent[i]=find(parent[i]));
      const triangles=rig.geometry.index.array;
      for(let i=0;i<triangles.length;i+=3){const a=triangles[i],b=triangles[i+1],c=triangles[i+2];if(rig.vertexKinds[a]==='body'&&rig.vertexKinds[b]==='body'&&rig.vertexKinds[c]==='body'){parent[find(b)]=find(a);parent[find(c)]=find(a);}}
      const components=new Map();for(let i=0;i<parent.length;i++)if(rig.vertexKinds[i]==='body'){const key=find(i);components.set(key,(components.get(key)||0)+1);}
      check([...components.values()].filter(count=>count>100).length===4,'Four connected limb skins must span shoulders/elbows and hips/knees');
      const point=new THREE.Vector3();let maxJointError=0,updates=0;
      for(const frame of motion.frames)for(const person of frame.people){
        check(rig.update(person.xyz),'Valid reconstruction frame must update');updates++;
        rig.bones.forEach((bone,index)=>{
          bone.getWorldPosition(point);maxJointError=Math.max(maxJointError,point.distanceTo(new THREE.Vector3(...person.xyz[index])));
        });
      }
      check(maxJointError<1e-8,`Tracked joints drifted by ${maxJointError}`);
      check(rig.group.scale.equals(new THREE.Vector3(1,1,1)),'Figure group must never inherit segment scaling');
      const first=motion.frames[0].people[0].xyz,last=motion.frames[motion.frames.length-1].people[0].xyz;
      rig.update(first);const firstVertex=rig.mesh.getVertexPosition(0,new THREE.Vector3());
      rig.update(last);const lastVertex=rig.mesh.getVertexPosition(0,new THREE.Vector3());
      check(firstVertex.distanceTo(lastVertex)>.01,'Skinned vertices must actually follow the animation');
      rig.update(first);check(rig.mesh.getVertexPosition(0,new THREE.Vector3()).distanceTo(firstVertex)<1e-8,'Seeking back must be deterministic');
      const geometry=rig.mesh.geometry,skeleton=rig.skeleton,plain=Array.from(geometry.attributes.color.array);
      rig.setStyle('dummy');check(rig.mesh.geometry===geometry&&rig.skeleton===skeleton,'Style switching must preserve mesh and pose');
      check(plain.some((value,index)=>Math.abs(value-geometry.attributes.color.array[index])>.01),'Dummy must have a distinct palette');
      rig.update(first,{highlightJoint:'left_elbow',intensity:.85,opacity:.65,xray:true});
      check(rig.highlightJoint===18&&rig.intensity===.85,'Joint annotation maps names to correct SMPL region');
      check(!rig.material.depthTest&&!rig.material.depthWrite&&rig.mesh.renderOrder===1000,'X-ray makes the body readable inside the scan');
      check(rig.material.opacity===.65,'Tracking confidence opacity must persist');
      const broken=first.map(xyz=>[...xyz]);broken[3]=[NaN,0,0];broken[4]=[...broken[1]];
      check(rig.update(broken),'Partial and coincident joints should remain usable');
      for(let vertex=0;vertex<geometry.attributes.position.count;vertex+=17){
        rig.mesh.getVertexPosition(vertex,point);check(point.toArray().every(Number.isFinite),'Malformed joints must not create non-finite skin vertices');
      }
      check(!rig.update(null),'Missing poses should be safely ignored');
      rig.update(first,{color:motion.people[0].color,opacity:1,xray:false,highlightJoint:-1});rig.setStyle('mannequin');
      const world=new THREE.Scene();world.background=new THREE.Color('#101b23');world.add(new THREE.HemisphereLight(0xe9f3ff,0x3b4350,2.1));
      const key=new THREE.DirectionalLight(0xffe5cf,3);key.position.set(-3,5,4);world.add(key);
      const renderer=new THREE.WebGLRenderer({antialias:true});renderer.setSize(1280,900);renderer.setPixelRatio(1);document.body.append(renderer.domElement);
      const display=[];
      for(let index=0;index<4;index++){
        const body=new FigureRig({jointNames:motion.jointNames,edges:motion.edges,color:motion.people[index].color});
        body.setStyle(index%2?'dummy':'mannequin');
        const id=motion.people[index].id;
        const source=motion.frames[index===2?120:0].people.find(person=>person.id===id)||motion.frames.flatMap(frame=>frame.people).find(person=>person.id===id);
        const shifted=source.xyz.map(xyz=>[xyz[0]-source.xyz[0][0]+(index-1.5)*.85,xyz[1],xyz[2]-source.xyz[0][2]]);
        body.update(shifted,{highlightJoint:index===3?'spine2':-1,intensity:.8});world.add(body.group);display.push(body);
      }
      const camera=new THREE.PerspectiveCamera(36,1280/900,.01,50);camera.position.set(2.6,2.4,5);camera.lookAt(0,.95,0);
      renderer.render(world,camera);check(renderer.info.render.triangles>1000,'Actual GPU draw must include visible skinned geometry');
      window.rigTest={world,renderer,display,rig};
      return {boneCount:22,vertices:geometry.attributes.position.count,triangles:geometry.index.count/3,blended,poseUpdates:updates,maxJointError,drawTriangles:renderer.info.render.triangles};
    });
    assert.deepEqual(errors,[]);console.log(JSON.stringify(result,null,2));
    const screenshot=path.join(os.tmpdir(),'systema-figure-rig.png');await page.screenshot({path:screenshot});console.log('Screenshot '+screenshot);
  }finally{await browser.close();server.close();}
})().catch(error=>{console.error(error);server.close();process.exitCode=1;});

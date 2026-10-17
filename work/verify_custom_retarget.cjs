// Focused invariants for the real GLB loader and captured-motion retargeter.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {pathToFileURL}=require('node:url'),{registerHooks}=require('node:module');
const ROOT=path.resolve(__dirname,'..');
registerHooks({resolve(specifier,context,next){return specifier==='three'?{url:pathToFileURL(path.join(ROOT,'teaching_suite/public/vendor/three/three.module.js')).href,shortCircuit:true}:next(specifier,context);}});
globalThis.self=globalThis;
function glbDocument(buffer){const length=buffer.readUInt32LE(12);return JSON.parse(buffer.subarray(20,20+length).toString());}
function rewriteGLB(buffer,edit){
 const document=glbDocument(buffer);edit(document);
 const oldLength=buffer.readUInt32LE(12),bin=buffer.subarray(20+oldLength);
 const raw=Buffer.from(JSON.stringify(document)),json=Buffer.concat([raw,Buffer.alloc((4-raw.length%4)%4,32)]);
 const header=Buffer.from(buffer.subarray(0,20));header.writeUInt32LE(20+json.length+bin.length,8);header.writeUInt32LE(json.length,12);
 return Buffer.concat([header,json,bin]);
}
const asArrayBuffer=buffer=>buffer.buffer.slice(buffer.byteOffset,buffer.byteOffset+buffer.byteLength);
const near=(actual,expected,message)=>assert(actual.distanceTo(expected)<1e-5,message||`${actual.toArray()} != ${expected.toArray()}`);
(async()=>{
 const THREE=await import('three');
 const {loadCustomModel,SOURCE_JOINTS,autoMapBones}=await import(pathToFileURL(path.join(ROOT,'teaching_suite/public/custom-figure.js')).href);
 const input=fs.readFileSync(path.join(ROOT,'outputs/custom-models/Coastal Rig.glb'));
 let requests=0;globalThis.fetch=()=>{requests++;throw Error('Unexpected fetch');};
 const asset=await loadCustomModel(asArrayBuffer(input),{name:'Invariant rig'});
 assert.deepEqual(asset.missingRequired,[]);assert.equal(Object.keys(asset.mapping).length,22);
 const mixamo=['Hips','LeftUpLeg','RightUpLeg','Spine','LeftLeg','RightLeg','Spine1','LeftFoot','RightFoot','Spine2','LeftToeBase','RightToeBase','Neck','LeftShoulder','RightShoulder','Head','LeftArm','RightArm','LeftForeArm','RightForeArm','LeftHand','RightHand'].map(name=>'mixamorig'+name);
 const mixamoMap=autoMapBones(mixamo);assert.equal(Object.keys(mixamoMap).length,22);assert.equal(mixamoMap.right_shoulder,'mixamorigRightArm');assert.equal(mixamoMap.left_collar,'mixamorigLeftShoulder');
 const [a,b]=[asset.createInstance(),asset.createInstance()];
 const world=new THREE.Scene(),parentA=new THREE.Group(),parentB=new THREE.Group();world.add(parentA,parentB);parentA.add(a.group);parentB.add(b.group);
 assert.notEqual(a.skeleton,b.skeleton);assert.notEqual(a.meshes[0].material,b.meshes[0].material);assert.equal(a.meshes[0].geometry,b.meshes[0].geometry);
 const rest=SOURCE_JOINTS.map(name=>asset.restWorld.get(asset.mapping[name]).position.toArray());
 const locals=a.bones.map(bone=>({p:bone.position.clone(),s:bone.scale.clone()}));
 assert(a.update(rest));assert(b.update(rest));
 near(a.group.position,new THREE.Vector3(...rest[0]));assert(Math.abs(a.group.userData.customFigure.normalizedScale-1)<1e-6);
 const before=a.meshes[0].getVertexPosition(100,new THREE.Vector3()).clone();
 const pose=rest.map(point=>[...point]),wrist=SOURCE_JOINTS.indexOf('left_wrist'),elbow=SOURCE_JOINTS.indexOf('left_elbow');
 pose[wrist]=[pose[elbow][0],pose[elbow][1]+.24,pose[elbow][2]+.06];
 assert(a.update(pose,{opacity:.7,xray:true,highlightJoint:'left_wrist',intensity:1}));
 const after=a.meshes[0].getVertexPosition(100,new THREE.Vector3());
 const vertices=a.meshes[0].geometry.attributes.position.count;
 let moved=false;for(let index=0;index<vertices;index+=17){const one=a.meshes[0].getVertexPosition(index,new THREE.Vector3()),two=b.meshes[0].getVertexPosition(index,new THREE.Vector3());if(one.distanceTo(two)>.001){moved=true;break;}}
 assert(moved,'Skinned vertices must actually deform from captured joint rotations');
 const direction=(rig,start,end)=>rig.boneMap.get(end).getWorldPosition(new THREE.Vector3()).sub(rig.boneMap.get(start).getWorldPosition(new THREE.Vector3())).normalize();
 const desired=new THREE.Vector3(...pose[wrist]).sub(new THREE.Vector3(...pose[elbow])).normalize();
 near(direction(a,'left_elbow','left_wrist'),desired,'Imported forearm direction follows the captured elbow-to-wrist direction');
 assert.notDeepEqual(a.boneMap.get('left_elbow').quaternion.toArray(),b.boneMap.get('left_elbow').quaternion.toArray());
 for(let index=0;index<a.bones.length;index++){near(a.bones[index].position,locals[index].p);near(a.bones[index].scale,locals[index].s);}
 const oldWorld=a.boneMap.get('head').getWorldPosition(new THREE.Vector3()),delta=new THREE.Vector3(3,.2,-2);
 a.update(pose.map(point=>new THREE.Vector3(...point).add(delta).toArray()));near(a.boneMap.get('head').getWorldPosition(new THREE.Vector3()),oldWorld.add(delta));
 const turn=new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0),Math.PI/2),pelvis=new THREE.Vector3(...pose[0]);
 const turned=pose.map(point=>new THREE.Vector3(...point).sub(pelvis).applyQuaternion(turn).add(pelvis).toArray());a.update(turned);
 near(direction(a,'left_elbow','left_wrist'),desired.clone().applyQuaternion(turn));
 const worldVertex=(rig,index)=>rig.meshes[0].getVertexPosition(index,new THREE.Vector3()).applyMatrix4(rig.meshes[0].matrixWorld);
 world.updateMatrixWorld(true);const firstHead=a.boneMap.get('head').getWorldPosition(new THREE.Vector3()),firstVertices=[100,1200,3000].map(index=>worldVertex(a,index));
 const other=rest.map(point=>new THREE.Vector3(...point).add(new THREE.Vector3(-4,0,2)).toArray());b.update(other);world.updateMatrixWorld(true);
 near(a.boneMap.get('head').getWorldPosition(new THREE.Vector3()),firstHead);for(const [index,vertex] of [100,1200,3000].map((index,i)=>[index,firstVertices[i]]))near(worldVertex(a,index),vertex,'Updating a sibling must not move the first character skin');
 near(b.boneMap.get('pelvis').getWorldPosition(new THREE.Vector3()),new THREE.Vector3(...other[0]));assert(a.boneMap.get('pelvis').getWorldPosition(new THREE.Vector3()).distanceTo(b.boneMap.get('pelvis').getWorldPosition(new THREE.Vector3()))>3);
 const transformed=rewriteGLB(input,document=>{document.nodes[0].translation=[400,-100,200];document.nodes[0].rotation=new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1,0,0),Math.PI/2).toArray();document.nodes[0].scale=[100,100,100];});
 const unusual=await loadCustomModel(asArrayBuffer(transformed),{name:'Centimeter root rotated'}),c=unusual.createInstance();
 assert(c.update(pose));
 near(c.group.position,pelvis);near(direction(c,'left_elbow','left_wrist'),desired);
 // The skeleton's local bone lengths are unchanged; a uniform actor scale
 // absorbs model units, including a rotated/scaled armature root.
 for(const bone of c.bones)near(bone.position,c.rest.get(bone).position);
 const armLength=a.rest.get(a.boneMap.get('left_wrist')).position.length();
 const worldLength=c.boneMap.get('left_wrist').getWorldPosition(new THREE.Vector3()).distanceTo(c.boneMap.get('left_elbow').getWorldPosition(new THREE.Vector3()));
 assert(Math.abs(worldLength-armLength)<1e-5,`Centimeter model should normalize to captured arm length: ${worldLength} vs ${armLength}`);
 // A valid export with a transformed Armature parent, a sibling mesh baked in
 // model space, and inverse binds that include the Armature transform. This
 // catches Skeleton.pose() treating a root Bone's bind world matrix as local.
 const armatureInput=Buffer.from(input),doc=glbDocument(armatureInput),binStart=20+armatureInput.readUInt32LE(12)+8;
 const rootTransform=new THREE.Matrix4().compose(new THREE.Vector3(100,-80,300),new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1,0,0),Math.PI/2),new THREE.Vector3(100,100,100));
 const inverseRoot=rootTransform.clone().invert(),positionAccessor=doc.accessors[doc.meshes[0].primitives[0].attributes.POSITION],positionView=doc.bufferViews[positionAccessor.bufferView];
 positionAccessor.min=[Infinity,Infinity,Infinity];positionAccessor.max=[-Infinity,-Infinity,-Infinity];
 for(let i=0;i<positionAccessor.count;i++){
  const offset=binStart+(positionView.byteOffset||0)+(positionAccessor.byteOffset||0)+i*12;
  const point=new THREE.Vector3(armatureInput.readFloatLE(offset),armatureInput.readFloatLE(offset+4),armatureInput.readFloatLE(offset+8)).applyMatrix4(rootTransform);
  for(let axis=0;axis<3;axis++){const value=point.getComponent(axis);armatureInput.writeFloatLE(value,offset+axis*4);positionAccessor.min[axis]=Math.min(positionAccessor.min[axis],value);positionAccessor.max[axis]=Math.max(positionAccessor.max[axis],value);}
 }
 const inverseAccessor=doc.accessors[doc.skins[0].inverseBindMatrices],inverseView=doc.bufferViews[inverseAccessor.bufferView];
 for(let i=0;i<inverseAccessor.count;i++){
  const offset=binStart+(inverseView.byteOffset||0)+(inverseAccessor.byteOffset||0)+i*64;
  const matrix=new THREE.Matrix4().fromArray(Array.from({length:16},(_,j)=>armatureInput.readFloatLE(offset+j*4))).multiply(inverseRoot);
  matrix.elements.forEach((value,j)=>armatureInput.writeFloatLE(value,offset+j*4));
 }
 const armature=rewriteGLB(armatureInput,document=>{
  const meshNode=document.nodes[0].children[1],newNode=document.nodes.length;document.nodes[0].children=[newNode,meshNode];document.nodes.push({name:'Transformed Armature',matrix:rootTransform.toArray(),children:[1]});
  document.accessors[doc.meshes[0].primitives[0].attributes.POSITION].min=positionAccessor.min;document.accessors[doc.meshes[0].primitives[0].attributes.POSITION].max=positionAccessor.max;
 });
 const armatureAsset=await loadCustomModel(asArrayBuffer(armature)),d=armatureAsset.createInstance();
 near(armatureAsset.restWorld.get('pelvis').position,new THREE.Vector3(...rest[0]).applyMatrix4(rootTransform),'Loader rest locals must not double-apply a non-Bone Armature transform');
 a.update(pose);d.update(pose);world.updateMatrixWorld(true);
 for(const index of [100,1200,3000])near(worldVertex(d,index),worldVertex(a,index),'Transformed Armature skin must match the ordinary character after normalization');
 assert.throws(()=>asset.setMapping({...asset.mapping,left_wrist:asset.mapping.right_wrist}),/assigned twice/);
 await assert.rejects(()=>loadCustomModel(asArrayBuffer(rewriteGLB(input,document=>{document.buffers[0].uri='https://example.test/model.bin';}))),/external files/);
 await assert.rejects(()=>loadCustomModel(asArrayBuffer(rewriteGLB(input,document=>{document.extensionsUsed=['KHR_draco_mesh_compression'];}))),/Draco/);
 assert.equal(requests,0);
 const geometry=a.meshes[0].geometry;let disposed=false;geometry.addEventListener('dispose',()=>{disposed=true;});a.dispose();assert(!disposed,'One actor must not dispose geometry used by another actor');asset.dispose();assert(disposed);unusual.dispose();armatureAsset.dispose();
 console.log('PASS auto-mapping, independent skeletons/materials, shared geometry, real skin deformation, forearm direction, bind translations/scales, pelvis translation, body facing, cm units/rotated roots, duplicate/external/compressed rejection, disposal, no fetches');
})().catch(error=>{console.error(error);process.exitCode=1;});

import * as THREE from 'three';
import {GLTFLoader} from './vendor/three/addons/loaders/GLTFLoader.js';
import {clone as cloneSkeleton} from './vendor/three/addons/utils/SkeletonUtils.js';

export const SOURCE_JOINTS=['pelvis','left_hip','right_hip','spine1','left_knee','right_knee','spine2','left_ankle','right_ankle','spine3','left_foot','right_foot','neck','left_collar','right_collar','head','left_shoulder','right_shoulder','left_elbow','right_elbow','left_wrist','right_wrist'];
export const REQUIRED_JOINTS=['pelvis','spine3','head',...['left','right'].flatMap(side=>['hip','knee','ankle','shoulder','elbow','wrist'].map(part=>`${side}_${part}`))];
const EPS=1e-9, UP=new THREE.Vector3(0,1,0);
const NEXT={pelvis:['spine1','spine2','spine3','neck','head'],spine1:['spine2','spine3','neck','head'],spine2:['spine3','neck','head'],spine3:['neck','head'],neck:['head']};
for(const side of ['left','right']){
  NEXT[`${side}_hip`]=[`${side}_knee`,`${side}_ankle`];
  NEXT[`${side}_knee`]=[`${side}_ankle`];
  NEXT[`${side}_ankle`]=[`${side}_foot`];
  NEXT[`${side}_collar`]=[`${side}_shoulder`,`${side}_elbow`];
  NEXT[`${side}_shoulder`]=[`${side}_elbow`,`${side}_wrist`];
  NEXT[`${side}_elbow`]=[`${side}_wrist`];
}
const PREVIOUS={head:['neck','spine3','pelvis'],neck:['spine3','pelvis']};
for(const side of ['left','right']){
  PREVIOUS[`${side}_wrist`]=[`${side}_elbow`,`${side}_shoulder`];
  PREVIOUS[`${side}_foot`]=[`${side}_ankle`,`${side}_knee`];
  PREVIOUS[`${side}_ankle`]=[`${side}_knee`,`${side}_hip`];
}
const finitePoint=point=>point?.length>=3&&Number.isFinite(point[0])&&Number.isFinite(point[1])&&Number.isFinite(point[2]);
const clamp=(value,low,high)=>Math.max(low,Math.min(high,value));

// Inspect the container before GLTFLoader sees it. A local model must never
// resolve a URL relative to the lesson or make a request to a third party.
export function validateCustomGLB(data){
  if(!(data instanceof ArrayBuffer)||data.byteLength<20)throw new Error('Choose a binary glTF (.glb) file with its textures embedded.');
  const view=new DataView(data);
  if(view.getUint32(0,true)!==0x46546c67||view.getUint32(4,true)!==2||view.getUint32(8,true)!==data.byteLength)throw new Error('This is not a complete glTF 2.0 GLB file. Export the model again as .glb.');
  let offset=12,document=null,binaryChunks=0;
  while(offset<data.byteLength){
    if(offset+8>data.byteLength)throw new Error('The GLB contains a truncated chunk. Export it again.');
    const length=view.getUint32(offset,true),type=view.getUint32(offset+4,true);offset+=8;
    if(length%4||offset+length>data.byteLength)throw new Error('The GLB contains an invalid or truncated chunk.');
    if(type===0x4e4f534a){
      if(document||offset!==20)throw new Error('The GLB must start with one JSON scene chunk.');
      try{document=JSON.parse(new TextDecoder().decode(new Uint8Array(data,offset,length)));}
      catch{throw new Error('The GLB scene description could not be read. Export it again.');}
    }else if(type===0x004e4942)binaryChunks++;
    offset+=length;
  }
  if(!document||String(document.asset?.version)!=='2.0'||binaryChunks>1)throw new Error('Choose a valid glTF 2.0 binary model.');
  const unsupported={KHR_draco_mesh_compression:'Draco mesh compression',EXT_meshopt_compression:'Meshopt compression',KHR_texture_basisu:'KTX2 / Basis textures'};
  const inspect=(value)=>{
    if(!value||typeof value!=='object')return;
    for(const [key,item] of Object.entries(value)){
      if(key==='uri'&&(typeof item!=='string'||!/^data:/i.test(item)))throw new Error('This model references external files. Export one .glb with all buffers and PNG/JPEG textures embedded.');
      if(key==='extensionsUsed'||key==='extensionsRequired'){
        for(const name of Array.isArray(item)?item:[])if(unsupported[name])throw new Error(`${unsupported[name]} is not supported for uploads. Export an uncompressed .glb with PNG/JPEG textures.`);
      }
      if(key==='extensions'&&item&&typeof item==='object')for(const name of Object.keys(item))if(unsupported[name])throw new Error(`${unsupported[name]} is not supported for uploads. Export an uncompressed .glb with PNG/JPEG textures.`);
      inspect(item);
    }
  };
  inspect(document);
  for(const image of document.images||[])if(image.mimeType&&/ktx|basis/i.test(image.mimeType))throw new Error('KTX2 / Basis textures are not supported. Export PNG/JPEG textures embedded in the GLB.');
  if((document.buffers||[]).some(buffer=>!buffer.uri)&&!binaryChunks)throw new Error('The GLB is missing its embedded model data.');
  return document;
}

function normalizedName(name){
  let value=String(name).split(/[:|]/).pop().toLowerCase().replace(/^rig[ ._-]+/,'').replace(/[^a-z0-9]/g,'');
  let previous;
  do{previous=value;value=value.replace(/^(?:mixamorig\d*|bip(?:ed)?\d*|ccbase|armature|def|org|mch)/,'');}while(value!==previous);
  return value;
}

export function autoMapBones(boneNames){
  const entries=boneNames.map(name=>({name,key:normalizedName(name)})),mapping={},used=new Set();
  const take=(source,aliases)=>{
    if(mapping[source])return;
    for(const alias of aliases){
      const match=entries.find(entry=>entry.key===alias&&!used.has(entry.name));
      if(match){mapping[source]=match.name;used.add(match.name);return;}
    }
  };
  // SMPL's shoulder and foot names differ from Mixamo's shoulder and foot.
  // Recognize a SMPL skeleton as a whole before considering common aliases.
  const smpl=['pelvis','lefthip','righthip','spine1'].every(key=>entries.some(entry=>entry.key===key));
  if(smpl)for(const name of SOURCE_JOINTS)take(name,[normalizedName(name)]);
  const rigify=entries.some(entry=>entry.key==='spine006')&&entries.some(entry=>entry.key==='spine004');
  if(rigify)for(const [source,target] of Object.entries({pelvis:'spine',spine1:'spine001',spine2:'spine002',spine3:'spine003',neck:'spine004',head:'spine006'}))take(source,[target]);
  take('pelvis',['hips','pelvis','hip']);
  take('head',['head','head01','head1','head001']);
  take('neck',['neck','neck01','neck1','neck001']);
  take('spine3',['upperchest','chest','spine3','spine03','spine003','spine2','spine02','spine002','spine1','spine01','spine001','spine']);
  take('spine2',['chest','spine2','spine02','spine002','spine1','spine01','spine001']);
  take('spine1',['spine','spine1','spine01','spine001','lowerback','abdomen']);
  for(const [side,short] of [['left','l'],['right','r']]){
    const aliases={
      hip:[`${side}upleg`,`${side}upperleg`,`${side}thigh`,`thigh${short}`,`${short}thigh`,`${short}upperleg`,`${side}hip`,`${short}hip`,`upperleg${short}`,`upleg${short}`],
      knee:[`${side}leg`,`${side}lowerleg`,`${side}calf`,`shin${short}`,`calf${short}`,`${short}shin`,`${short}calf`,`${side}knee`,`${short}knee`,`lowerleg${short}`],
      ankle:[`${side}foot`,`foot${short}`,`${short}foot`,`${side}ankle`,`${short}ankle`],
      foot:[`${side}toebase`,`${side}toe`,`${side}toes`,`toe${short}`,`toes${short}`,`${short}toe`,`${short}toes`,`${side}ball`],
      shoulder:[`${side}arm`,`${side}upperarm`,`upperarm${short}`,`${short}upperarm`,`${short}arm`,`arm${short}`,`${short}shoulder`,`${side}shoulder`],
      elbow:[`${side}forearm`,`${side}lowerarm`,`forearm${short}`,`lowerarm${short}`,`${short}forearm`,`${short}lowerarm`,`${side}elbow`,`${short}elbow`],
      wrist:[`${side}hand`,`hand${short}`,`${short}hand`,`${side}wrist`,`${short}wrist`],
      collar:[`${side}shoulder`,`${side}clavicle`,`clavicle${short}`,`${short}clavicle`,`${side}collar`,`collar${short}`,`${short}collar`],
    };
    for(const part of ['hip','knee','ankle','foot','shoulder','elbow','wrist','collar'])take(`${side}_${part}`,aliases[part]);
  }
  return mapping;
}

function bodyFrame(points){
  const pelvis=points.get('pelvis'),head=points.get('head')||points.get('spine3');
  const up=head&&pelvis?head.clone().sub(pelvis):UP.clone();
  if(up.lengthSq()<EPS)up.copy(UP);up.normalize();
  const left=points.get('left_shoulder')||points.get('left_hip'),right=points.get('right_shoulder')||points.get('right_hip');
  const across=left&&right?right.clone().sub(left):new THREE.Vector3(1,0,0);
  across.addScaledVector(up,-across.dot(up));
  if(across.lengthSq()<EPS){across.set(1,0,0).addScaledVector(up,-up.x);if(across.lengthSq()<EPS)across.set(0,0,1).addScaledVector(up,-up.z);}
  across.normalize();
  const forward=new THREE.Vector3().crossVectors(across,up).normalize();
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(across,up,forward));
}

function standingHeight(points){
  const spine=['pelvis','spine1','spine2','spine3','neck','head'].filter(name=>points.has(name));
  let torso=0;
  for(let index=1;index<spine.length;index++)torso+=points.get(spine[index-1]).distanceTo(points.get(spine[index]));
  const legs=[];
  for(const side of ['left','right']){
    const names=['pelvis',`${side}_hip`,`${side}_knee`,`${side}_ankle`];
    if(names.every(name=>points.has(name))){let length=0;for(let index=1;index<names.length;index++)length+=points.get(names[index-1]).distanceTo(points.get(names[index]));legs.push(length);}
  }
  return torso+(legs.length?legs.reduce((sum,length)=>sum+length,0)/legs.length:0);
}

function collectResources(scene){
  const geometry=new Set(),materials=new Set(),textures=new Set(),skeletons=new Set();
  scene.traverse(object=>{
    if(object.geometry)geometry.add(object.geometry);
    for(const material of object.material?Array.isArray(object.material)?object.material:[object.material]:[]){
      materials.add(material);for(const value of Object.values(material))if(value?.isTexture)textures.add(value);
    }
    if(object.skeleton)skeletons.add(object.skeleton);
  });
  return {geometry,materials,textures,skeletons};
}

function cloneFigureMaterial(source,skinned){
  const material=source.clone(),highlight={value:-1},emphasis={value:0};
  if(skinned){
    material.onBeforeCompile=shader=>{
      shader.uniforms.customFigureBone=highlight;shader.uniforms.customFigureEmphasis=emphasis;
      shader.vertexShader=shader.vertexShader.replace('#include <common>','#include <common>\nuniform float customFigureBone;\nvarying float customFigureRegion;')
        .replace('#include <skinning_vertex>',`#include <skinning_vertex>
          customFigureRegion = 0.0;
          #ifdef USE_SKINNING
            if (customFigureBone >= 0.0) {
              vec4 selected = vec4(1.0) - step(vec4(0.5), abs(skinIndex - vec4(customFigureBone)));
              customFigureRegion = dot(selected, skinWeight);
            }
          #endif`);
      shader.fragmentShader=shader.fragmentShader.replace('#include <common>','#include <common>\nuniform float customFigureEmphasis;\nvarying float customFigureRegion;')
        .replace('#include <color_fragment>','#include <color_fragment>\ndiffuseColor.rgb = mix(diffuseColor.rgb, vec3(1.0, 0.12, 0.015), clamp(customFigureRegion * customFigureEmphasis, 0.0, 0.85));');
    };
    material.customProgramCacheKey=()=> 'systema-custom-figure-highlight-v1';
  }
  return {material,highlight,emphasis,baseOpacity:source.opacity,baseTransparent:source.transparent,baseDepthWrite:source.depthWrite,baseDepthTest:source.depthTest};
}

class CustomFigureInstance{
  constructor(asset,{jointNames=SOURCE_JOINTS,color='#ffc45f'}={}){
    this.asset=asset;this.jointNames=[...jointNames];this.color=color;
    this.group=new THREE.Group();this.group.name=`Uploaded figure: ${asset.name}`;
    this.offset=new THREE.Group();this.group.add(this.offset);
    this.model=cloneSkeleton(asset.scene);this.offset.add(this.model);
    this.bones=[];this.skeletons=[];this.materials=[];this.meshes=[];this.rest=new Map();
    const skeletons=new Set();
    this.model.traverse(object=>{
      if(object.isBone){
        this.bones.push(object);this.rest.set(object,{position:object.position.clone(),quaternion:object.quaternion.clone(),scale:object.scale.clone()});
      }
      if(object.isLight||object.isCamera)object.visible=false;
      if(object.isMesh){
        this.meshes.push(object);object.frustumCulled=false;
        const original=Array.isArray(object.material)?object.material:[object.material];
        const records=original.map(material=>({...cloneFigureMaterial(material,object.isSkinnedMesh),mesh:object}));
        this.materials.push(...records);object.material=Array.isArray(object.material)?records.map(record=>record.material):records[0].material;
      }
      if(object.skeleton)skeletons.add(object.skeleton);
    });
    this.skeletons=[...skeletons];this.skeleton=this.skeletons[0];
    this.boneMap=new Map(this.bones.map(bone=>[bone.name,bone]));this.disposed=false;
    this.group.userData.customFigure={name:asset.name,updates:0,lastUpdate:0};
    this.configure();
  }

  restore(){
    for(const [bone,rest] of this.rest){bone.position.copy(rest.position);bone.quaternion.copy(rest.quaternion);bone.scale.copy(rest.scale);bone.updateMatrix();}
  }

  configure(){
    this.restore();this.captureHeight=null;
    const mapping=this.asset.mapping;this.records=[];this.restPoints=new Map();
    for(const [source,target] of Object.entries(mapping))if(this.boneMap.has(target))this.restPoints.set(source,this.asset.restWorld.get(target).position);
    this.restFrameInverse=bodyFrame(this.restPoints).invert();
    this.bindHeight=standingHeight(this.restPoints);
    this.pelvisRest=this.restPoints.get('pelvis')?.clone()||new THREE.Vector3();
    this.offset.position.copy(this.pelvisRest).negate();
    for(const [source,target] of Object.entries(mapping)){
      const bone=this.boneMap.get(target);if(!bone)continue;
      let peer=(NEXT[source]||[]).find(name=>this.restPoints.has(name)),incoming=false;
      if(!peer){peer=(PREVIOUS[source]||[]).find(name=>this.restPoints.has(name));incoming=true;}
      if(!peer)continue;
      const direction=incoming?this.restPoints.get(source).clone().sub(this.restPoints.get(peer)):this.restPoints.get(peer).clone().sub(this.restPoints.get(source));
      if(direction.lengthSq()<EPS)continue;
      let depth=0;for(let parent=bone.parent;parent;parent=parent.parent)depth++;
      this.records.push({source,peer,incoming,bone,depth,direction:direction.normalize(),restWorldQuaternion:this.asset.restWorld.get(target).quaternion});
    }
    this.records.sort((a,b)=>a.depth-b.depth);
    Object.assign(this.group.userData.customFigure,{mapping:{...mapping},mappedBones:this.records.length,missingRequired:[...this.asset.missingRequired],poseValid:false});
    return this;
  }

  update(xyz,{opacity=1,xray=false,highlightJoint=-1,intensity=0}={}){
    if(this.disposed||!Array.isArray(xyz)||this.asset.missingRequired.length)return false;
    const points=new Map();
    for(let index=0;index<this.jointNames.length;index++)if(finitePoint(xyz[index]))points.set(this.jointNames[index],new THREE.Vector3().fromArray(xyz[index]));
    if(!REQUIRED_JOINTS.every(name=>points.has(name)))return false;
    const capturePoints=new Map([...this.restPoints.keys()].filter(name=>points.has(name)).map(name=>[name,points.get(name)]));
    const height=standingHeight(capturePoints);
    if(!this.captureHeight&&height>EPS)this.captureHeight=height;
    const normalizedScale=this.bindHeight>EPS&&this.captureHeight?this.captureHeight/this.bindHeight:1;
    const {scaleMultiplier,yawDegrees}=this.asset.settings;
    const yaw=new THREE.Quaternion().setFromAxisAngle(UP,THREE.MathUtils.degToRad(yawDegrees));
    this.group.position.copy(points.get('pelvis'));
    this.group.quaternion.copy(yaw).multiply(bodyFrame(points)).multiply(this.restFrameInverse);
    this.group.scale.setScalar(normalizedScale*scaleMultiplier);
    this.restore();this.group.updateMatrixWorld(true);
    const globalRotation=this.group.getWorldQuaternion(new THREE.Quaternion());
    const parentRotation=new THREE.Quaternion(),desiredRotation=new THREE.Quaternion(),swing=new THREE.Quaternion();
    const predicted=new THREE.Vector3(),desired=new THREE.Vector3();
    for(const record of this.records){
      const start=points.get(record.source),end=points.get(record.peer);if(!start||!end)continue;
      if(record.incoming)desired.subVectors(start,end);else desired.subVectors(end,start);
      if(desired.lengthSq()<EPS)continue;
      desired.normalize().applyQuaternion(yaw);
      predicted.copy(record.direction).applyQuaternion(globalRotation).normalize();
      swing.setFromUnitVectors(predicted,desired);
      desiredRotation.copy(swing).multiply(globalRotation).multiply(record.restWorldQuaternion);
      if(record.bone.parent)record.bone.parent.getWorldQuaternion(parentRotation);else parentRotation.identity();
      record.bone.quaternion.copy(parentRotation.invert()).multiply(desiredRotation).normalize();
      record.bone.updateMatrix();record.bone.updateWorldMatrix(false,true);
    }
    this.group.updateMatrixWorld(true);for(const skeleton of this.skeletons)skeleton.update();
    const highlightName=typeof highlightJoint==='string'?highlightJoint:this.jointNames[highlightJoint];
    const highlightedBone=this.boneMap.get(this.asset.mapping[highlightName]);
    const amount=clamp(Number(intensity)||0,0,1),alpha=Number.isFinite(opacity)?clamp(opacity,0,1):1;
    for(const record of this.materials){
      const material=record.material,nextTransparent=record.baseTransparent||alpha<.999;
      if(material.transparent!==nextTransparent){material.transparent=nextTransparent;material.needsUpdate=true;}
      material.opacity=record.baseOpacity*alpha;material.depthTest=xray?false:record.baseDepthTest;material.depthWrite=xray||alpha<.999?false:record.baseDepthWrite;
      record.highlight.value=highlightedBone&&record.mesh.skeleton?record.mesh.skeleton.bones.indexOf(highlightedBone):-1;
      record.emphasis.value=amount>0?.25+.6*amount:0;
      record.mesh.renderOrder=xray?1000:0;
    }
    const metadata=this.group.userData.customFigure;
    Object.assign(metadata,{updates:metadata.updates+1,lastUpdate:metadata.lastUpdate+1,poseValid:true,normalizedScale,scaleMultiplier,yawDegrees,lastPelvis:points.get('pelvis').toArray(),highlightJoint:highlightName||null,intensity:amount});
    return true;
  }

  dispose(){
    if(this.disposed)return;this.disposed=true;
    for(const {material} of this.materials)material.dispose();for(const skeleton of this.skeletons)skeleton.dispose();
    this.group.removeFromParent();this.group.clear();this.asset.instances.delete(this);
  }
}

/** Load a self-contained GLB locally. Captured motion drives bone rotations;
 * imported bind translations, scales, textures, and proportions remain intact. */
export async function loadCustomModel(data,{name='My model',mapping,settings}={}){
  validateCustomGLB(data);
  const manager=new THREE.LoadingManager();
  manager.setURLModifier(url=>{
    if(/^(data:|blob:)/i.test(url))return url;
    throw new Error('External model resources are blocked. Export all textures and buffers inside one .glb.');
  });
  const loader=new GLTFLoader(manager);
  let gltf;
  try{gltf=await loader.parseAsync(data,'');}
  catch(error){throw new Error(`Could not load this GLB: ${error?.message||'invalid model data'}`);}
  const scene=gltf.scene;
  if(!scene)throw new Error('The GLB has no model scene.');
  const resources=collectResources(scene),bones=new Map();
  let skinnedMeshes=0;
  scene.traverse(object=>{
    if(object.isSkinnedMesh&&object.skeleton?.bones.length){skinnedMeshes++;for(const bone of object.skeleton.bones)if(bone?.isBone)bones.set(bone.name,bone);}
  });
  const disposeResources=()=>{
    for(const geometry of resources.geometry)geometry.dispose();for(const material of resources.materials)material.dispose();
    const images=new Set();for(const texture of resources.textures){if(texture.source?.data)images.add(texture.source.data);texture.dispose();}
    for(const image of images)if(typeof image.close==='function')image.close();
    for(const skeleton of resources.skeletons)skeleton.dispose();
  };
  if(!skinnedMeshes||!bones.size){disposeResources();throw new Error('This model has no skinned mesh with bones. Export a rigged character with skin weights as .glb.');}
  // Keep the authored A/T rest pose. Skeleton.pose() assumes a root Bone has
  // no transformed non-Bone parent, and can double-apply an Armature transform.
  // glTF inverse bind matrices are mesh-relative, so guessing a world-space
  // pose from them would also break valid scaled/rotated exports. No imported
  // animation is played; these loader-provided local transforms are our rest.
  scene.updateMatrixWorld(true);
  const restWorld=new Map([...bones].map(([boneName,bone])=>[boneName,{position:bone.getWorldPosition(new THREE.Vector3()),quaternion:bone.getWorldQuaternion(new THREE.Quaternion())}]));
  const asset={
    name:String(name).trim().slice(0,100)||'My model',scene,boneNames:[...bones.keys()],mapping:{},missingRequired:[],settings:{scaleMultiplier:1,yawDegrees:0},restWorld,instances:new Set(),disposed:false,
    setMapping(next){
      if(this.disposed)throw new Error('This model has been removed.');
      const clean={},used=new Set();
      for(const source of SOURCE_JOINTS){
        const target=next?.[source];if(target==null||target==='')continue;
        if(typeof target!=='string'||!bones.has(target))throw new Error(`Choose an existing model bone for ${source.replaceAll('_',' ')}.`);
        if(used.has(target))throw new Error(`“${target}” is assigned twice. Choose a separate bone for each joint.`);
        clean[source]=target;used.add(target);
      }
      this.mapping=clean;this.missingRequired=REQUIRED_JOINTS.filter(joint=>!clean[joint]);
      for(const instance of this.instances)instance.configure();return this;
    },
    setSettings(next={}){
      const scale=Number(next.scaleMultiplier??this.settings.scaleMultiplier),yaw=Number(next.yawDegrees??this.settings.yawDegrees);
      if(!Number.isFinite(scale)||scale<.1||scale>10||!Number.isFinite(yaw))throw new Error('Use a size multiplier from 0.1 to 10 and a numeric facing angle.');
      this.settings={scaleMultiplier:scale,yawDegrees:((yaw+180)%360+360)%360-180};return this;
    },
    createInstance(options){
      if(this.disposed)throw new Error('This model has been removed.');
      if(this.missingRequired.length)throw new Error('Finish assigning the required body bones before using this model.');
      const instance=new CustomFigureInstance(this,options);this.instances.add(instance);return instance;
    },
    dispose(){
      if(this.disposed)return;this.disposed=true;for(const instance of [...this.instances])instance.dispose();disposeResources();scene.clear();
    },
  };
  try{asset.setMapping(mapping??autoMapBones(asset.boneNames));if(settings)asset.setSettings(settings);}
  catch(error){asset.dispose();throw error;}
  return asset;
}

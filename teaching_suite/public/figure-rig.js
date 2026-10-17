import * as THREE from 'three';

// A small, asset-free character rig for the 22-joint SMPL body used by scene.json.
// Every visible part belongs to one merged SkinnedMesh. Its 22 Bones follow the
// reconstruction directly; changing appearance never changes the recorded pose.
const JOINT_NAMES=['pelvis','left_hip','right_hip','spine1','left_knee','right_knee','spine2','left_ankle','right_ankle','spine3','left_foot','right_foot','neck','left_collar','right_collar','head','left_shoulder','right_shoulder','left_elbow','right_elbow','left_wrist','right_wrist'];
const PARENTS=[-1,0,0,0,1,2,3,4,5,6,7,8,9,9,9,12,13,14,16,17,18,19];
const PRIMARY_CHILD=[3,4,5,6,7,8,9,10,11,12,-1,-1,15,16,17,-1,18,19,20,21,-1,-1];
const REST=[
  [0,.98,0],[-.09,.91,0],[.09,.91,0],[0,1.10,0],[-.09,.53,0],[.09,.53,0],
  [0,1.23,0],[-.09,.13,0],[.09,.13,0],[0,1.31,0],[-.09,.06,.14],[.09,.06,.14],
  [0,1.50,0],[-.075,1.40,0],[.075,1.40,0],[0,1.65,0],[-.24,1.43,0],[.24,1.43,0],
  [-.51,1.43,0],[.51,1.43,0],[-.75,1.43,0],[.75,1.43,0],
];
const EPS=1e-7, FORWARD=new THREE.Vector3(0,0,1), UP=new THREE.Vector3(0,1,0);
const validPoint=point=>Array.isArray(point)&&point.length>=3&&point.slice(0,3).every(Number.isFinite);
const clamp=(value,min,max)=>Math.max(min,Math.min(max,value));

function axialQuaternion(direction,forward,right,target){
  const y=direction.clone().normalize();
  let z=forward.clone().addScaledVector(y,-forward.dot(y));
  if(z.lengthSq()<EPS){
    const x=right.clone().addScaledVector(y,-right.dot(y));
    if(x.lengthSq()>EPS)z.crossVectors(x.normalize(),y);
    else z=(Math.abs(y.z)<.9?FORWARD:UP).clone().addScaledVector(y,-(Math.abs(y.z)<.9?FORWARD:UP).dot(y));
  }
  z.normalize();
  const x=new THREE.Vector3().crossVectors(y,z).normalize();
  z.crossVectors(x,y).normalize();
  return target.setFromRotationMatrix(new THREE.Matrix4().makeBasis(x,y,z));
}

/**
 * new FigureRig({jointNames, edges, color})
 *   .group: add to the world; .mesh/.skinnedMesh and .skeleton are inspectable.
 *   .setStyle('mannequin'|'dummy') swaps materials on the existing rig.
 *   .update(xyz,{color,opacity,xray,highlightJoint,intensity}) accepts the same
 *   world joints as the line skeleton. highlightJoint can be a name or index;
 *   intensity is a display cue from 0 to 1, never an inferred force value.
 */
export class FigureRig {
  constructor({jointNames=JOINT_NAMES,edges,color='#ffc45f'}={}){
    this.jointNames=[...jointNames];
    this.indices=new Map(this.jointNames.map((name,index)=>[name,index]));
    this.edges=edges||PARENTS.flatMap((parent,index)=>parent<0?[]:[[parent,index]]);
    this.parents=this.jointNames.map(name=>{
      const original=JOINT_NAMES.indexOf(name),parent=PARENTS[original];
      return parent>=0?(this.indices.get(JOINT_NAMES[parent])??-1):-1;
    });
    this.children=this.jointNames.map(name=>{
      const original=JOINT_NAMES.indexOf(name),child=PRIMARY_CHILD[original];
      return child>=0?(this.indices.get(JOINT_NAMES[child])??-1):-1;
    });
    this.rest=this.jointNames.map(name=>new THREE.Vector3(...(REST[JOINT_NAMES.indexOf(name)]||[0,1,0])));
    this.points=this.rest.map(point=>point.clone());
    this.restDirections=[];this.restLengths=[];this.restQuaternions=[];this.restWorld=[];this.poseWorld=[];
    this.lastDirections=[];this.bones=[];
    this.group=new THREE.Group();this.group.name='Procedural figure rig';
    const right=new THREE.Vector3(1,0,0);
    for(let index=0;index<this.jointNames.length;index++){
      const child=this.children[index],parent=this.parents[index];
      const direction=child>=0?this.rest[child].clone().sub(this.rest[index]):parent>=0?this.rest[index].clone().sub(this.rest[parent]):UP.clone();
      if(direction.lengthSq()<EPS)direction.copy(UP);
      this.restLengths[index]=direction.length();this.restDirections[index]=direction.clone().normalize();
      this.lastDirections[index]=this.restDirections[index].clone();
      const rotation=axialQuaternion(direction,FORWARD,right,new THREE.Quaternion());
      this.restQuaternions[index]=rotation;
      this.restWorld[index]=new THREE.Matrix4().compose(this.rest[index],rotation,new THREE.Vector3(1,1,1));
      this.poseWorld[index]=new THREE.Matrix4();
      const bone=new THREE.Bone();bone.name=this.jointNames[index];bone.matrixAutoUpdate=false;
      this.bones.push(bone);
    }
    for(let index=0;index<this.bones.length;index++){
      const parent=this.parents[index],bone=this.bones[index];
      if(parent<0){this.group.add(bone);bone.matrix.copy(this.restWorld[index]);}
      else{
        this.bones[parent].add(bone);
        bone.matrix.copy(this.restWorld[parent]).invert().multiply(this.restWorld[index]);
      }
    }
    this.style='mannequin';this.color=new THREE.Color(color);this.highlightJoint=-1;this.intensity=0;
    this.vertexRegions=[];this.vertexKinds=[];
    this.geometry=this.buildGeometry();
    this.material=new THREE.MeshStandardMaterial({vertexColors:true,roughness:.84,metalness:0,transparent:true,opacity:1});
    this.mesh=new THREE.SkinnedMesh(this.geometry,this.material);this.skinnedMesh=this.mesh;
    this.mesh.name='Skinned teaching mannequin';this.mesh.frustumCulled=false;
    this.mesh.castShadow=true;this.mesh.receiveShadow=true;this.group.add(this.mesh);
    this.group.updateMatrixWorld(true);
    this.skeleton=new THREE.Skeleton(this.bones);this.mesh.bind(this.skeleton);
    this.group.userData.figureRig={style:this.style,jointCount:this.bones.length,vertexCount:this.geometry.attributes.position.count,lastUpdate:0};
    this.recolor();
  }

  buildGeometry(){
    const positions=[],normals=[],indices=[],skinIndices=[],skinWeights=[];
    const point=new THREE.Vector3(),normal=new THREE.Vector3();
    const append=(geometry,boneIndex,kind='body',region=boneIndex,local=new THREE.Matrix4())=>{
      if(boneIndex==null||boneIndex<0){geometry.dispose();return;}
      const transform=this.restWorld[boneIndex].clone().multiply(local),normalMatrix=new THREE.Matrix3().getNormalMatrix(transform);
      const offset=positions.length/3,attribute=geometry.attributes.position,normalAttribute=geometry.attributes.normal;
      for(let vertex=0;vertex<attribute.count;vertex++){
        point.fromBufferAttribute(attribute,vertex).applyMatrix4(transform);positions.push(point.x,point.y,point.z);
        normal.fromBufferAttribute(normalAttribute,vertex).applyNormalMatrix(normalMatrix);normals.push(normal.x,normal.y,normal.z);
        skinIndices.push(boneIndex,0,0,0);skinWeights.push(1,0,0,0);
        this.vertexRegions.push(region);this.vertexKinds.push(kind);
      }
      const source=geometry.index?.array;
      if(source)for(const index of source)indices.push(index+offset);
      else for(let index=0;index<attribute.count;index++)indices.push(index+offset);
      geometry.dispose();
    };
    const ellipsoid=(name,scale,offset=[0,0,0],kind='body',region=name)=>{
      const bone=this.indices.get(name),regionIndex=this.indices.get(region);
      const local=new THREE.Matrix4().compose(new THREE.Vector3(...offset),new THREE.Quaternion(),new THREE.Vector3(...scale));
      append(new THREE.SphereGeometry(1,kind==='head'?24:14,kind==='head'?18:10),bone,kind,regionIndex,local);
    };
    const limb=(start,end,radiusA,radiusB)=>{
      const a=this.indices.get(start),b=this.indices.get(end);if(a==null||b==null)return;
      const length=this.rest[a].distanceTo(this.rest[b]);
      const geometry=new THREE.CylinderGeometry(radiusB,radiusA,length,12,5,false);
      append(geometry,a,'body',a,new THREE.Matrix4().makeTranslation(0,length/2,0));
    };

    // One continuous torso surface, with ring weights on the pelvis and spine.
    // This is the deforming part of the mesh, including shoulder/chest contour.
    const rings=[
      [.87,.075,.055,'pelvis'],[.90,.11,.075,'pelvis'],[.935,.125,.077,'pelvis'],[.99,.143,.088,'pelvis'],
      [1.045,.14,.089,'spine1'],[1.10,.135,.087,'spine1'],[1.165,.145,.095,'spine2'],
      [1.23,.154,.101,'spine2'],[1.27,.17,.104,'spine2'],[1.31,.18,.104,'spine3'],
      [1.355,.19,.102,'spine3'],[1.40,.19,.096,'spine3'],[1.43,.12,.078,'neck'],
      [1.475,.052,.048,'neck'],[1.50,.044,.043,'neck'],
    ];
    const ringStart=positions.length/3,sides=20;
    const spine=['pelvis','spine1','spine2','spine3','neck'].filter(name=>this.indices.has(name));
    for(let ring=0;ring<rings.length;ring++){
      const [height,width,depth,name]=rings[ring],bone=this.indices.get(name)??0;
      const next=spine.findIndex(name=>this.rest[this.indices.get(name)].y>=height);
      const high=this.indices.get(spine[next<0?spine.length-1:next]),low=this.indices.get(spine[Math.max(0,next<0?spine.length-1:next-1)]);
      const span=this.rest[high].y-this.rest[low].y,blend=span>EPS?clamp((height-this.rest[low].y)/span,0,1):0;
      for(let side=0;side<=sides;side++){
        const angle=side/sides*Math.PI*2;
        positions.push(Math.cos(angle)*width,height,Math.sin(angle)*depth);
        normal.set(Math.cos(angle)/width,0,Math.sin(angle)/depth).normalize();normals.push(normal.x,normal.y,normal.z);
        skinIndices.push(low,high,0,0);skinWeights.push(1-blend,blend,0,0);
        this.vertexRegions.push(bone);this.vertexKinds.push('torso');
        if(ring<rings.length-1&&side<sides){
          const a=ringStart+ring*(sides+1)+side,b=a+sides+1;
          indices.push(a,b,a+1,b,b+1,a+1);
        }
      }
    }
    const bottomCenter=positions.length/3,pelvis=this.indices.get('pelvis')??0;
    positions.push(0,rings[0][0],0);normals.push(0,-1,0);skinIndices.push(pelvis,0,0,0);skinWeights.push(1,0,0,0);
    this.vertexRegions.push(pelvis);this.vertexKinds.push('torso');
    for(let side=0;side<sides;side++)indices.push(bottomCenter,ringStart+side,ringStart+side+1);
    for(const side of ['left','right']){
      limb(`${side}_hip`,`${side}_knee`,.075,.053);
      limb(`${side}_knee`,`${side}_ankle`,.051,.032);
      limb(`${side}_collar`,`${side}_shoulder`,.046,.06);
      limb(`${side}_shoulder`,`${side}_elbow`,.059,.039);
      limb(`${side}_elbow`,`${side}_wrist`,.043,.025);
      ellipsoid(`${side}_hip`,[.081,.081,.081],[0,0,0],'joint');
      ellipsoid(`${side}_shoulder`,[.067,.067,.067],[0,0,0],'joint');
      ellipsoid(`${side}_elbow`,[.047,.047,.047],[0,0,0],'joint');
      ellipsoid(`${side}_knee`,[.059,.059,.059],[0,0,0],'joint');
      ellipsoid(`${side}_ankle`,[.04,.042,.04],[0,0,0],'joint');
      ellipsoid(`${side}_wrist`,[.036,.067,.025],[0,.045,0],'hand');
      // The tracked foot joint is at the toe, so weight the shoe to the ankle
      // and span that entire segment. A sphere at the toe alone leaves a gap.
      const ankle=this.indices.get(`${side}_ankle`),foot=this.indices.get(`${side}_foot`);
      if(ankle!=null&&foot!=null){
        const length=this.rest[ankle].distanceTo(this.rest[foot]);
        ellipsoid(`${side}_ankle`,[.052,length*.65,.039],[0,length*.5,.006],'foot',`${side}_foot`);
      }
    }
    limb('neck','head',.044,.043);
    // A quiet, faceless training form avoids tiny facial features that twist
    // into an uncanny expression when only the captured head axis is known.
    ellipsoid('head',[.09,.115,.083],[0,.022,0],'head');
    const geometry=new THREE.BufferGeometry();
    geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));
    geometry.setAttribute('normal',new THREE.Float32BufferAttribute(normals,3));
    geometry.setAttribute('skinIndex',new THREE.Uint16BufferAttribute(skinIndices,4));
    geometry.setAttribute('skinWeight',new THREE.Float32BufferAttribute(skinWeights,4));
    geometry.setAttribute('color',new THREE.Float32BufferAttribute(new Float32Array(positions.length),3).setUsage(THREE.DynamicDrawUsage));
    geometry.setIndex(indices);geometry.computeBoundingSphere();
    return geometry;
  }

  setStyle(style){
    const next=style==='dummy'?'dummy':'mannequin';
    if(next!==this.style){
      this.style=next;this.material.roughness=next==='dummy'?.96:.84;
      this.material.metalness=0;
      this.mesh.name=next==='dummy'?'Skinned training dummy':'Skinned teaching mannequin';
      this.group.userData.figureRig.style=next;this.recolor();
    }
    return this;
  }

  recolor(){
    const colors=this.geometry.attributes.color,base=new THREE.Color(),hot=new THREE.Color('#ff5c28');
    const charcoal=new THREE.Color('#222c35'),ivory=new THREE.Color('#d8d9d1'),padding=new THREE.Color('#d99738');
    for(let vertex=0;vertex<colors.count;vertex++){
      const kind=this.vertexKinds[vertex];
      if(kind==='detail')base.copy(charcoal);
      else if(this.style==='dummy'){
        if(kind==='joint'||kind==='foot')base.copy(charcoal).lerp(this.color,.16);
        else if(kind==='torso'||kind==='head')base.copy(padding).lerp(this.color,.23);
        else base.copy(this.color).lerp(padding,.5);
      }else{
        base.copy(this.color).lerp(ivory,kind==='head'||kind==='hand'?.46:.24);
        if(kind==='joint')base.multiplyScalar(.73);
        if(kind==='foot')base.multiplyScalar(.6);
      }
      // Targeted teaching annotation: only vertices in the selected region warm.
      // The exterior cue/marker can stay visible when the target is behind a body.
      if(this.vertexRegions[vertex]===this.highlightJoint&&kind!=='detail')base.lerp(hot,.35+.65*this.intensity);
      colors.setXYZ(vertex,base.r,base.g,base.b);
    }
    colors.needsUpdate=true;
  }

  update(xyz,{color,opacity=1,xray=false,highlightJoint=-1,intensity=0}={}){
    if(!Array.isArray(xyz))return false;
    let valid=0;
    for(let index=0;index<this.points.length;index++){
      if(validPoint(xyz[index])){this.points[index].fromArray(xyz[index]);valid++;}
    }
    if(!valid)return false;
    const at=name=>this.points[this.indices.get(name)];
    const right=new THREE.Vector3().subVectors(at('right_shoulder')||new THREE.Vector3(1,0,0),at('left_shoulder')||new THREE.Vector3(-1,0,0));
    const up=new THREE.Vector3().subVectors(at('neck')||UP,at('pelvis')||new THREE.Vector3());
    if(up.lengthSq()<EPS)up.copy(UP);up.normalize();
    right.addScaledVector(up,-right.dot(up));
    if(right.lengthSq()<EPS)right.set(1,0,0);right.normalize();
    const forward=new THREE.Vector3().crossVectors(right,up).normalize();
    if(forward.lengthSq()<EPS)forward.copy(FORWARD);
    const ratios=[];
    for(const name of ['left_hip','right_hip','left_knee','right_knee','left_shoulder','right_shoulder']){
      const index=this.indices.get(name),child=this.children[index];
      if(index!=null&&child>=0){
        const ratio=this.points[index].distanceTo(this.points[child])/this.restLengths[index];
        if(Number.isFinite(ratio)&&ratio>.1)ratios.push(ratio);
      }
    }
    ratios.sort((a,b)=>a-b);
    const bodyScale=clamp(ratios.length?ratios[Math.floor(ratios.length/2)]:1,.45,1.8);
    const direction=new THREE.Vector3(),rotation=new THREE.Quaternion(),scale=new THREE.Vector3();
    for(let index=0;index<this.bones.length;index++){
      const child=this.children[index],parent=this.parents[index];
      if(child>=0)direction.subVectors(this.points[child],this.points[index]);
      else if(parent>=0)direction.subVectors(this.points[index],this.points[parent]);
      else direction.copy(up);
      const length=direction.length();
      if(length>EPS)this.lastDirections[index].copy(direction).divideScalar(length);
      else direction.copy(this.lastDirections[index]);
      axialQuaternion(direction,forward,right,rotation);
      // Compose each desired transform independently in group coordinates, then
      // derive the hierarchy's local matrices. Parent length changes therefore
      // cannot stretch descendants or move any measured joint away from its xyz.
      const axialScale=child>=0?clamp(length/this.restLengths[index],.02,4):bodyScale;
      scale.set(bodyScale,axialScale,bodyScale);
      this.poseWorld[index].compose(this.points[index],rotation,scale);
    }
    for(let index=0;index<this.bones.length;index++){
      const parent=this.parents[index],bone=this.bones[index];
      if(parent<0)bone.matrix.copy(this.poseWorld[index]);
      else bone.matrix.copy(this.poseWorld[parent]).invert().multiply(this.poseWorld[index]);
      bone.matrixWorldNeedsUpdate=true;
    }
    this.group.updateMatrixWorld(true);this.skeleton.update();
    const nextJoint=typeof highlightJoint==='string'?(this.indices.get(highlightJoint)??-1):Number.isInteger(highlightJoint)&&highlightJoint>=0&&highlightJoint<this.bones.length?highlightJoint:-1;
    const nextIntensity=clamp(Number(intensity)||0,0,1);
    let recolor=nextJoint!==this.highlightJoint||Math.abs(nextIntensity-this.intensity)>1e-5;
    if(color!=null){
      const nextColor=new THREE.Color(color);
      if(!this.color.equals(nextColor)){this.color.copy(nextColor);recolor=true;}
    }
    this.highlightJoint=nextJoint;this.intensity=nextIntensity;if(recolor)this.recolor();
    this.material.opacity=Number.isFinite(opacity)?clamp(opacity,0,1):1;
    this.material.depthTest=!xray;this.material.depthWrite=!xray&&this.material.opacity>=.99;
    this.mesh.renderOrder=xray?1000:0;
    this.group.userData.figureRig.lastUpdate++;
    this.group.userData.figureRig.highlightJoint=this.highlightJoint;
    this.group.userData.figureRig.intensity=this.intensity;
    this.group.userData.figureRig.validJoints=valid;
    return true;
  }

  setVisible(visible){this.group.visible=Boolean(visible);return this;}

  dispose(){
    this.geometry.dispose();this.material.dispose();this.skeleton.dispose();
    this.group.removeFromParent();this.group.clear();
  }
}

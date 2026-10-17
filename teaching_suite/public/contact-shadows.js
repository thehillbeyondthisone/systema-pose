import * as THREE from 'three';

/** Three analytic floor blobs per person, batched into one draw call.
 * No shadow maps, extra scene passes, blur textures or per-frame raycasts.
 */
export class ContactShadows{
  constructor({world,motion,floorY=0}){
    this.motion=motion;this.floorY=floorY;this.indices=new Map(motion.jointNames.map((name,i)=>[name,i]));
    const geometry=new THREE.PlaneGeometry(1,1),capacity=motion.people.length*3;
    this.opacity=new Float32Array(capacity);geometry.setAttribute('contactOpacity',new THREE.InstancedBufferAttribute(this.opacity,1).setUsage(THREE.DynamicDrawUsage));
    const material=new THREE.ShaderMaterial({transparent:true,depthWrite:false,depthTest:true,toneMapped:false,
      vertexShader:`attribute float contactOpacity; varying vec2 vShadowUv; varying float vShadowOpacity;
        void main(){vShadowUv=uv*2.0-1.0;vShadowOpacity=contactOpacity;
          gl_Position=projectionMatrix*modelViewMatrix*instanceMatrix*vec4(position,1.0);}`,
      fragmentShader:`varying vec2 vShadowUv; varying float vShadowOpacity;
        void main(){float radius=length(vShadowUv);float alpha=exp(-radius*radius*3.8)*(1.0-smoothstep(.65,1.0,radius))*vShadowOpacity;
          if(alpha<.001)discard;gl_FragColor=vec4(.035,.04,.05,alpha);}`});
    this.mesh=new THREE.InstancedMesh(geometry,material,capacity);this.mesh.name='Soft foot and body contact shadows';
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);this.mesh.frustumCulled=false;this.mesh.renderOrder=-20;this.mesh.count=0;
    this.group=new THREE.Group();this.group.name='Lightweight character grounding';this.group.userData.figureOverlay=true;
    this.group.add(this.mesh);world.add(this.group);this.transform=new THREE.Object3D();
  }
  update(people,visibleIds){
    let count=0;
    const stamp=(x,z,width,depth,angle,opacity)=>{
      if(![x,z,width,depth,angle,opacity].every(Number.isFinite))return;
      this.transform.position.set(x,this.floorY+.006,z);this.transform.rotation.set(-Math.PI/2,0,angle);this.transform.scale.set(width,depth,1);this.transform.updateMatrix();
      this.mesh.setMatrixAt(count,this.transform.matrix);this.opacity[count++]=opacity;
    };
    for(const person of people){
      if(!visibleIds.has(String(person.id)))continue;
      const at=name=>person.xyz[this.indices.get(name)],pelvis=at('pelvis');
      if(!pelvis?.every(Number.isFinite))continue;
      stamp(pelvis[0],pelvis[2],.85,.58,0,.12*Math.exp(-Math.max(0,pelvis[1]-this.floorY-1)*2));
      for(const side of ['left','right']){
        const ankle=at(side+'_ankle'),toe=at(side+'_foot')||ankle;if(!ankle?.every(Number.isFinite)||!toe?.every(Number.isFinite))continue;
        const height=Math.max(0,Math.min(ankle[1],toe[1])-this.floorY),spread=1+Math.min(height,.5)*1.6;
        const direction=Math.atan2(-(toe[2]-ankle[2]),toe[0]-ankle[0]);
        stamp((ankle[0]+toe[0])*.5,(ankle[2]+toe[2])*.5,.37*spread,.22*spread,direction,.28*Math.exp(-height*7));
      }
    }
    this.mesh.count=count;this.mesh.instanceMatrix.needsUpdate=true;this.mesh.geometry.attributes.contactOpacity.needsUpdate=true;
    this.group.userData.contactShadows={instances:count,drawCalls:count?1:0,triangles:count*2};
  }
  dispose(){this.mesh.geometry.dispose();this.mesh.material.dispose();this.group.removeFromParent();}
}

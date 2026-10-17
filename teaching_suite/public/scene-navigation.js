import * as THREE from 'three';

// Keep the action as the orbit's reference point. A room can optionally supply
// an inset box in its own scan coordinates, independent of its saved alignment.
export class SceneNavigation {
  constructor(camera,orbit){
    this.camera=camera;this.orbit=orbit;this.bounds=new THREE.Box3();
    this.focus=new THREE.Vector3();this.hasFocus=false;this.allowAboveCeiling=false;
    orbit.minDistance=.45;orbit.maxDistance=12;
    orbit.minPolarAngle=.04;orbit.maxPolarAngle=Math.PI*.72;
    orbit.screenSpacePanning=false;
  }
  setSubjects(people,{follow=false}={}){
    this.bounds.makeEmpty();
    for(const person of people)for(const xyz of person.xyz){
      if(xyz?.length>=3&&xyz.slice(0,3).every(Number.isFinite))this.bounds.expandByPoint(new THREE.Vector3(...xyz));
    }
    if(this.bounds.isEmpty())return;
    const focus=this.bounds.getCenter(new THREE.Vector3());
    if(follow&&this.hasFocus){
      const delta=focus.clone().sub(this.focus);
      this.orbit.target.add(delta);this.camera.position.add(delta);
    }
    this.focus.copy(focus);this.hasFocus=true;
    this.orbit.maxDistance=Math.max(4,this.bounds.getSize(new THREE.Vector3()).length()*3);
  }
  center(){
    if(!this.hasFocus)return;
    this.orbit.target.copy(this.focus);this.camera.up.set(0,1,0);this.camera.lookAt(this.focus);
  }
  roomVolume(environment){
    const nav=environment?.ready&&environment.visible&&environment.config.navigation;
    if(!nav||nav.coordinateSpace!=='scan-local'||!Number.isFinite(nav.rotationDegrees)||
      ![nav.min,nav.max].every(p=>Array.isArray(p)&&p.length===3&&p.every(Number.isFinite))||
      nav.min.some((value,i)=>nav.max[i]-value<.6))return null;
    environment.group.updateWorldMatrix(true,false);
    const matrix=environment.group.matrixWorld.clone().multiply(new THREE.Matrix4().makeRotationZ(THREE.MathUtils.degToRad(nav.rotationDegrees)));
    const clearance=Math.min(.18/environment.group.getWorldScale(new THREE.Vector3()).x,...nav.max.map((value,i)=>(value-nav.min[i])*.2));
    const min=new THREE.Vector3(...nav.min).addScalar(clearance),max=new THREE.Vector3(...nav.max).addScalar(-clearance);
    if(this.allowAboveCeiling)max.z+=this.orbit.maxDistance;
    return {matrix,inverse:matrix.clone().invert(),min,max};
  }
  constrain(environment){
    const {camera,orbit}=this,volume=this.roomVolume(environment);
    if(volume){
      const target=orbit.target.clone().applyMatrix4(volume.inverse);
      const clamped=target.clone().clamp(volume.min,volume.max);
      // Panning moves the camera and pivot together until the pivot meets the
      // inset boundary; shorten the viewing ray before the camera meets a wall.
      if(!clamped.equals(target)){
        const worldTarget=clamped.clone().applyMatrix4(volume.matrix);
        camera.position.add(worldTarget.clone().sub(orbit.target));orbit.target.copy(worldTarget);
      }
      const position=camera.position.clone().applyMatrix4(volume.inverse),delta=position.sub(clamped);
      let fraction=1;
      for(const axis of ['x','y','z']){
        if(delta[axis]>1e-8)fraction=Math.min(fraction,(volume.max[axis]-clamped[axis])/delta[axis]);
        else if(delta[axis]<-1e-8)fraction=Math.min(fraction,(volume.min[axis]-clamped[axis])/delta[axis]);
      }
      camera.position.copy(clamped.addScaledVector(delta,Math.max(0,fraction)).applyMatrix4(volume.matrix));
    }else if(camera.position.y<.12){
      // Unregistered lessons still get a floor and bounded zoom. Do not infer
      // walls from the participants' movement or a noisy scan bounding box.
      camera.position.y=.12;
    }
    camera.lookAt(orbit.target);camera.updateMatrixWorld(true);
  }
  fitProjection(){
    if(this.bounds.isEmpty())return;
    this.camera.updateMatrixWorld(true);
    let tangent=Math.tan(THREE.MathUtils.degToRad(48)/2);
    for(const x of [this.bounds.min.x,this.bounds.max.x])for(const y of [this.bounds.min.y,this.bounds.max.y])for(const z of [this.bounds.min.z,this.bounds.max.z]){
      const point=new THREE.Vector3(x,y,z).applyMatrix4(this.camera.matrixWorldInverse);
      if(point.z<-.05)tangent=Math.max(tangent,Math.abs(point.y)/-point.z*1.15,Math.abs(point.x)/(-point.z*this.camera.aspect)*1.15);
    }
    this.camera.fov=THREE.MathUtils.clamp(THREE.MathUtils.radToDeg(2*Math.atan(tangent)),48,85);
    this.camera.updateProjectionMatrix();
  }
}

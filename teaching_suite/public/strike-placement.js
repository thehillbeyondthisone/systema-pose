import * as THREE from 'three';

const finitePoint=value=>Array.isArray(value)&&value.length===3&&value.every(Number.isFinite);
const raycaster=new THREE.Raycaster();

function activeRig(object){
  if(!object?.group.visible)return null;
  for(const rig of object.customRigs?.values()||[])if(rig.group.visible)return rig;
  return object.rig?.group.visible?object.rig:null;
}

function jointPoint(rig,name){
  const bone=rig.asset?rig.boneMap?.get(rig.asset.mapping?.[name]):rig.bones?.[rig.jointNames?.indexOf(name)];
  return bone?.getWorldPosition(new THREE.Vector3())||null;
}

/** Map an estimated body region onto the currently posed character's skin.
 * The source trajectory and event timing remain captured-motion estimates.
 */
export function resolveStrikeLanding(event,{target,source,frame}={}){
  const rig=activeRig(target);if(!rig)return null;
  const segment=event.targetSegment;
  const a=jointPoint(rig,segment?.start||segment?.[0]||event.targetJoint);
  const b=jointPoint(rig,segment?.end||segment?.[1]||event.targetJoint);
  if(!a)return null;
  const center=b?a.clone().lerp(b,THREE.MathUtils.clamp(event.targetFraction??segment?.fraction??0,0,1)):a.clone();
  const sourceRig=activeRig(source),sourcePoint=sourceRig&&jointPoint(sourceRig,event.limb);
  let normal=sourcePoint?.sub(center).normalize();
  if(!normal||normal.lengthSq()<1e-8){
    normal=finitePoint(event.surfaceOffset)?new THREE.Vector3(...event.surfaceOffset).normalize():new THREE.Vector3(0,0,1);
    if(normal.lengthSq()<1e-8)normal.set(0,0,1);
  }
  const meshes=(rig.meshes||[rig.mesh]).filter(mesh=>mesh?.isMesh&&mesh.visible);
  if(!meshes.length)return {point:center,normal};
  // Animated meshes have moving bounds. Refresh them once per selected frame,
  // then raycast only this target, excluding the studio and other characters.
  let reach=1;
  for(const mesh of meshes){
    if(mesh.isSkinnedMesh){
      if(mesh.userData.strikeBoundsFrame!==frame){mesh.computeBoundingSphere();mesh.userData.strikeBoundsFrame=frame;}
    }else if(!mesh.geometry.boundingSphere)mesh.geometry.computeBoundingSphere();
    const sphere=mesh.isSkinnedMesh?mesh.boundingSphere:mesh.geometry.boundingSphere;
    if(sphere){
      const worldSphere=sphere.clone().applyMatrix4(mesh.matrixWorld);
      reach=Math.max(reach,center.distanceTo(worldSphere.center)+worldSphere.radius+.1);
    }
  }
  raycaster.set(center.clone().addScaledVector(normal,reach),normal.clone().negate());
  raycaster.near=0;raycaster.far=reach*2;
  const hit=raycaster.intersectObjects(meshes,false)[0];
  return {point:hit?hit.point.clone().addScaledVector(normal,.008):center,normal};
}

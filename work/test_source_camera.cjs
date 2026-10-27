const assert=require('node:assert/strict');
(async()=>{
  const {hasSourceCameraData,sourceIntrinsics}=await import('../teaching_suite/public/source-camera.mjs');
  const camera={Rcw:Array(6).fill([]),Tcw:Array(6).fill([]),img_focal:800,img_center:[640,360]};
  assert(hasSourceCameraData(camera,6));
  assert.equal(sourceIntrinsics(camera,5),camera);
  camera.shots=[{startFrame:0,endFrame:4,img_focal:800,img_center:[640,360]},
    {startFrame:4,endFrame:6,img_focal:1200,img_center:[640,360]}];
  assert(hasSourceCameraData(camera,6));
  for(const [frame,focal] of [[0,800],[3,800],[4,1200],[5,1200]])assert.equal(sourceIntrinsics(camera,frame).img_focal,focal);
  assert.equal(sourceIntrinsics(camera,6),undefined);
  for(const start of [3,5,4.5]){
    camera.shots[1].startFrame=start;assert(!hasSourceCameraData(camera,6));
  }
  camera.shots[1].startFrame=4;
  camera.shots[1].img_focal=NaN;assert(!hasSourceCameraData(camera,6));
  camera.shots[1].img_focal=1200;
  camera.shots[1].endFrame=7;assert(!hasSourceCameraData(camera,6));
  camera.shots[1].endFrame=5;assert(!hasSourceCameraData(camera,6));
  camera.shots={};assert(!hasSourceCameraData(camera,6));assert.equal(sourceIntrinsics(camera,0),undefined);
  camera.shots=[null];assert(!hasSourceCameraData(camera,6));assert.equal(sourceIntrinsics(camera,0),undefined);
  assert(!hasSourceCameraData(null,6));
  console.log('PASS legacy calibration, shot boundary selection, gaps, overlaps, invalid intrinsics and coverage');
})();

// A cut starts a new camera calibration; pose arrays still use the lesson timeline.
const validIntrinsics=data=>Boolean(data&&Number.isFinite(data.img_focal)&&data.img_focal>0&&
  data.img_center?.length===2&&data.img_center.every(value=>Number.isFinite(value)&&value>0));

export function sourceIntrinsics(camera,frame=0){
  if(!camera?.shots)return camera;
  if(!Array.isArray(camera.shots))return undefined;
  return camera.shots.find(shot=>shot&&shot.startFrame<=frame&&frame<shot.endFrame);
}

export function hasSourceCameraData(camera,frameCount){
  if(!camera||camera.Rcw?.length!==frameCount||camera.Tcw?.length!==frameCount)return false;
  if(!camera.shots)return validIntrinsics(camera);
  if(!Array.isArray(camera.shots)||!camera.shots.length)return false;
  let end=0;
  for(const shot of camera.shots){
    if(!shot||!Number.isInteger(shot.startFrame)||!Number.isInteger(shot.endFrame)||
      shot.startFrame!==end||shot.endFrame<=end||shot.endFrame>frameCount||!validIntrinsics(shot))return false;
    end=shot.endFrame;
  }
  return end===frameCount;
}

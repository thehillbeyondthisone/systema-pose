"""Fit the epoch-30 studio scan to this lesson, with an exact floor constraint."""
import sys,json,hashlib
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'work/runtime'))
import cv2,numpy as np
from scipy.spatial import cKDTree
from scipy.spatial.transform import Rotation
from scipy.optimize import least_squares
OUT=ROOT/'outputs/epoch30-striking-registration';OUT.mkdir(exist_ok=True)
SCAN=Path('C:/Users/thefo/OneDrive/Documents/share/Systema/2026-10-17_07-57-33_3DGS')
CLIP=ROOT/'site/clips/systema-striking-and-pad-work'
scene=json.loads((CLIP/'scene.json').read_text());motion=json.loads((CLIP/'motion.json').read_text());camera=scene['camera']
dt=np.dtype([('p','<f4',3),('s','<f4',3),('c','u1',4),('q','u1',4)])
a=np.fromfile(ROOT/'teaching_suite/public/studio/studio.splat',dt);points=a['p'][(a['c'][:,3]>150)&(a['s'].max(axis=1)<.08)][::2].astype(float)
floor=points[(points[:,2]>-1.62)&(points[:,2]<-1.43)]
for _ in range(5):
 coeff=np.linalg.lstsq(np.c_[floor[:,:2],np.ones(len(floor))],floor[:,2],rcond=None)[0];err=np.abs(floor[:,2]-np.c_[floor[:,:2],np.ones(len(floor))]@coeff);floor=floor[err<.018]
normal=np.array([-coeff[0],-coeff[1],1.]);normal/=np.linalg.norm(normal);plane_d=float(-coeff[2]/np.sqrt(1+sum(coeff[:2]**2)))
print('FLOOR',normal,plane_d,'points',len(floor),flush=True)
cache=OUT/'scan-features.npz';sift=cv2.SIFT_create(nfeatures=18000,contrastThreshold=.008)
if cache.exists():
 c=np.load(cache);descriptors=c['descriptors'];xyz=c['xyz']
else:
 descriptors=[];xyz=[];photos=SCAN/'output/undistort';poses=json.loads((photos/'TransformedCam.json').read_text())['frames'];byname={Path(p['file_path']).name:p for p in poses}
 for side in ['left','right']:
  Kscan=np.loadtxt(photos/(side+'_undistort_intrinsic.txt'))
  for photo in sorted((photos/side).glob('*.jpg'))[::20]:
   im=cv2.imread(str(photo));h,w=im.shape[:2];factor=1400/w;im=cv2.resize(im,(1400,round(h*factor)));h,w=im.shape[:2];k,desc=sift.detectAndCompute(cv2.cvtColor(im,cv2.COLOR_BGR2GRAY),None)
   transform=np.array(byname[photo.name]['transform_matrix']);pc=-(points-transform[:3,3])@transform[:3,:3];ids=np.flatnonzero(pc[:,2]>.15);pc=pc[ids];uv=pc[:,:2]/pc[:,2:]*Kscan[[0,1],[0,1]]*factor+Kscan[:2,2]*factor;pix=np.rint(uv).astype(int);good=(pix[:,0]>=0)&(pix[:,0]<w)&(pix[:,1]>=0)&(pix[:,1]<h);ids=ids[good];pc=pc[good];uv=uv[good];pix=pix[good];depth=np.full(w*h,np.inf);flat=pix[:,1]*w+pix[:,0];np.minimum.at(depth,flat,pc[:,2]);visible=pc[:,2]<depth[flat]+.025;uv=uv[visible];ids=ids[visible]
   distance,nearest=cKDTree(uv).query(np.array([p.pt for p in k]));valid=distance<1.6
   descriptors.extend(desc[valid]);xyz.extend(points[ids[nearest[valid]]]);print('PHOTO',photo.name,sum(valid),flush=True)
 descriptors=np.asarray(descriptors,np.float32);xyz=np.asarray(xyz);np.savez_compressed(cache,descriptors=descriptors,xyz=xyz)
print('FEATURES',len(descriptors),flush=True)
index=cv2.FlannBasedMatcher(dict(algorithm=1,trees=6),dict(checks=120));index.add([descriptors]);index.train()
cap=cv2.VideoCapture(str(CLIP/'source.mp4'));anchors=[]
frames=[0,150,450,900,1350,1800,2250,2700,2821,2822,2900,3100,3300,3500,3700,3907]
for frame in frames:
 cap.set(cv2.CAP_PROP_POS_FRAMES,frame);ok,im=cap.read();assert ok
 shot=next(s for s in camera['shots'] if s['startFrame']<=frame<s['endFrame']);K=np.array([[shot['img_focal'],0,640],[0,shot['img_focal'],360],[0,0,1.]])
 mask=np.full(im.shape[:2],255,np.uint8)
 for person in motion['frames'][frame]['people']:
  x0,y0,x1,y1=person['bbox'];cv2.rectangle(mask,(int(x0)-12,int(y0)-12),(int(x1)+12,int(y1)+12),0,-1)
 k,desc=sift.detectAndCompute(cv2.cvtColor(im,cv2.COLOR_BGR2GRAY),mask);selected=[]
 if desc is None:continue
 for candidates in index.knnMatch(desc,k=20):
  first=candidates[0];other=next((v for v in candidates[1:] if np.linalg.norm(xyz[v.trainIdx]-xyz[first.trainIdx])>.20),None)
  if other is not None and first.distance<.86*other.distance:selected.append(first)
 if len(selected)<8:print('REJECT',frame,'matches',len(selected),flush=True);continue
 obj=np.array([xyz[p.trainIdx] for p in selected]);uv=np.array([k[p.queryIdx].pt for p in selected]);ok,r,t,inliers=cv2.solvePnPRansac(obj,uv,K,None,iterationsCount=15000,reprojectionError=4,confidence=.999,flags=cv2.SOLVEPNP_EPNP)
 if not ok or inliers is None or len(inliers)<8:print('REJECT',frame,'inliers',0 if inliers is None else len(inliers),flush=True);continue
 ids=inliers.ravel();r,t=cv2.solvePnPRefineLM(obj[ids],uv[ids],K,None,r,t);R=cv2.Rodrigues(r)[0];eye=(-R.T@t).ravel();err=np.linalg.norm(cv2.projectPoints(obj[ids],r,t,K,None)[0].reshape(-1,2)-uv[ids],axis=1)
 if not -1<eye[2]<1.2 or R[1,2]>-.75:print('REJECT',frame,'camera',eye,flush=True);continue
 anchor=dict(frame=frame,Rcs=R.tolist(),Tcs=t.ravel().tolist(),cameraScan=eye.tolist(),rms=float(np.sqrt(np.mean(err**2))),scan=obj[ids].tolist(),source=uv[ids].tolist());anchors.append(anchor);print('ANCHOR',frame,len(ids),anchor['rms'],eye,flush=True)
# Extend reliable scan-photo seeds through the much sharper source footage.
for seed in list(anchors):
 f0=seed['frame'];shot=next(s for s in camera['shots'] if s['startFrame']<=f0<s['endFrame']);K=np.array([[shot['img_focal'],0,640],[0,shot['img_focal'],360],[0,0,1.]])
 cap.set(1,f0);ok,im=cap.read();mask=np.full(im.shape[:2],255,np.uint8)
 for person in motion['frames'][f0]['people']:
  x0,y0,x1,y1=person['bbox'];cv2.rectangle(mask,(int(x0)-12,int(y0)-12),(int(x1)+12,int(y1)+12),0,-1)
 k0,d0=sift.detectAndCompute(cv2.cvtColor(im,cv2.COLOR_BGR2GRAY),mask)
 pc=points@np.array(seed['Rcs']).T+seed['Tcs'];ids=np.flatnonzero(pc[:,2]>.2);pc=pc[ids];uv=pc[:,:2]/pc[:,2:]*shot['img_focal']+[640,360];pix=np.rint(uv).astype(int);good=(pix[:,0]>=0)&(pix[:,0]<1280)&(pix[:,1]>=0)&(pix[:,1]<720);ids=ids[good];pc=pc[good];uv=uv[good];pix=pix[good];depth=np.full(1280*720,np.inf);flat=pix[:,1]*1280+pix[:,0];np.minimum.at(depth,flat,pc[:,2]);visible=pc[:,2]<depth[flat]+.03;uv=uv[visible];ids=ids[visible];dist,nearest=cKDTree(uv).query(np.array([k.pt for k in k0]));valid=dist<1.8;seed_desc=d0[valid];seed_xyz=points[ids[nearest[valid]]];print('SEED',f0,len(seed_xyz),flush=True)
 for frame in frames:
  if not shot['startFrame']<=frame<shot['endFrame'] or frame==f0:continue
  cap.set(1,frame);ok,im=cap.read();mask=np.full(im.shape[:2],255,np.uint8)
  for person in motion['frames'][frame]['people']:
   x0,y0,x1,y1=person['bbox'];cv2.rectangle(mask,(int(x0)-12,int(y0)-12),(int(x1)+12,int(y1)+12),0,-1)
  k,desc=sift.detectAndCompute(cv2.cvtColor(im,cv2.COLOR_BGR2GRAY),mask)
  if desc is None:continue
  matches=[m for m,n in cv2.BFMatcher().knnMatch(desc,seed_desc,k=2) if m.distance<.72*n.distance]
  if len(matches)<12:continue
  obj=np.array([seed_xyz[m.trainIdx] for m in matches]);uv=np.array([k[m.queryIdx].pt for m in matches]);ok,r,t,ids=cv2.solvePnPRansac(obj,uv,K,None,iterationsCount=10000,reprojectionError=3,confidence=.999,flags=cv2.SOLVEPNP_EPNP)
  if not ok or ids is None or len(ids)<12:continue
  ids=ids.ravel();r,t=cv2.solvePnPRefineLM(obj[ids],uv[ids],K,None,r,t);R=cv2.Rodrigues(r)[0];eye=(-R.T@t).ravel()
  if np.linalg.norm(eye-seed['cameraScan'])>1.5 or R[1,2]>-.75:continue
  err=np.linalg.norm(cv2.projectPoints(obj[ids],r,t,K,None)[0].reshape(-1,2)-uv[ids],axis=1)
  anchors=[a for a in anchors if a['frame']!=frame];anchors.append(dict(frame=frame,Rcs=R.tolist(),Tcs=t.ravel().tolist(),cameraScan=eye.tolist(),rms=float(np.sqrt(np.mean(err**2))),scan=obj[ids].tolist(),source=uv[ids].tolist()));print('EXTENDED',frame,len(ids),float(np.sqrt(np.mean(err**2))),flush=True)
anchors.sort(key=lambda a:a['frame'])
(OUT/'anchors.json').write_text(json.dumps(anchors,indent=2));(OUT/'floor.json').write_text(json.dumps(dict(normal=normal.tolist(),d=plane_d,points=len(floor))))
# Restrict room scale and translation to a level floor, then fit stationary room features.
fits=[]
for shot in camera['shots']:
 subset=[a for a in anchors if shot['startFrame']<=a['frame']<shot['endFrame']]
 if not subset:continue
 first=subset[0];rcs=np.array(first['Rcs']);right=rcs[0]-normal*np.dot(rcs[0],normal);right/=np.linalg.norm(right);basis=np.array([right,normal,np.cross(right,normal)]);target=np.array(camera['Rcw'][first['frame']])[0];target[1]=0;target/=np.linalg.norm(target);base=np.array([target,[0,1,0],np.cross(target,[0,1,0])]).T@basis
 def transform(v):
  R=Rotation.from_euler('y',v[0]).as_matrix()@base;return R,np.array([v[1],v[3]*plane_d,v[2]]),v[3]
 def residual(v):
  R,T,s=transform(v);errors=[]
  for a in subset:
   f=a['frame'];intr=next(x for x in camera['shots'] if x['startFrame']<=f<x['endFrame']);pc=(np.array(a['scan'])@R.T*s+T)@np.array(camera['Rcw'][f]).T+camera['Tcw'][f];uv=pc[:,:2]/np.maximum(pc[:,2:],.05)*intr['img_focal']+[640,360];errors.extend((uv-np.array(a['source'])).ravel())
  return np.array(errors)
 eye=-np.array(camera['Rcw'][first['frame']]).T@np.array(camera['Tcw'][first['frame']]);scale=float(eye[1]/(np.dot(first['cameraScan'],normal)+plane_d));T=eye-scale*base@np.array(first['cameraScan']);initial=[0,T[0],T[2],scale]
 fit=least_squares(residual,initial,loss='soft_l1',f_scale=4,max_nfev=400,bounds=([-1.2,-30,-30,.15],[1.2,30,30,3.]));R,T,s=transform(fit.x);angles=Rotation.from_matrix(R).as_euler('YXZ',degrees=True);alignment=dict(zip(['x','y','z'],T.tolist()));alignment.update(yaw=float(angles[0]),pitch=float(angles[1]),roll=float(angles[2]),scale=float(s));error=np.abs(residual(fit.x));entry=dict(startFrame=shot['startFrame'],endFrame=shot['endFrame'],alignment=alignment,anchorFrames=[a['frame'] for a in subset],pixelResidualQuantiles=np.percentile(error,[25,50,75,90]).tolist());fits.append(entry);print('FIT',entry,flush=True)
(OUT/'fits.json').write_text(json.dumps(fits,indent=2))

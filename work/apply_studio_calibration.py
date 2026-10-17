"""Apply a reviewed scan registration/camera trajectory to an existing pose scene.

Standard library only. Re-expresses each frame through its calibrated source
camera while preserving camera-space anatomy and within-frame contact geometry.
"""
import argparse
import bisect
import hashlib
import json
import math
from pathlib import Path

def transpose(a):return [list(x) for x in zip(*a)]
def matmul(a,b):return [[sum(x*y for x,y in zip(row,col)) for col in zip(*b)] for row in a]
def matvec(a,v):return [sum(x*y for x,y in zip(row,v)) for row in a]
def add(a,b):return [x+y for x,y in zip(a,b)]
def sub(a,b):return [x-y for x,y in zip(a,b)]
def scale(v,s):return [s*x for x in v]

def quaternion(matrix):
    m=matrix;trace=sum(m[i][i] for i in range(3))
    if trace>0:
        k=math.sqrt(trace+1)*2
        q=[(m[2][1]-m[1][2])/k,(m[0][2]-m[2][0])/k,(m[1][0]-m[0][1])/k,.25*k]
    else:
        i=max(range(3),key=lambda i:m[i][i]);j=(i+1)%3;k=(i+2)%3
        f=math.sqrt(max(0,1+m[i][i]-m[j][j]-m[k][k]))*2
        q=[0,0,0,0];q[i]=.25*f;q[j]=(m[j][i]+m[i][j])/f;q[k]=(m[k][i]+m[i][k])/f;q[3]=(m[k][j]-m[j][k])/f
    length=math.sqrt(sum(x*x for x in q));return [x/length for x in q]

def rotation(q):
    x,y,z,w=q
    return [[1-2*(y*y+z*z),2*(x*y-z*w),2*(x*z+y*w)],
            [2*(x*y+z*w),1-2*(x*x+z*z),2*(y*z-x*w)],
            [2*(x*z-y*w),2*(y*z+x*w),1-2*(x*x+y*y)]]

def slerp(a,b,t):
    dot=sum(x*y for x,y in zip(a,b))
    if dot<0:b=scale(b,-1);dot=-dot
    if dot>.9995:
        q=add(scale(a,1-t),scale(b,t));norm=math.sqrt(sum(x*x for x in q));return scale(q,1/norm)
    theta=math.acos(max(-1,min(1,dot)));den=math.sin(theta)
    return add(scale(a,math.sin((1-t)*theta)/den),scale(b,math.sin(t*theta)/den))

def apply(source,calibration,output):
    raw=source.read_bytes();data=json.loads(raw);record=json.loads(calibration.read_text(encoding='utf-8'))
    if hashlib.sha256(raw).hexdigest()!=record['inputSceneSha256']:
        raise ValueError('Calibration requires the original reconstruction scene, not an already calibrated copy.')
    if data['sourceSha256']!=record['sourceSha256']:
        raise ValueError('Calibration and scene refer to different source footage.')
    original=data['camera'];transform=record['scanToWorld'];rws=transform['rotation'];tws=transform['translation'];factor=transform['scale']
    anchors=record['cameraAnchors'];times=[a['frame'] for a in anchors]
    if times[0]!=0 or times[-1]!=len(data['frames'])-1 or times!=sorted(set(times)):
        raise ValueError('Camera anchors must cover the complete scene in order.')
    centers=[scale(matvec(transpose(a['Rcs']),a['Tcs']),-1) for a in anchors]
    quats=[quaternion(a['Rcs']) for a in anchors]
    updated={key:value for key,value in original.items() if key not in ['Rcw','Tcw','Rwc','Twc']}
    for key in ['Rcw','Tcw','Rwc','Twc']:updated[key]=[]
    updated['calibrationId']=record['id']
    max_error=0
    for frame in data['frames']:
        i=frame['frame'];upper=min(len(times)-1,bisect.bisect_right(times,i));lower=max(0,upper-1)
        blend=(i-times[lower])/(times[upper]-times[lower]) if upper!=lower else 0
        center=add(scale(centers[lower],1-blend),scale(centers[upper],blend));rcs=rotation(slerp(quats[lower],quats[upper],blend));tcs=scale(matvec(rcs,center),-1)
        rnew=matmul(rcs,transpose(rws));tnew=sub(scale(tcs,factor),matvec(rnew,tws));rwc=transpose(rnew);cworld=scale(matvec(rwc,tnew),-1)
        for key,value in [('Rcw',rnew),('Tcw',tnew),('Rwc',rwc),('Twc',cworld)]:updated[key].append(value)
        for person in frame['people']:
            transformed=[]
            for xyz in person['xyz']:
                old_camera=add(matvec(original['Rcw'][i],xyz),original['Tcw'][i])
                new_point=matvec(rwc,sub(old_camera,tnew));check=add(matvec(rnew,new_point),tnew)
                max_error=max(max_error,max(abs(a-b) for a,b in zip(old_camera,check)))
                transformed.append(new_point)
            person['xyz']=transformed
    data['camera']=updated
    data['roomCalibration']={key:record[key] for key in ['id','sourceSha256','scanSourceSha256','method','scaleBasis','rejectedAnchorFrames']}
    data['roomCalibration']['maxCameraSpaceJointError']=max_error
    data['roomCalibration']['cameraAnchorFrames']=times
    data['roomCalibration']['note']='Scan-calibrated camera stabilization; original estimated anatomy, depth and within-frame contacts are preserved.'
    data['scaleVerified']=False
    output.parent.mkdir(parents=True,exist_ok=True)
    output.write_text(json.dumps(data,separators=(',',':'))+'\n',encoding='utf-8')
    print(f'Applied {len(anchors)} scan-camera anchors to {len(data["frames"])} frames. Maximum camera-space joint difference: {max_error:.3g}')

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source',type=Path,required=True)
    parser.add_argument('--calibration',type=Path,required=True)
    parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args();apply(args.source,args.calibration,args.output)

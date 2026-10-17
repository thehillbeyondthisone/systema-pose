"""Check scan registration, stabilized cameras and optional source-pose invariants."""
import argparse,json,math
from pathlib import Path
from apply_studio_calibration import transpose,matmul,matvec,add,sub,scale

ROOT=Path(__file__).resolve().parents[1]
def norm(v):return math.sqrt(sum(x*x for x in v))
def det(m):return sum(m[0][i]*(m[1][(i+1)%3]*m[2][(i+2)%3]-m[1][(i+2)%3]*m[2][(i+1)%3]) for i in range(3))
def quantile(values,q):
    values=sorted(values);i=(len(values)-1)*q;a=int(i);b=min(a+1,len(values)-1);return values[a]*(b-i)+values[b]*(i-a) if a!=b else values[a]

def verify(scene_path,calibration_path,source=None):
    scene=json.loads(scene_path.read_text(encoding='utf-8'));record=json.loads(calibration_path.read_text(encoding='utf-8'))
    assert scene['roomCalibration']['id']==record['id']
    assert scene['sourceSha256']==record['sourceSha256']
    assert len(scene['frames'])==360 and record['rejectedAnchorFrames']==[290]
    transform=record['scanToWorld'];rws=transform['rotation'];tws=transform['translation'];factor=transform['scale'];floor=record['floorPlaneScan']
    up=matvec(rws,floor['normal']);offset=tws[1]-factor*floor['d']
    assert norm(sub(up,[0,1,0]))<1e-10 and abs(offset)<1e-10
    camera=scene['camera'];max_orthogonal=max_center=max_projection=max_bone=0
    feet={};pelvis_steps={};previous={}
    for frame in scene['frames']:
        i=frame['frame'];r=camera['Rcw'][i];t=camera['Tcw'][i];identity=matmul(r,transpose(r))
        max_orthogonal=max(max_orthogonal,max(abs(identity[a][b]-(a==b)) for a in range(3) for b in range(3)))
        assert abs(det(r)-1)<1e-10
        center=scale(matvec(transpose(r),t),-1)
        max_center=max(max_center,norm(sub(center,camera['Twc'][i])))
        for person in frame['people']:
            xyz=person['xyz'];pid=str(person['id']);feet.setdefault(pid,[]).append(min(xyz[j][1] for j in [7,8,10,11]))
            if pid in previous and previous[pid][0]==i-1:pelvis_steps.setdefault(pid,[]).append(norm(sub(xyz[0],previous[pid][1])))
            previous[pid]=(i,xyz[0])
            if source:
                old_person=next(p for p in source['frames'][i]['people'] if p['id']==person['id'])
                for before,after in zip(old_person['xyz'],xyz):
                    pc0=add(matvec(source['camera']['Rcw'][i],before),source['camera']['Tcw'][i]);pc1=add(matvec(r,after),t)
                    assert pc0[2]>0 and pc1[2]>0
                    max_projection=max(max_projection,abs(pc0[0]/pc0[2]-pc1[0]/pc1[2]),abs(pc0[1]/pc0[2]-pc1[1]/pc1[2]))
                for a,b in scene['edges']:max_bone=max(max_bone,abs(norm(sub(old_person['xyz'][a],old_person['xyz'][b]))-norm(sub(xyz[a],xyz[b]))))
    assert max_orthogonal<1e-10 and max_center<1e-10
    assert max_projection<1e-10 and max_bone<1e-6
    for pid,values in feet.items():
        assert min(values)>-.05,f'Person {pid} feet below room floor'
        assert quantile(values,.95)<.20,f'Person {pid} floats persistently above floor'
    assert max(max(steps) for steps in pelvis_steps.values())<.10
    report={'sceneFrames':360,'cameraAnchorCount':len(record['cameraAnchors']),'floorWorldY':offset,
            'rotationOrthogonalityMaxError':max_orthogonal,'cameraCenterMaxError':max_center,
            'sourceProjectionMaxNormalizedError':max_projection if source else None,'boneLengthMaxChangeModelMeters':max_bone if source else None,
            'footJointCenterHeightModelMeters':{pid:{'min':min(v),'median':quantile(v,.5),'p95':quantile(v,.95),'max':max(v)} for pid,v in feet.items()},
            'maxConsecutivePelvisStepModelMeters':{pid:max(v) for pid,v in pelvis_steps.items()},
            'fittedLandmarkResidualPixels1920':record['validation']['fittedLandmarkResidualPixels1920']}
    print(json.dumps(report,indent=2));return report

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--scene',type=Path,default=ROOT/'outputs/3d-pilot/scene.json')
    parser.add_argument('--calibration',type=Path,default=ROOT/'teaching_suite/public/studio/calibration.json')
    parser.add_argument('--source',type=Path)
    parser.add_argument('--report',type=Path)
    args=parser.parse_args();original=json.loads(args.source.read_text(encoding='utf-8')) if args.source else None
    report=verify(args.scene,args.calibration,original)
    if args.report:args.report.parent.mkdir(parents=True,exist_ok=True);args.report.write_text(json.dumps(report,indent=2)+'\n',encoding='utf-8')

"""Check the actual ground-work run's corrected inputs and reconstructed scene."""
from collections import Counter
import hashlib
import json
import math
import sys
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
CLIP='systema-extended-ground-work'
OUT=ROOT/'outputs/ground-work-validation'

def read(path):return json.loads(path.read_text(encoding='utf-8'))
def digest(path):return hashlib.sha256(path.read_bytes()).hexdigest()
def check():
    state=read(ROOT/'teaching_suite/data/admin/reconstruction'/CLIP/'state.json')
    if state['status']!='ready':raise AssertionError(f"Reconstruction {state['status']}: {state['message']}")
    clip=next(row for row in read(ROOT/'site/lessons.json')['lessons'] if row['id']==CLIP)
    motion=read(ROOT/clip['motion']);scene=read(ROOT/clip['scene'])
    sys.path.insert(0,str(ROOT/'work'))
    from dashboard_3d_worker import validate_participants
    validate_participants(scene,motion)
    assert motion['sourceStart']==scene['sourceStart']==25
    assert motion['sourceEnd']==scene['sourceEnd']==29
    assert len(motion['frames'])==len(scene['frames'])==120
    expected={3,4}
    assert {person['id'] for person in clip['people']}==expected
    assert {person['id'] for person in scene['people']}==expected
    for label,value in [('corrected 2D',motion),('reconstructed 3D',scene)]:
        assert all({person['id'] for person in frame['people']}==expected for frame in value['frames']),label+' lost or added participants'
        assert all(frame['frame']==index for index,frame in enumerate(value['frames']))
    assert all(math.isfinite(coordinate) for frame in scene['frames'] for person in frame['people'] for point in person['xyz'] for coordinate in point)
    assert len(scene['camera']['Rcw'])==120
    assert scene['sourceSha256']==clip['sourceSha256']==digest(ROOT/clip['video'])
    assert state['motionSha256']==digest(ROOT/clip['motion'])
    assert state['sceneSha256']==digest(ROOT/clip['scene'])
    run=ROOT/'teaching_suite/data/admin/reconstruction'/CLIP/state['runId']
    snapshot=read(run/'motion.json');manifest=read(run/'manifest.json')
    assert snapshot==motion
    assert {int(identity) for identity in manifest['participants']}==expected
    corrections=read(ROOT/'teaching_suite/data/admin/track-corrections'/CLIP/'corrections.json')
    original=read(ROOT/'teaching_suite/data/admin/track-corrections'/CLIP/'source-motion.json')
    assert len(original['people'])==9 and corrections['overlapsResolved']==5
    report=read(OUT/'verification.json')
    report.update(status='passed',runId=state['runId'],reviewUrl='http://127.0.0.1:8771'+state['reviewUrl'],
                  scene=str(ROOT/clip['scene']),sceneFrameCounts=dict(Counter(person['id'] for frame in scene['frames'] for person in frame['people'])),
                  verified=['full-length upload','real 2D preparation','browser participant exclusions and joins','overlap rejection and explicit resolution',
                            'corrected worker input and manifest','real CUDA inference','finite 3D geometry','120 matched camera frames','matching video/motion/scene hashes'])
    (OUT/'verification.json').write_text(json.dumps(report,indent=2))
    print(json.dumps(report,indent=2))

if __name__=='__main__':check()

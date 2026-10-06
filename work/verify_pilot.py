import hashlib
import importlib.metadata
import json
import shutil
import subprocess
import time
import zipfile
from collections import Counter
from pathlib import Path

import cv2
import imageio_ffmpeg
import numpy as np
from PIL import Image
from pose_runtime import ROOT

OUT=ROOT/'outputs'/'pilot'
meta=json.loads((ROOT/'work'/'source-metadata.json').read_text())
rows=[json.loads(line) for line in (OUT/'poses-tracked.jsonl').read_text().splitlines()]
assert len(rows)==360
assert [r['source_frame_index'] for r in rows]==list(range(540,900))
assert len({r['pilot_frame_index'] for r in rows})==360
pts_error=max(abs(r['source_timestamp_s']-r['nominal_source_timestamp_s']) for r in rows)
assert pts_error < 1/30000
for row in rows:
    ids=[p['track_id'] for p in row['people'] if p['track_id']]
    assert len(ids)==len(set(ids))
    for person in row['people']:
        assert len(person['keypoints_xy'])==len(person['confidence'])==133
        assert np.isfinite(person['keypoints_xy']).all()
checks={'data_frames':360,'source_frame_interval':[540,900],'max_pts_error_seconds':pts_error,
        'source_sha256_unchanged': hashlib.file_digest(Path(meta['path']).open('rb'),'sha256').hexdigest()==meta['sha256'],
        'png_sequences':{},'videos':{}}
assert checks['source_sha256_unchanged']
for folder,expected in [('transparent-frames',(1920,1080)),('illustration-frames',(1080,1440))]:
    paths=sorted((OUT/folder).glob('*.png'))
    assert len(paths)==360
    mixed,empty=0,0
    for path in paths:
        with Image.open(path) as im:
            assert im.mode=='RGBA' and im.size==expected
            a=np.array(im.getchannel('A'))
            assert np.any(a==0)
            mixed+=bool(np.any((a>0)&(a<255)))
            empty+=bool(np.max(a)==0)
    checks['png_sequences'][folder]={'frames':360,'rgba':True,'dimensions':expected,
                                    'frames_with_antialiased_alpha':mixed,'empty_frames':empty,
                                    'bytes':sum(p.stat().st_size for p in paths)}
ffmpeg=imageio_ffmpeg.get_ffmpeg_exe()
mov=OUT/'skeleton-alpha-prores4444.mov'
subprocess.run([ffmpeg,'-hide_banner','-loglevel','error','-y','-framerate','30',
               '-i',str(OUT/'transparent-frames'/'%06d.png'),'-c:v','prores_ks','-profile:v','4',
               '-pix_fmt','yuva444p10le','-alpha_bits','16','-vendor','apl0',str(mov)],check=True)
decoded=subprocess.run([ffmpeg,'-hide_banner','-loglevel','error','-i',str(mov),'-frames:v','1',
                        '-f','rawvideo','-pix_fmt','rgba','pipe:1'],capture_output=True,check=True).stdout
a=np.frombuffer(decoded,np.uint8).reshape(1080,1920,4)[:,:,3]
assert np.any(a==0) and np.any(a>0) and np.any((a>0)&(a<255))
checks['prores_alpha']={'decoded_frame_has_transparent_and_visible_pixels':True,
                        'decoded_alpha_min':int(a.min()),'decoded_alpha_max':int(a.max()),
                        'editor_import_compatibility':'not yet tested in the user video editor'}
for path in [OUT/'overlay-review.mp4',OUT/'enlarged-instructor.mp4',mov]:
    cap=cv2.VideoCapture(str(path))
    count=0
    while True:
        ok,frame=cap.read()
        if not ok:break
        count+=1
    fps=cap.get(cv2.CAP_PROP_FPS);cap.release()
    assert count==360 and abs(fps-30)<.001
    checks['videos'][path.name]={'decoded_frames':count,'fps':fps,'duration_s':count/fps,'bytes':path.stat().st_size}
source_cap=cv2.VideoCapture(meta['path']);source_count=0
while source_cap.read()[0]:source_count+=1
source_cap.release()
assert source_count==meta['reported_frames']
checks['full_source_decoded_frames']=source_count
preview=Image.open(OUT/'teaching-stills'/'clean-660.png').convert('RGBA')
backgrounds=[]
for color in [(255,255,255),(10,10,10)]:
    backgrounds.append(Image.alpha_composite(Image.new('RGBA',preview.size,(*color,255)),preview).convert('RGB'))
board=np.zeros((1080,1920,3),np.uint8)
for yy in range(0,1080,40):
    for xx in range(0,1920,40):board[yy:yy+40,xx:xx+40]=[155,155,155] if (xx//40+yy//40)%2 else [225,225,225]
backgrounds.append(Image.alpha_composite(Image.fromarray(board).convert('RGBA'),preview).convert('RGB'))
sheet=Image.new('RGB',(1920,1080))
for i,bg in enumerate(backgrounds):sheet.paste(bg.resize((640,360)),(i*640,360))
sheet.save(OUT/'alpha-background-check.jpg',quality=94)
checks['storage']={name:sum(p.stat().st_size for p in (ROOT/name).rglob('*') if p.is_file()) for name in ['work','outputs']}
checks['free_space_c_bytes']=shutil.disk_usage(ROOT).free
(OUT/'validation.json').write_text(json.dumps(checks,indent=2),encoding='utf-8')
packages={name:importlib.metadata.version(name) for name in ['rtmlib','onnxruntime-directml','opencv-python','numpy','scipy','pillow','imageio-ffmpeg']}
manifest={'source':meta,'pilot':json.loads((OUT/'extraction-stats.json').read_text()),
          'render':json.loads((OUT/'render-stats.json').read_text()),'models':json.loads((ROOT/'work'/'models'/'manifest.json').read_text()),
          'packages':packages,'validation':checks,'licenses':{'rtmlib':'Apache-2.0; bundled package LICENSE',
          'models':'Official OpenMMLab inference checkpoints; provenance and hashes recorded. See upstream model/dataset terms before distribution.',
          'PromptHMR':'Not installed or used; intended commercial use unresolved.'},
          'review':'Identity anchor frames visually reviewed; other assignments and joints remain estimates. No manual anatomy corrections.'}
(OUT/'manifest.json').write_text(json.dumps(manifest,indent=2),encoding='utf-8')
print(json.dumps(checks,indent=2),flush=True)

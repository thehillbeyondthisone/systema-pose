import json
import time
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw
from pose_runtime import ROOT, load_models

meta = json.loads((ROOT / 'work' / 'source-metadata.json').read_text())
cap = cv2.VideoCapture(meta['path'])
det, pose = load_models()
sheet = Image.new('RGB', (1280, 760), '#151b27')
draw = ImageDraw.Draw(sheet)
records = []
for i, sec in enumerate([18, 22, 26, 29]):
    cap.set(cv2.CAP_PROP_POS_FRAMES, sec * 30)
    ok, frame = cap.read()
    started = time.perf_counter()
    boxes = det(frame)
    k, s = pose(frame, bboxes=boxes) if len(boxes) else (np.empty((0,133,2)), np.empty((0,133)))
    elapsed = time.perf_counter() - started
    edges = [(5,6),(5,7),(7,9),(6,8),(8,10),(5,11),(6,12),(11,12),(11,13),(13,15),(12,14),(14,16)]
    for b, points, conf in zip(boxes,k,s):
        cv2.rectangle(frame, tuple(b[:2].astype(int)),tuple(b[2:].astype(int)),(0,255,255),2)
        for a,c in edges:
            if min(conf[a],conf[c]) > .35:
                cv2.line(frame,tuple(points[a].astype(int)),tuple(points[c].astype(int)),(0,230,80),5,cv2.LINE_AA)
    im = Image.fromarray(cv2.cvtColor(frame,cv2.COLOR_BGR2RGB)).resize((640,360))
    x,y=(i%2)*640,(i//2)*380
    sheet.paste(im,(x,y))
    draw.text((x+8,y+363),f'{sec}s: {len(boxes)} people; {elapsed:.3f}s inference',fill='white')
    records.append({'source_time_s':sec,'people':len(boxes),'seconds':elapsed,'shape':list(k.shape), 'boxes': boxes.tolist()})
    print(records[-1],flush=True)
sheet.save(ROOT/'outputs'/'benchmark-contact-sheet.jpg',quality=92)
(ROOT/'work'/'benchmark.json').write_text(json.dumps({'providers':pose.session.get_providers(),'frames':records},indent=2))
cap.release()

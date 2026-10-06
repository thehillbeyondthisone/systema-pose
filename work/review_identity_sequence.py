import json
import cv2
import numpy as np
from PIL import Image,ImageDraw
from pose_runtime import ROOT
from render_pilot import COLORS

out=ROOT/'outputs'/'pilot'
rows=[json.loads(x) for x in (out/'poses-tracked.jsonl').read_text().splitlines()]
meta=json.loads((ROOT/'work'/'source-metadata.json').read_text())
cap=cv2.VideoCapture(meta['path'])
for batch in range(3):
    sheet=Image.new('RGB',(1440,4*300),(15,20,29));draw=ImageDraw.Draw(sheet)
    for n in range(12):
        i=batch*120+n*10
        r=rows[i];cap.set(cv2.CAP_PROP_POS_FRAMES,r['source_frame_index']);ok,frame=cap.read()
        for p in r['people']:
            tid=p['track_id']
            if not tid:continue
            b=np.array(p['bbox_xyxy']).astype(int);color=COLORS[tid-1][::-1]
            cv2.rectangle(frame,tuple(b[:2]),tuple(b[2:]),color,5)
            cv2.putText(frame,f'T{tid}',tuple(b[:2]+[0,50]),cv2.FONT_HERSHEY_SIMPLEX,1.5,(0,0,0),8)
            cv2.putText(frame,f'T{tid}',tuple(b[:2]+[0,50]),cv2.FONT_HERSHEY_SIMPLEX,1.5,color,4)
        x,y=(n%3)*480,(n//3)*300
        sheet.paste(Image.fromarray(cv2.cvtColor(frame,cv2.COLOR_BGR2RGB)).resize((480,270)),(x,y))
        draw.text((x+8,y+279),f'Frame {r["source_frame_index"]} / {r["source_frame_index"]/30:.3f}s',fill='white')
    sheet.save(out/f'identity-review-{batch+1}.jpg',quality=94)
cap.release()

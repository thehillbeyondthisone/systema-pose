import json
import cv2
import numpy as np
from PIL import Image,ImageDraw
from render_pilot import feature
from pose_runtime import ROOT

out=ROOT/'outputs'/'pilot'
rows=[json.loads(line) for line in (out/'poses-raw.jsonl').read_text().splitlines()]
meta=json.loads((ROOT/'work'/'source-metadata.json').read_text())
cap=cv2.VideoCapture(meta['path'])
indices=[0,2,7,30,60,90,120,150,180,210,240,270,300,330,359]
sheet=Image.new('RGB',(1440,5*310),(15,20,29));draw=ImageDraw.Draw(sheet)
for n,i in enumerate(indices):
    row=rows[i];cap.set(cv2.CAP_PROP_POS_FRAMES,row['source_frame_index']);ok,frame=cap.read()
    print('FRAME',row['source_frame_index'],flush=True)
    for j,p in enumerate(row['people']):
        b=np.array(p['bbox_xyxy']).astype(int)
        feat=feature(frame,p)
        print(j,b.tolist(),np.round(feat,3).tolist(),flush=True)
        cv2.rectangle(frame,tuple(b[:2]),tuple(b[2:]),(0,255,255),4)
        cv2.putText(frame,str(j),tuple(b[:2]+[0,40]),cv2.FONT_HERSHEY_SIMPLEX,1.5,(0,0,0),6)
        cv2.putText(frame,str(j),tuple(b[:2]+[0,40]),cv2.FONT_HERSHEY_SIMPLEX,1.5,(0,255,255),3)
    x,y=(n%3)*480,(n//3)*310
    im=Image.fromarray(cv2.cvtColor(frame,cv2.COLOR_BGR2RGB)).resize((480,270))
    sheet.paste(im,(x,y));draw.text((x+8,y+279),f'Frame {row["source_frame_index"]} / {row["source_frame_index"]/30:.3f}s',fill='white')
sheet.save(out/'tracking-diagnostics.jpg',quality=94)
cap.release()

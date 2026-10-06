"""Style comparisons rendered from measured 2D joint estimates."""
import json
from pathlib import Path

import cv2
import numpy as np
from PIL import Image,ImageDraw,ImageFont
from pose_runtime import ROOT
from render_pilot import COLORS, EDGES

OUT=ROOT/'outputs'/'visual-options';OUT.mkdir(parents=True,exist_ok=True)
rows=[json.loads(line) for line in (ROOT/'outputs'/'pilot'/'poses-tracked.jsonl').read_text().splitlines()]
row=rows[240]
font=ImageFont.truetype('C:/Windows/Fonts/segoeui.ttf',22)
small=ImageFont.truetype('C:/Windows/Fonts/segoeui.ttf',16)
titlefont=ImageFont.truetype('C:/Windows/Fonts/segoeuib.ttf',32)
meta=json.loads((ROOT/'work'/'source-metadata.json').read_text())
cap=cv2.VideoCapture(meta['path']);cap.set(cv2.CAP_PROP_POS_FRAMES,780);ok,source=cap.read();cap.release()
source=Image.fromarray(cv2.cvtColor(source,cv2.COLOR_BGR2RGB))

def skeleton(people,style='color',opacity=255):
    image=Image.new('RGBA',(1920,1080),(0,0,0,0));d=ImageDraw.Draw(image)
    for p in people:
        if p['track_id']==0:continue
        if style in ['mono','focus','ghost','trail'] and p['track_id']!=1:continue
        color=COLORS[p['track_id']-1] if style!='mono' else (242,247,255)
        xy=np.array(p['keypoints_xy']);conf=p['confidence']
        for a,b in EDGES:
            if min(conf[a],conf[b])<.35:continue
            if any(xy[j,0]<0 or xy[j,0]>=1920 or xy[j,1]<0 or xy[j,1]>=1080 for j in (a,b)):continue
            c=color;alpha=opacity
            width=9
            if style=='focus' and (a,b) not in [(5,7),(7,9),(6,8),(8,10)]:c=(105,121,145);alpha=int(opacity*.38)
            if style=='mono':width=13
            endpoints=[tuple(xy[a]),tuple(xy[b])]
            d.line(endpoints,fill=(8,12,20,alpha),width=width+5)
            d.line(endpoints,fill=(*c,alpha),width=width)
        for j in range(23):
            if conf[j]<.35:continue
            x,y=xy[j]
            if not(0<=x<1920 and 0<=y<1080):continue
            d.ellipse((x-6,y-6,x+6,y+6),fill=(*color,opacity))
    return image

def on_dark(layer):return Image.alpha_composite(Image.new('RGBA',(1920,1080),(17,24,36,255)),layer).convert('RGB')
pair=[p for p in row['people'] if p['track_id'] in [1,2]]
tiles=[]
tiles.append(('1 · Overlay on source','Keep the filmed interaction visible.',Image.alpha_composite(source.convert('RGBA'),skeleton(row['people'])).convert('RGB')))
tiles.append(('2 · Clean participant colors','Separate people at a glance.',on_dark(skeleton(row['people']))))
tiles.append(('3 · Bold monochrome','Simple instructor-only graphic.',on_dark(skeleton(row['people'],'mono'))))
tiles.append(('4 · Highlight the arms','De-emphasize unrelated movement.',on_dark(skeleton(row['people'],'focus'))))
ghost=Image.new('RGBA',(1920,1080),(0,0,0,0))
for offset,alpha in [(-12,50),(-8,80),(-4,115),(0,255)]:ghost=Image.alpha_composite(ghost,skeleton(rows[240+offset]['people'],'ghost',alpha))
tiles.append(('5 · Ghosted sequence','Show the preceding 0.4 seconds.',on_dark(ghost)))
trails=skeleton(row['people'],'trail');td=ImageDraw.Draw(trails)
for joint,color in [(9,(74,212,255,230)),(10,(255,144,94,230)),(15,(151,238,145,230))]:
    points=[]
    for history in rows[216:241]:
        person=next((p for p in history['people'] if p['track_id']==1),None)
        if person and person['confidence'][joint]>=.55:points.append(tuple(person['keypoints_xy'][joint]))
        else:
            if len(points)>1:td.line(points,fill=color,width=5)
            points=[]
    if len(points)>1:td.line(points,fill=color,width=5)
tiles.append(('6 · Wrist / foot paths','Show recent motion, without force claims.',on_dark(trails)))
sheet=Image.new('RGB',(1800,1030),(11,17,27));d=ImageDraw.Draw(sheet)
d.text((28,20),'SYSTEMA / SIX 2D VISUAL OPTIONS',font=titlefont,fill='white')
d.text((28,65),'Same source frame: 26.000s / frame 780 · styling does not correct inaccurate or occluded joints',font=small,fill=(179,194,213))
for i,(title,description,im) in enumerate(tiles):
    x=20+(i%3)*595;y=110+(i//3)*445
    im.save(OUT/f'{i+1:02d}-{title.split("·")[1].strip().lower().replace(" / ","-").replace(" ","-")}.png')
    sheet.paste(im.resize((575,324)),(x,y))
    d.text((x+2,y+340),title,font=font,fill='white')
    d.text((x+2,y+375),description,font=small,fill=(174,191,213))
sheet.save(OUT/'style-comparison.jpg',quality=95)
print(OUT/'style-comparison.jpg')

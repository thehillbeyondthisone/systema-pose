"""Track native estimates and render straight-alpha media without smoothing."""
import json
import subprocess
import time
from collections import Counter
from pathlib import Path

import cv2
import imageio_ffmpeg
import numpy as np
from PIL import Image, ImageDraw
from scipy.optimize import linear_sum_assignment
from pose_runtime import ROOT

OUT = ROOT / 'outputs' / 'pilot'
COLORS = [(255,192,68),(74,212,255),(234,105,230),(124,234,145),(255,125,104),(187,160,255)]
EDGES = [(0,1),(0,2),(1,3),(2,4),(5,6),(5,7),(7,9),(6,8),(8,10),(5,11),(6,12),(11,12),
         (11,13),(13,15),(12,14),(14,16),(15,17),(17,18),(15,19),(16,20),(20,21),(16,22)]
NAMES = ['nose','left_eye','right_eye','left_ear','right_ear','left_shoulder','right_shoulder',
         'left_elbow','right_elbow','left_wrist','right_wrist','left_hip','right_hip','left_knee',
         'right_knee','left_ankle','right_ankle','left_big_toe','left_small_toe','left_heel',
         'right_big_toe','right_small_toe','right_heel'] + [f'face_{i}' for i in range(68)] + [f'left_hand_{i}' for i in range(21)] + [f'right_hand_{i}' for i in range(21)]

def feature(frame, p):
    pts = np.asarray(p['keypoints_xy'])
    lab = cv2.cvtColor(frame,cv2.COLOR_BGR2LAB)
    features = []
    for ids in ([5,6,12,11],[11,12,14,13]):
        mask = np.zeros(frame.shape[:2],dtype=np.uint8)
        polygon = cv2.convexHull(np.int32(pts[ids]))
        cv2.fillConvexPoly(mask,polygon,255)
        pixels = lab[mask != 0]
        if len(pixels) < 16:
            pixels = lab.reshape(-1,3)[:16]
        features.extend(np.median(pixels,axis=0).tolist())
    return np.array(features,dtype=np.float32)/255

def iou(a,b):
    lo,hi=np.maximum(a[:2],b[:2]),np.minimum(a[2:],b[2:])
    area=np.prod(np.maximum(0,hi-lo))
    return area/max(1,np.prod(a[2:]-a[:2])+np.prod(b[2:]-b[:2])-area)

def track(rows, meta):
    cap = cv2.VideoCapture(meta['path'])
    cap.set(cv2.CAP_PROP_POS_FRAMES,rows[0]['source_frame_index'])
    # Source-frame/detection assignments inspected against the footage.
    # Clothing: 1 black/beige instructor; 2 grey/black; 3 blue/beige; 4 white/camo.
    anchors={540:{0:3,1:2,2:1},570:{0:3,1:1,2:4,3:2},600:{0:4,1:3,2:1,3:2},
             630:{0:3,1:4,2:2,3:1},660:{0:2,1:3,2:4,3:1},690:{0:3,1:2,2:4,3:1},
             720:{0:2,1:4,2:1,3:3},750:{0:1,1:2,3:4},780:{0:3,1:1,2:2},
             810:{0:3,1:1,2:4},840:{0:3,1:1,2:2,3:4},870:{0:3,2:2,3:4},899:{0:4,1:3}}
    templates={tid:[] for tid in range(1,5)}
    for source_index,mapping in anchors.items():
        cap.set(cv2.CAP_PROP_POS_FRAMES,source_index);ok,frame=cap.read()
        row=rows[source_index-rows[0]['source_frame_index']]
        for j,tid in mapping.items():templates[tid].append(feature(frame,row['people'][j]))
    cap.set(cv2.CAP_PROP_POS_FRAMES,rows[0]['source_frame_index'])
    tracks,events={},[]
    (OUT/'identity-anchors.json').write_text(json.dumps({'assignments':anchors,
        'method':'Visual source-frame inspection; detection indexes refer to poses-raw.jsonl.',
        'participants':{'1':'instructor, black shirt / beige trousers','2':'grey shirt / black trousers',
                        '3':'blue shirt / beige trousers','4':'white shirt / camouflage trousers'},
        'joint_corrections':'none'},indent=2),encoding='utf-8')
    for row in rows:
        ok,frame=cap.read()
        if not ok: raise RuntimeError('Tracking decode failed')
        index=row['pilot_frame_index']
        people=row['people']
        feats=[feature(frame,p) for p in people]
        candidates=list(range(1,5))
        cost=np.full((len(candidates),len(people)),100.0)
        for i,tid in enumerate(candidates):
            t=tracks.get(tid)
            for j,p in enumerate(people):
                box=np.array(p['bbox_xyxy'])
                if box[3]-box[1]<200 or box[2]-box[0]<75:continue
                prev=t['bbox'] if t else box
                size=max(200,box[3]-box[1],prev[3]-prev[1])
                distance=np.linalg.norm((box[:2]+box[2:])/2-(prev[:2]+prev[2:])/2)/size
                appearance=min(np.linalg.norm(feats[j]-ref) for ref in templates[tid])
                cost[i,j]=.45*distance+.2*(1-iou(box,prev))+2.5*appearance
        manual=anchors.get(row['source_frame_index'])
        if manual is not None:
            for j in range(len(people)):
                cost[:,j]=100
                if j in manual:cost[manual[j]-1,j]=0
        assigned={}
        if cost.size:
            ii,jj=linear_sum_assignment(cost)
            for i,j in zip(ii,jj):
                if cost[i,j] > .9: continue
                tid=candidates[i]
                alternatives=np.delete(cost[:,j],i)
                margin=float(np.min(alternatives)-cost[i,j]) if alternatives.size else 1
                gap=index-tracks[tid]['last'] if tid in tracks else 0
                flags=[]
                if margin < .12: flags.append('ambiguous_assignment')
                if gap > 6: flags.append('reidentification_after_gap')
                if manual is not None:flags=['manual_identity_anchor']
                assigned[int(j)]=(tid,flags,float(cost[i,j]),margin)
        for j,p in enumerate(people):
            if j not in assigned:
                p['track_id']=0
                p['track_status']=['unassigned_detection_excluded_from_render']
                events.append({'pilot_frame_index':index,'detection_index':j,'event':'unassigned_detection'})
                continue
            tid,flags,match_cost,margin=assigned[j]
            p['track_id']=tid
            p['track_status']=flags or ['matched']
            p['assignment_cost']=match_cost
            p['assignment_margin']=margin
            if flags and flags != ['new_track']:
                events.append({'pilot_frame_index':index,'track_id':tid,'event':','.join(flags)})
            prior=tracks.get(tid)
            feat=feats[j] if prior is None else .98*prior['feature']+.02*feats[j]
            tracks[tid]={'bbox':np.array(p['bbox_xyxy']),'feature':feat,'last':index}
        if index % 60 == 0:print(f'Tracked {index+1}/{len(rows)}; four persistent participant IDs',flush=True)
    cap.release()
    (OUT/'tracking-events.json').write_text(json.dumps(events,indent=2),encoding='utf-8')
    with (OUT/'poses-tracked.jsonl').open('w',encoding='utf-8') as f:
        for row in rows:f.write(json.dumps(row,separators=(',',':'))+'\n')
    return events

def layer(people, size=(1920,1080), transform=None, thickness=7):
    width,height=size
    canvas=Image.new('RGBA',size,(0,0,0,0))
    for p in people:
        if p['track_id']==0:continue
        pts=np.array(p['keypoints_xy'],dtype=float)
        conf=np.array(p['confidence'])
        if transform:
            scale,ox,oy=transform
            pts=pts*scale+[ox,oy]
        color=COLORS[(p['track_id']-1)%len(COLORS)]
        outline=np.zeros((height,width),np.uint8)
        bones=np.zeros_like(outline)
        def inside(j): return 0 <= pts[j,0] < width and 0 <= pts[j,1] < height
        for a,b in EDGES:
            c=min(conf[a],conf[b])
            if c < .35 or not inside(a) or not inside(b):continue
            alpha=255 if c >= .55 else 125
            aa,bb=tuple(pts[a].astype(int)),tuple(pts[b].astype(int))
            cv2.line(outline,aa,bb,alpha,thickness+5,cv2.LINE_AA)
            cv2.line(bones,aa,bb,alpha,thickness,cv2.LINE_AA)
        for j in range(23):
            if conf[j] < .35 or not inside(j):continue
            c=tuple(pts[j].astype(int))
            alpha=255 if conf[j] >= .55 else 125
            cv2.circle(outline,c,thickness,alpha,-1,cv2.LINE_AA)
            cv2.circle(bones,c,max(3,thickness-3),alpha,-1,cv2.LINE_AA)
        a=Image.new('RGBA',size,(12,15,20,0));a.putalpha(Image.fromarray(outline))
        b=Image.new('RGBA',size,(*color,0));b.putalpha(Image.fromarray(bones))
        canvas=Image.alpha_composite(canvas,a)
        canvas=Image.alpha_composite(canvas,b)
    return canvas

def encoder(path,width,height):
    return subprocess.Popen([imageio_ffmpeg.get_ffmpeg_exe(),'-hide_banner','-loglevel','error','-y',
          '-f','rawvideo','-pix_fmt','rgb24','-s',f'{width}x{height}','-r','30','-i','pipe:0',
          '-an','-c:v','libx264','-preset','fast','-crf','18','-pix_fmt','yuv420p','-movflags','+faststart',str(path)],stdin=subprocess.PIPE)

def render(rows,meta):
    (OUT/'transparent-frames').mkdir(exist_ok=True)
    (OUT/'illustration-frames').mkdir(exist_ok=True)
    (OUT/'teaching-stills').mkdir(exist_ok=True)
    cap=cv2.VideoCapture(meta['path']);cap.set(cv2.CAP_PROP_POS_FRAMES,rows[0]['source_frame_index'])
    video=encoder(ROOT/'work'/'pilot-review-silent.mp4',1920,1080)
    illustration=encoder(OUT/'enlarged-instructor.mp4',1080,1440)
    sampled=[]
    target_stills={0,60,120,180,240,300,359}
    for row in rows:
        i=row['pilot_frame_index'];ok,frame=cap.read()
        if not ok: raise RuntimeError('Render decode failed')
        overlay=layer(row['people'])
        overlay.save(OUT/'transparent-frames'/f'{i:06d}.png',compress_level=3)
        source=Image.fromarray(cv2.cvtColor(frame,cv2.COLOR_BGR2RGB)).convert('RGBA')
        review=Image.alpha_composite(source,overlay).convert('RGB')
        draw=ImageDraw.Draw(review)
        draw.rectangle((18,18,720,96),fill=(12,17,26))
        draw.text((30,28),f'SYSTEMA / 2D PILOT  |  source {row["source_frame_index"]/30:.3f}s  |  frame {row["source_frame_index"]}',fill='white')
        draw.text((30,50),'Faded joints: lower confidence. Occluded limbs may be missing or incorrect.',fill=(200,205,215))
        for k,tid in enumerate(sorted({p['track_id'] for p in row['people'] if p['track_id']})):
            x=30+k*95;draw.ellipse((x,74,x+12,86),fill=COLORS[(tid-1)%len(COLORS)])
            draw.text((x+18,74),f'T{tid}',fill='white')
        video.stdin.write(np.asarray(review).tobytes())
        focus=[p for p in row['people'] if p['track_id']==1]
        if focus:
            b=np.array(focus[0]['bbox_xyxy']);scale=min(900/max(1,b[2]-b[0]),1200/max(1,b[3]-b[1]))
            ox=540-scale*(b[0]+b[2])/2;oy=720-scale*(b[1]+b[3])/2
            enlarged=layer(focus,(1080,1440),(scale,ox,oy),thickness=11)
        else:enlarged=Image.new('RGBA',(1080,1440),(0,0,0,0))
        enlarged.save(OUT/'illustration-frames'/f'{i:06d}.png',compress_level=3)
        dark=Image.new('RGBA',(1080,1440),(17,23,34,255))
        enlarged_review=Image.alpha_composite(dark,enlarged).convert('RGB')
        ed=ImageDraw.Draw(enlarged_review);ed.text((32,30),f'INSTRUCTOR / T1  |  {row["source_frame_index"]/30:.3f}s',fill='white')
        if not focus:ed.text((32,60),'Track temporarily unavailable; no invented pose.',fill='white')
        illustration.stdin.write(np.asarray(enlarged_review).tobytes())
        if i in target_stills:
            review.save(OUT/'teaching-stills'/f'overlay-{row["source_frame_index"]}.jpg',quality=93)
            overlay.save(OUT/'teaching-stills'/f'clean-{row["source_frame_index"]}.png')
            sampled.append((row['source_frame_index'],review.resize((640,360))))
        if i%60==0:print(f'Rendered {i+1}/{len(rows)} frames',flush=True)
    for proc in (video,illustration):
        proc.stdin.close()
        if proc.wait()!=0:raise RuntimeError('Video encoding failed')
    cap.release()
    sheet=Image.new('RGB',(1280,4*390),(17,23,34));d=ImageDraw.Draw(sheet)
    for i,(frame,im) in enumerate(sampled):
        x,y=(i%2)*640,(i//2)*390;sheet.paste(im,(x,y));d.text((x+10,y+368),f'Source frame {frame} / {frame/30:.3f}s',fill='white')
    sheet.save(OUT/'review-contact-sheet.jpg',quality=94)
    ffmpeg=imageio_ffmpeg.get_ffmpeg_exe()
    subprocess.run([ffmpeg,'-hide_banner','-loglevel','error','-y','-i',str(ROOT/'work'/'pilot-review-silent.mp4'),
                    '-ss','18','-t','12','-i',meta['path'],'-map','0:v:0','-map','1:a:0?',
                    '-c:v','copy','-c:a','aac','-b:a','192k','-shortest','-movflags','+faststart',str(OUT/'overlay-review.mp4')],check=True)

if __name__=='__main__':
    started=time.perf_counter()
    rows=[json.loads(line) for line in (OUT/'poses-raw.jsonl').read_text().splitlines()]
    meta=json.loads((ROOT/'work'/'source-metadata.json').read_text())
    events=track(rows,meta)
    render(rows,meta)
    stats={'render_wall_seconds':time.perf_counter()-started,'track_count':max(p['track_id'] for r in rows for p in r['people']),
           'people_per_frame':dict(Counter(len(r['people']) for r in rows)), 'tracking_review_events':len(events),
           'native_joint_names':NAMES,'colors_rgb':COLORS,'edges':EDGES,
           'illustration_transform':'Track 1 bbox fitted per frame; source-relative placement not retained in solo illustration.',
           'render_threshold':.35,'full_opacity_threshold':.55,'alpha':'straight/unassociated',
           'review_status':'Awaiting detailed visual review; automatically tracked estimates, no manual corrections yet.'}
    (OUT/'render-stats.json').write_text(json.dumps(stats,indent=2),encoding='utf-8')
    print(json.dumps({k:v for k,v in stats.items() if k not in ['native_joint_names','edges','colors_rgb']},indent=2))

import json
import time
from pathlib import Path

import cv2
import numpy as np
from pose_runtime import ROOT, load_models

START, END = 540, 900
OUT = ROOT / 'outputs' / 'pilot'
OUT.mkdir(parents=True, exist_ok=True)
meta = json.loads((ROOT / 'work' / 'source-metadata.json').read_text())
det, pose = load_models()
cap = cv2.VideoCapture(meta['path'])
cap.set(cv2.CAP_PROP_POS_FRAMES, START)
started = time.perf_counter()
times = []
with (OUT / 'poses-raw.jsonl').open('w', encoding='utf-8') as f:
    for idx in range(START, END):
        ok, frame = cap.read()
        if not ok:
            raise RuntimeError(f'Decoding stopped at source frame {idx}')
        tick = time.perf_counter()
        boxes = det(frame)
        people = []
        for i, box in enumerate(boxes):
            crop, center, scale = pose.preprocess(frame, box)
            k, conf = pose.postprocess(pose.inference(crop), center, scale)
            points, scores = k[0], conf[0]
            people.append({'detection_index': i, 'bbox_xyxy': box.tolist(),
                           'keypoints_xy': points.tolist(), 'confidence': scores.tolist(),
                           'joint_status': ['low_confidence' if s < .35 else 'estimated_visibility_unknown' for s in scores],
                           'pose_transform': {'crop_center_xy': center.tolist(), 'crop_scale_wh': scale.tolist(),
                                              'input_wh': [288,384], 'simcc_split_ratio': 2.0}})
        times.append(time.perf_counter() - tick)
        row = {'source_frame_index':idx,'pilot_frame_index':idx-START,
               'source_timestamp_s': cap.get(cv2.CAP_PROP_POS_MSEC)/1000,
               'nominal_source_timestamp_s':idx/30, 'width':1920,'height':1080,'people':people}
        f.write(json.dumps(row,separators=(',',':'))+'\n')
        if (idx-START)%30 == 0:
            print(f'Extracted {idx-START+1}/360 frames; {len(people)} people; {times[-1]:.3f}s/frame',flush=True)
cap.release()
stats = {'frames':END-START,'source_start_frame':START,'source_end_frame_exclusive':END,
         'start_time_s':START/30,'end_time_s_exclusive':END/30,
         'inference_wall_seconds':time.perf_counter()-started,
         'median_inference_seconds_per_frame':float(np.median(times)),
         'providers':pose.session.get_providers(), 'detector_score_threshold':.35,
         'detector_transform':{'input_wh':[640,640],'scale':1/3,'padding_location':'right/bottom','padding_rgb':[114,114,114]},
         'smoothing':'none','interpolation':'none','native_layout':'COCO-WholeBody 133'}
(OUT/'extraction-stats.json').write_text(json.dumps(stats,indent=2),encoding='utf-8')
print(json.dumps(stats,indent=2),flush=True)

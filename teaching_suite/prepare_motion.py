"""Prepare browser media and extract 2D poses only within instructor passages."""
import argparse
import json
import math
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'work' / 'runtime'))
sys.path.insert(0, str(ROOT / 'work'))
from onboarding import save


def prepare(original, dest):
    import cv2
    import imageio_ffmpeg
    source = cv2.VideoCapture(str(original))
    if not source.isOpened():
        raise ValueError('Video could not decode.')
    duration = source.get(cv2.CAP_PROP_FRAME_COUNT) / max(1, source.get(cv2.CAP_PROP_FPS))
    source.release()
    if not math.isfinite(duration) or duration <= 0 or duration > 7200:
        raise ValueError('Video must be between one frame and two hours.')
    subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(), '-nostdin', '-y', '-i', str(original),
                    '-map', '0:v:0', '-map', '0:a:0?', '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2,fps=30',
                    '-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-pix_fmt', 'yuv420p',
                    '-c:a', 'aac', '-movflags', '+faststart', str(dest / 'source.mp4')], check=True,
                   stdout=subprocess.DEVNULL, stderr=sys.stderr)
    source = cv2.VideoCapture(str(dest / 'source.mp4'))
    meta = {'width': int(source.get(cv2.CAP_PROP_FRAME_WIDTH)), 'height': int(source.get(cv2.CAP_PROP_FRAME_HEIGHT)),
            'fps': 30, 'duration': source.get(cv2.CAP_PROP_FRAME_COUNT) / 30}
    source.release()
    save(dest / 'video.json', meta)


def generate(dest):
    import cv2
    import numpy as np
    from pose_runtime import load_models
    lesson = json.loads((dest / 'lesson.json').read_text(encoding='utf-8'))
    lesson.update(status='processing', message='Loading skeleton models.', progress=0)
    save(dest / 'lesson.json', lesson)
    detector, pose = load_models()
    cap = cv2.VideoCapture(str(dest / 'source.mp4'))
    frames, next_id, completed = [], 1, 0
    total = sum(math.ceil(s['end'] * 30) - math.ceil(s['start'] * 30) for s in lesson['segments'])
    participant_ids = set()
    for segment in lesson['segments']:
        start, end = math.ceil(segment['start'] * 30), math.ceil(segment['end'] * 30)
        cap.set(cv2.CAP_PROP_POS_FRAMES, start)
        tracks = {}
        for index in range(start, end):
            ok, image = cap.read()
            if not ok:
                raise RuntimeError('Video decoding stopped during a selected passage.')
            boxes = detector(image)
            people, used = [], set()
            # Conservative spatial association; identities are estimates awaiting instructor review.
            for box in boxes:
                center = (np.asarray(box[:2]) + np.asarray(box[2:])) / 2
                height = max(1, box[3] - box[1])
                candidates = [(np.linalg.norm(center - t['center']) / max(height, t['height']), tid)
                              for tid, t in tracks.items() if tid not in used and index - t['frame'] <= 15]
                distance, tid = min(candidates, default=(float('inf'), 0))
                matched = distance < .4
                if not matched:
                    tid = next_id
                    next_id += 1
                used.add(tid)
                participant_ids.add(tid)
                tracks[tid] = {'center': center, 'height': height, 'frame': index}
                crop, crop_center, scale = pose.preprocess(image, box)
                xy, confidence = pose.postprocess(pose.inference(crop), crop_center, scale)
                people.append({'id': tid, 'xy': xy[0][:23].tolist(), 'confidence': confidence[0][:23].tolist(),
                               'bbox': box.tolist(), 'status': ['automatic_identity_unreviewed', 'matched' if matched else 'new_track']})
            frames.append({'frame': index, 'people': people})
            completed += 1
            if completed == 1 or completed % 15 == 0 or completed == total:
                lesson.update(progress=round(completed / total * 100), message=f'Generating skeletons: {completed} of {total} selected frames.')
                save(dest / 'lesson.json', lesson)
                print(lesson['message'], flush=True)
    cap.release()
    save(dest / 'motion.json', {'fps': 30, 'sourceStart': 0, 'sourceEnd': lesson['sourceEnd'],
                              'width': lesson['width'], 'height': lesson['height'], 'frames': frames,
                              'segments': lesson['segments'], 'coordinateSpace': 'image-2d', 'reviewed': False})
    palette = ['#ffc044', '#4ad4ff', '#ea69e6', '#7cea91', '#ff7d68', '#bba0ff']
    lesson.update(status='ready', progress=100, message='Skeletons ready. Review the estimates against the footage before teaching.',
                  people=[{'id': tid, 'name': f'Person {tid}', 'color': palette[(tid - 1) % len(palette)]} for tid in sorted(participant_ids)])
    save(dest / 'lesson.json', lesson)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--prepare', nargs=2, metavar=('VIDEO', 'DEST'))
    parser.add_argument('--generate', type=Path)
    args = parser.parse_args()
    if args.prepare:
        prepare(Path(args.prepare[0]), Path(args.prepare[1]))
    elif args.generate:
        generate(args.generate)

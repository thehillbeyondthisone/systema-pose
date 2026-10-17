"""WSL worker for one dashboard passage. Runs the real, installed PromptHMR pipeline."""
import argparse
import json
import os
from pathlib import Path
import signal
import sys


def bind_tracks(pipeline, motion):
    """Keep reviewed source IDs, including entrants after frame zero; infer fresh depth/camera."""
    import numpy as np
    from types import MethodType
    from pipeline.utils import interpolate_bboxes
    from pipeline.detector import segment

    def detect(instance):
        height, width = instance.images[0].shape[:2]
        if len(instance.images) != len(motion['frames']):
            raise ValueError('Decoded video and reviewed 2D frame counts differ.')
        tracks = {}
        for person in motion['people']:
            indices, boxes = [], []
            for row in motion['frames']:
                matches = [p for p in row['people'] if p['id'] == person['id']]
                if len(matches) > 1:raise ValueError('Duplicate participant in source tracking.')
                if not matches:continue
                box = np.asarray(matches[0]['bbox'][:4], dtype=np.float32)
                box *= np.array([width / motion['width'], height / motion['height']] * 2)
                box[[0, 2]] = np.clip(box[[0, 2]], 0, width - 1)
                box[[1, 3]] = np.clip(box[[1, 3]], 0, height - 1)
                if box[2] > box[0] and box[3] > box[1]:
                    indices.append(row['frame']);boxes.append(box)
            if len(indices) < 2:
                raise ValueError(f"Person {person['id']} needs at least two valid tracked frames. Review the 2D tracking.")
            boxes, indices = interpolate_bboxes(np.asarray(boxes), np.asarray(indices))
            tracks[person['id']] = {'track_id': person['id'], 'bbox_format': 'x1y1x2y2',
                                   'frames': indices, 'bboxes': boxes,
                                   'masks': np.broadcast_to(np.zeros((1, 1, 1), dtype=np.bool_), (len(indices), height, width))}
        # Real foreground segmentation masks keep moving bodies out of camera SLAM.
        # Per-track masks are unused because mask prompts are disabled for reviewed boxes.
        original_loader = segment.DataLoader
        def bounded_loader(*args, **kwargs):
            kwargs.update(batch_size=2, num_workers=0)
            return original_loader(*args, **kwargs)
        segment.DataLoader = bounded_loader
        try:instance.results['masks'] = segment.segment_subjects(instance.images)
        finally:segment.DataLoader = original_loader
        instance.results['people'] = tracks
        instance.results['has_tracks'] = True
        print('Source IDs retained; fresh foreground masks and camera reconstruction.', flush=True)
    pipeline.run_detect_track = MethodType(detect, pipeline)
    pipeline.cfg.tracker = 'dashboard_2d'


def annotate(scene, motion):
    from annotate_3d_quality import annotate_tracking_quality
    # Adapter preserves existing quality semantics without modifying measured XYZ.
    rows = [{'people': [{'track_id': p['id'], 'bbox_xyxy': p['bbox'][:4]} for p in row['people']]}
            for row in motion['frames']]
    return annotate_tracking_quality(scene, rows)


def install_progress(pipeline, output):
    def update(label):
        temp = output / 'progress.tmp'
        temp.write_text(json.dumps({'message': label}), encoding='utf-8')
        temp.replace(output / 'progress.json')
        print(label, flush=True)

    phases = {'load_frames': 'Loading passage frames', 'run_detect_track': 'Preparing participants and foreground masks',
              'camera_motion_estimation': 'Reconstructing camera motion', 'estimate_2d_keypoints': 'Estimating body keypoints',
              'hps_estimation': 'Loading 3D body models', 'world_hps_estimation': 'Placing participants in a shared 3D scene',
              'post_optimization': 'Refining motion and floor placement'}
    for name, label in phases.items():
        original = getattr(pipeline, name)
        def tracked(*args, _original=original, _label=label, _name=name, **kwargs):
            update(_label)
            if _name == 'hps_estimation':
                # Fresh camera estimation can leave cyclic SLAM/model objects.
                # Release unreachable GPU buffers before the larger body models load.
                import gc
                import torch
                gc.collect();torch.cuda.empty_cache()
                print(f'GPU allocated before body inference: {torch.cuda.memory_allocated()/2**30:.2f} GiB', flush=True)
            return _original(*args, **kwargs)
        setattr(pipeline, name, tracked)

    from pipeline import phmr_vid
    original_loader = phmr_vid.DataLoader
    class ProgressLoader:
        def __init__(self, loader):self.loader = loader
        def __len__(self):return len(self.loader)
        def __iter__(self):
            completed = 0
            for batch in self.loader:
                yield batch
                completed += len(batch)
                update(f'Reconstructing body frames: {completed} of {len(self.loader.dataset)}')
            update('Refining participant motion over time')
    phmr_vid.DataLoader = lambda *args, **kwargs: ProgressLoader(original_loader(*args, **kwargs))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--repo', type=Path, required=True)
    parser.add_argument('--static-camera', action='store_true')
    parser.add_argument('--cancel', action='store_true')
    parser.add_argument('--force', action='store_true')
    parser.add_argument('--pause-file', type=Path)
    args = parser.parse_args()
    output = args.output.resolve()
    if args.cancel:
        record = json.loads((output / 'process.json').read_text())
        pid = record['pid']
        command = Path(f'/proc/{pid}/cmdline').read_bytes()
        if b'dashboard_3d_worker.py' not in command or str(output).encode() not in command or os.getpgid(pid) != pid:
            raise ValueError('Reconstruction process no longer matches this run.')
        os.killpg(pid, signal.SIGKILL if args.force else signal.SIGTERM)
        return
    if args.pause_file and (not args.pause_file.exists() or json.loads(args.pause_file.read_text()).get('gpuPaused', True)):
        raise SystemExit('GPU use is paused in the dashboard.')
    if os.getsid(0) != os.getpid():os.setsid()
    import fcntl
    lock = open('/tmp/systema-dashboard-3d.lock', 'w')
    try:fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:raise SystemExit('Another dashboard reconstruction is still using the GPU. Wait and retry.')
    (output / 'process.json').write_text(json.dumps({'pid': os.getpid()}))
    import run_3d_pilot
    argv = ['run_3d_pilot.py', '--repo', str(args.repo), '--output', str(output),
            '--input', 'source.mp4', '--reference-motion', str(output / 'motion.json'), '--image-batch-size', '1']
    if args.static_camera:argv.append('--static-camera')
    sys.argv = argv
    run_3d_pilot.main()


if __name__ == '__main__':main()

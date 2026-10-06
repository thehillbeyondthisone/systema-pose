"""Enable late-entry initialization and bidirectional propagation in the WSL source copy."""
from pathlib import Path
import hashlib
import json

ROOT = Path(__file__).resolve().parent.parent
path = Path('/opt/systema3d/PromptHMR/pipeline/tools.py')
original = path.read_text()
before = hashlib.sha256(original.encode()).hexdigest()
edits = [
    ('    start_frame = -1\n    for i in range(len(images)):',
     "    start_frame = -1\n    seed_frame = int(os.environ.get('SYSTEMA_SEED_FRAME', '0'))\n    if not 0 <= seed_frame < len(images):\n        raise ValueError('Invalid tracking initialization frame.')\n    for i in range(seed_frame, len(images)):"),
    ('        for t, out_obj_ids, out_mask_logits in predictor.propagate_in_video(state):',
     "        from itertools import chain\n        passes = [predictor.propagate_in_video(state, start_frame_idx=start_frame)]\n        if start_frame > 0:\n            passes.append(predictor.propagate_in_video(state, start_frame_idx=start_frame, reverse=True))\n        seen_frames = set()\n        for t, out_obj_ids, out_mask_logits in chain(*passes):\n            if t in seen_frames:\n                continue\n            seen_frames.add(t)"),
    ("        for k in track_results.keys():\n            track_results[k]['frames'] = np.array(track_results[k]['frames'])",
     "        for k in track_results.keys():\n            order = np.argsort(track_results[k]['frames'])\n            for field in ['frames', 'bboxes', 'masks']:\n                track_results[k][field] = np.asarray(track_results[k][field])[order]\n            track_results[k]['frames'] = np.array(track_results[k]['frames'])"),
]
modified = original
for old, new in edits:
    if modified.count(old) != 1:
        raise SystemExit('Unexpected source; inspect before applying tracking patch.')
    modified = modified.replace(old, new, 1)
compile(modified, str(path), 'exec')
path.write_text(modified)
report = {'file': str(path), 'beforeSha256': before,
          'afterSha256': hashlib.sha256(modified.encode()).hexdigest(),
          'changes': ['initialize at a frame where late entrants are visible',
                      'propagate forwards and backwards without duplicate frames',
                      'sort each track into original chronological frame order'],
          'seedFrame': 30, 'sourceTime': 19, 'originalFrame': 570}
(ROOT / 'outputs/3d-pilot/tracking-patch.json').write_text(json.dumps(report, indent=2))
print(json.dumps(report, indent=2))

"""Validate a real exported scene and plot reprojections against source frames."""
import json
from pathlib import Path
import cv2
import numpy as np
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

ROOT = Path(__file__).resolve().parent.parent
OUTPUT = ROOT / 'outputs/3d-pilot'
scene = json.loads((OUTPUT / 'scene.json').read_text(encoding='utf-8'))
manifest = json.loads((OUTPUT / 'manifest.json').read_text(encoding='utf-8'))
assert scene['sourceSha256'] == manifest['sha256']
assert scene['coordinateSpace'] == 'world-3d' and len(scene['frames']) == 360
assert scene['fps'] == 30 and scene['sourceStart'] == 18 and scene['sourceEnd'] == 30
ids = [person['id'] for person in scene['people']]
assert len(ids) == len(set(ids)) == manifest['reconstruction']['expectedParticipants'] == 4
assert {str(p['id']): str(p['reference2dId']) for p in scene['people']} == {str(i): str(i) for i in range(1, 5)}
tracks = {person_id: [] for person_id in ids}
for index, frame in enumerate(scene['frames']):
    assert frame['frame'] == index
    assert abs(frame['sourceTime'] - (18 + index / 30)) < 1e-8
    assert len({person['id'] for person in frame['people']}) == len(frame['people'])
    for person in frame['people']:
        xyz = np.asarray(person['xyz'])
        assert person['id'] in tracks and xyz.shape == (22, 3) and np.isfinite(xyz).all()
        tracks[person['id']].append((index, xyz))
stats = {}
for person_id, samples in tracks.items():
    indices = np.array([sample[0] for sample in samples])
    joints = np.stack([sample[1] for sample in samples])
    consecutive = np.diff(indices) == 1
    jumps = np.linalg.norm(np.diff(joints[:, 0], axis=0), axis=1)[consecutive]
    bones = np.stack([np.linalg.norm(joints[:, a] - joints[:, b], axis=1) for a, b in scene['edges']], axis=1)
    stats[str(person_id)] = {
        'framesPresent': len(samples), 'firstFrame': int(indices[0]), 'lastFrame': int(indices[-1]),
        'maxConsecutivePelvisStepModelMeters': float(jumps.max()) if len(jumps) else None,
        'lowestFootJointYModelMeters': float(joints[:, [7, 8, 10, 11], 1].min()),
        'boneLengthRangeModelMeters': [float(bones.min()), float(bones.max())],
        'identityReviewed': False,
    }
video = cv2.VideoCapture(str(OUTPUT / manifest['input']))
assert round(video.get(cv2.CAP_PROP_FRAME_COUNT)) == 360
palette = ['#ffc45f', '#7bc7ed', '#bda4ee', '#94d8b8', '#f29d91', '#dfc688']
colors = {person['id']: person.get('color', palette[index % len(palette)]) for index, person in enumerate(scene['people'])}
camera = scene['camera']
focal = float(np.asarray(camera['img_focal']).squeeze())
principal = np.asarray(camera['img_center']).reshape(2)
projections = []
for index in [0, 30, 75, 135, 180, 225, 270, 300, 359]:
    video.set(cv2.CAP_PROP_POS_FRAMES, index)
    success, bgr = video.read()
    assert success
    height, width = bgr.shape[:2]
    Rcw = np.asarray(camera['Rcw'][index])
    Tcw = np.asarray(camera['Tcw'][index])
    scale = np.array([width / (principal[0] * 2), height / (principal[1] * 2)])
    fig, axes = plt.subplots(1, 2, figsize=(16, 5), constrained_layout=True)
    axes[0].imshow(cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB))
    axes[1].imshow(cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB))
    for person in scene['frames'][index]['people']:
        points = np.asarray(person['xyz']) @ Rcw.T + Tcw
        assert np.all(points[:, 2] > 0), 'Reconstructed anatomy projects behind the source camera.'
        xy = (points[:, :2] / points[:, 2:3] * focal + principal) * scale
        for a, b in scene['edges']:
            axes[1].plot(xy[[a, b], 0], xy[[a, b], 1], color=colors[person['id']], linewidth=2)
        axes[1].text(*xy[0], f"Track {person['id']}", color=colors[person['id']],
                     fontsize=10, bbox={'facecolor': '#142234', 'alpha': .8, 'pad': 2})
    for axis in axes:
        axis.set_xlim(0, width)
        axis.set_ylim(height, 0)
        axis.axis('off')
    axes[0].set_title(f'Source footage · {18 + index / 30:.3f}s')
    axes[1].set_title('Reconstructed 3D joints projected through the estimated camera')
    destination = OUTPUT / f'reprojection-{index:03d}.jpg'
    fig.savefig(destination, dpi=120)
    plt.close(fig)
    projections.append(destination.name)
video.release()
report = {
    'schemaTimingHashAndFiniteJoints': 'passed', 'participants': stats,
    'reprojectionImages': projections, 'scaleVerified': False,
    'contactReviewed': False, 'identityReviewed': False,
    'note': 'Numeric checks do not establish identity, depth accuracy or contact; inspect source and orbit views.',
}
(OUTPUT / 'scene-validation.json').write_text(json.dumps(report, indent=2))
print(json.dumps(report, indent=2))

"""Record the completed prototype and limits observed in source review."""
import hashlib
import json
from pathlib import Path

root = Path(__file__).resolve().parent.parent
output = root / 'outputs/3d-pilot'
manifest_path = output / 'manifest.json'
manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
scene = json.loads((output / 'scene.json').read_text(encoding='utf-8'))
assert len(scene['people']) == 4 and len(scene['frames']) == 360
assert scene['sourceSha256'] == manifest['sha256']
assert (output / 'reconstruction-reviewed-ids/world4d.glb').is_file()
manifest['title'] = 'Multiple attackers - shared 3D scene pilot'
manifest['prototypeReady'] = True
manifest['identityMapping3d'] = scene['identityMapping2d']
manifest['reconstruction'].pop('initializationFrame', None)
manifest['reconstruction']['cameraInitializationFrame'] = 30
manifest['reconstruction']['outputDirectory'] = 'reconstruction-reviewed-ids'
manifest['reconstruction']['reference2dSha256'] = hashlib.sha256((root / 'outputs/pilot/poses-tracked.jsonl').read_bytes()).hexdigest()
manifest['deliverablesPending'] = []
manifest['deliverables'] = ['scene.json', 'orbitable synchronized viewer', 'reconstruction-reviewed-ids/world4d.glb', 'reconstruction-reviewed-ids/world4d.mcs', 'scene-validation.json']
manifest['reviewRequired'] = ['Depth and metric scale are estimates, not measured distances.', 'Hidden limbs can follow a foreground participant during overlap; compare the source before interpreting contact.', 'Faded poses flag interpolated tracking boxes or large source-box overlap, not measured visibility.', 'Contact and full-frame identity accuracy remain unverified.']
manifest['reviewAnchors'] = [18, 19, 20.5, 22.5, 24, 25.5, 27, 28, 29.966666666666665]
manifest['limitationsObserved'] = ['At 25.5 seconds white is hidden and uses interpolated boxes; at 27 seconds grey is hidden and uses interpolated boxes.', 'At 29.967 seconds the blue participant pose drifts onto foreground white despite a correct source identity label.', 'Instructor and grey stop rendering after source track frames 343 and 350; white begins at frame 26.']
manifest_path.write_text(json.dumps(manifest, indent=2), encoding='utf-8')
report_path = output / 'scene-validation.json'
report = json.loads(report_path.read_text(encoding='utf-8'))
report['sourceReview'] = {'anchorFrames': [0, 30, 75, 135, 180, 225, 270, 300, 359], 'identityLabels': 'matched to reviewed 2D reference IDs', 'poseIdentityAccuracy': 'limited by overlap; late blue pose drift observed', 'contactAccuracy': 'unverified', 'relativeDepthAccuracy': 'unverified'}
report_path.write_text(json.dumps(report, indent=2), encoding='utf-8')
print('Completed four-person prototype recorded; uncertainty remains explicit.')

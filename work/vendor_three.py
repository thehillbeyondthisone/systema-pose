"""Vendor only the orbit-viewer files from an integrity-checked npm release."""
import base64
import hashlib
import io
import json
import tarfile
import urllib.request
from pathlib import Path

root = Path(__file__).resolve().parent.parent
with urllib.request.urlopen('https://registry.npmjs.org/three/0.180.0', timeout=45) as response:
    metadata = json.load(response)
with urllib.request.urlopen(metadata['dist']['tarball'], timeout=90) as response:
    archive_bytes = response.read()
algorithm, expected = metadata['dist']['integrity'].split('-', 1)
assert base64.b64encode(hashlib.new(algorithm, archive_bytes).digest()).decode() == expected
destination = root / 'teaching_suite/public/vendor/three'
destination.mkdir(parents=True, exist_ok=True)
with tarfile.open(fileobj=io.BytesIO(archive_bytes), mode='r:gz') as archive:
    for source, name in [('package/build/three.module.js', 'three.module.js'),
                         ('package/build/three.core.js', 'three.core.js'),
                         ('package/examples/jsm/controls/OrbitControls.js', 'OrbitControls.js'),
                         ('package/LICENSE', 'LICENSE')]:
        (destination / name).write_bytes(archive.extractfile(source).read())
(destination / 'provenance.json').write_text(json.dumps({'version': metadata['version'],
    'tarball': metadata['dist']['tarball'], 'integrity': metadata['dist']['integrity']}, indent=2))
print('Vendored Three.js 0.180.0 and OrbitControls; npm integrity verified.')

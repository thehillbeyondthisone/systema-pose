"""Vendor matching Three.js GLB loaders and rig utilities from its verified npm archive."""
import base64
import hashlib
import io
import json
import tarfile
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DESTINATION = ROOT / 'teaching_suite/public/vendor/three'
FILES = ['loaders/GLTFLoader.js', 'utils/SkeletonUtils.js', 'utils/BufferGeometryUtils.js']
metadata = json.loads((DESTINATION / 'provenance.json').read_text(encoding='utf-8'))
archive_path = ROOT / 'work/tmp/three-0.180.0.tgz'
if archive_path.exists():
    archive_bytes = archive_path.read_bytes()
else:
    with urllib.request.urlopen(metadata['tarball'], timeout=90) as response:
        archive_bytes = response.read()
    archive_path.parent.mkdir(parents=True, exist_ok=True)
    archive_path.write_bytes(archive_bytes)
algorithm, expected = metadata['integrity'].split('-', 1)
assert base64.b64encode(hashlib.new(algorithm, archive_bytes).digest()).decode() == expected
with tarfile.open(fileobj=io.BytesIO(archive_bytes), mode='r:gz') as archive:
    for name in FILES:
        output = DESTINATION / 'addons' / name
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_bytes(archive.extractfile('package/examples/jsm/' + name).read())
    # Exporter is a local test dependency, excluded from the published site.
    exporter = ROOT / 'work/tmp/GLTFExporter.js'
    exporter.write_bytes(archive.extractfile('package/examples/jsm/exporters/GLTFExporter.js').read())
print('Vendored Three.js 0.180.0 GLB loader and skeleton utilities; npm integrity verified.')

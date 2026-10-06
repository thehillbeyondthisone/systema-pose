"""Fetch the pipeline's official public depth checkpoint once, with LFS hash verification."""
import hashlib
import json
import shutil
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
NAME = 'metric_depth_vit_large_800k.pth'
DESTINATION = Path('D:/systema_pose_3d_assets/torch/hub/checkpoints') / NAME
metadata_url = 'https://huggingface.co/api/models/JUGGHM/Metric3D/tree/main'
with urllib.request.urlopen(metadata_url, timeout=30) as response:
    entry = next(item for item in json.load(response) if item['path'] == NAME)
expected_size = entry['size']
expected_hash = entry['lfs']['oid']
assert expected_size == 1647972663 and len(expected_hash) == 64
def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()
DESTINATION.parent.mkdir(parents=True, exist_ok=True)
if not DESTINATION.exists():
    partial = DESTINATION.with_suffix('.partial')
    if partial.exists():
        raise SystemExit('Partial download exists; inspect before replacing.')
    if shutil.disk_usage('D:/').free < expected_size + 8 * 2**30:
        raise SystemExit('Not enough D: space while retaining an 8 GiB reserve.')
    url = 'https://huggingface.co/JUGGHM/Metric3D/resolve/main/' + NAME + '?download=true'
    request = urllib.request.Request(url, headers={'User-Agent': 'systema-local-reconstruction'})
    count, last_update = 0, time.monotonic()
    with urllib.request.urlopen(request, timeout=30) as response, partial.open('wb') as stream:
        while chunk := response.read(4 * 2**20):
            if shutil.disk_usage('D:/').free < 8 * 2**30:
                raise SystemExit('Stopping download to preserve the D: reserve.')
            stream.write(chunk)
            count += len(chunk)
            if time.monotonic() - last_update > 15:
                print(f'Metric3D download: {count / expected_size:.0%}', flush=True)
                last_update = time.monotonic()
    if partial.stat().st_size != expected_size or digest(partial) != expected_hash:
        raise SystemExit('Depth checkpoint failed size/hash validation.')
    partial.replace(DESTINATION)
if DESTINATION.stat().st_size != expected_size or digest(DESTINATION) != expected_hash:
    raise SystemExit('Existing depth checkpoint does not match official LFS metadata.')
report = {'path': str(DESTINATION), 'bytes': expected_size, 'sha256': expected_hash,
          'source': 'https://huggingface.co/JUGGHM/Metric3D', 'verifiedAgainstOfficialLfs': True}
(ROOT / 'outputs/3d-pilot/metric3d-validation.json').write_text(json.dumps(report, indent=2))
print(json.dumps(report, indent=2))

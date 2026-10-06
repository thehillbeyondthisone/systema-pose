import hashlib
import json
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MODEL_DIR = ROOT / 'work' / 'models'
URLS = {
    'detector': 'https://download.openmmlab.com/mmpose/v1/projects/rtmposev1/onnx_sdk/yolox_m_8xb8-300e_humanart-c2c7a14a.zip',
    'pose': 'https://download.openmmlab.com/mmpose/v1/projects/rtmw/onnx_sdk/rtmw-dw-x-l_simcc-cocktail14_270e-384x288_20231122.zip',
}
manifest = []
for role, url in URLS.items():
    archive = MODEL_DIR / url.rsplit('/', 1)[1]
    dest = MODEL_DIR / role
    dest.mkdir(parents=True, exist_ok=True)
    with urllib.request.urlopen(urllib.request.Request(url, method='HEAD'), timeout=60) as response:
        advertised = response.headers.get('Content-Length')
    print(f'{role}: advertised download bytes {advertised}', flush=True)
    if not archive.exists():
        urllib.request.urlretrieve(url, archive)
    with zipfile.ZipFile(archive) as z:
        for member in z.infolist():
            target = (dest / member.filename).resolve()
            if not target.is_relative_to(dest.resolve()):
                raise ValueError('Unsafe archive member')
        z.extractall(dest)
    models = list(dest.rglob('*.onnx'))
    manifest.append({'role': role, 'url': url, 'archive_bytes': archive.stat().st_size,
                     'archive_sha256': hashlib.file_digest(archive.open('rb'), 'sha256').hexdigest(),
                     'onnx': [{'path': str(p), 'bytes': p.stat().st_size,
                               'sha256': hashlib.file_digest(p.open('rb'), 'sha256').hexdigest()} for p in models]})
    print(f'{role}: downloaded {archive.stat().st_size / 2**20:.1f} MiB', flush=True)
(MODEL_DIR / 'manifest.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')

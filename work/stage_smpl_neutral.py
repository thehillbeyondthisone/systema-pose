"""Convert the approved official SMPL neutral NPZ to the loader's PKL format."""
import hashlib
import json
import pickle
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
SOURCE = Path('/mnt/c/Users/thefo/Downloads/SMPL_NEUTRAL.npz')
EXPECTED_HASH = '064ec8db4c29c13a5d5680effd378d0080a52702978272edae08854320455f2e'
TARGET = ROOT / 'work/PromptHMR/data/body_models/smpl/SMPL_NEUTRAL.pkl'

def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()

if digest(SOURCE) != EXPECTED_HASH:
    raise SystemExit('The official downloaded file changed; inspect before converting.')
if np.__version__.split('.')[0] != '1':
    raise SystemExit('Use the reconstruction runtime NumPy 1.x for compatible serialization.')
with np.load(SOURCE, allow_pickle=False) as archive:
    data = {key: archive[key] for key in archive.files}
for key, shape in {
    'v_template': (6890, 3), 'f': (13776, 3), 'J_regressor': (24, 6890),
    'weights': (6890, 24), 'posedirs': (6890, 3, 207),
    'shapedirs': (6890, 3, 300), 'kintree_table': (2, 24),
}.items():
    if data[key].shape != shape or not np.isfinite(data[key]).all():
        raise SystemExit(f'Invalid model array: {key}')
if data['f'].max() >= 6890 or not np.allclose(data['weights'].sum(axis=1), 1, atol=1e-5):
    raise SystemExit('Invalid face indices or skinning weights.')
TARGET.parent.mkdir(parents=True, exist_ok=True)
if TARGET.exists():
    raise SystemExit('Target already exists; inspect before replacing.')
temporary = TARGET.with_suffix('.tmp')
with temporary.open('wb') as stream:
    pickle.dump(data, stream, protocol=4)
# Verify the serialization retains every official array unchanged.
with temporary.open('rb') as stream:
    restored = pickle.load(stream)
assert data.keys() == restored.keys()
assert all(np.array_equal(data[key], restored[key]) for key in data)
temporary.replace(TARGET)
report = {
    'source': str(SOURCE), 'sourceUrl': 'https://download.is.tue.mpg.de/download.php?domain=smpl&sfile=julia/SMPL_NEUTRAL.npz',
    'sourceSha256': EXPECTED_HASH, 'target': str(TARGET), 'targetSha256': digest(TARGET),
    'conversion': 'NPZ arrays serialized unchanged into a PKL dictionary',
    'arrayRoundTripVerified': True, 'numpy': np.__version__,
    'licenseAcceptedByUser': '2026-10-01',
}
(ROOT / 'outputs/3d-pilot/smpl-neutral-validation.json').write_text(json.dumps(report, indent=2))
print(json.dumps(report, indent=2))

"""Stage the existing 2D pilot for a shared-scene reconstruction, unchanged."""
import hashlib
import json
import shutil
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / 'outputs' / 'pilot'
OUT = ROOT / 'outputs' / '3d-pilot'
REPO = ROOT / 'work' / 'PromptHMR'
BODY_MODELS = [
    'data/body_models/smplx/SMPLX_NEUTRAL.npz',
    'data/body_models/smpl/SMPL_NEUTRAL.pkl',
    'data/body_models/smplx2smpl.pkl',
    'data/body_models/smplx2smpl_joints.npy',
    'data/body_models/smplx/SMPLX_neutral_array_f32_slim.npz',
]


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def stage():
    OUT.mkdir(parents=True, exist_ok=True)
    input_path = OUT / 'multiple-attackers-18-30.mp4'
    original = SOURCE / 'source-reference.mp4'
    source_hash = digest(original)
    if not input_path.exists() or digest(input_path) != source_hash:
        shutil.copy2(original, input_path)
    rows = [json.loads(line) for line in (SOURCE / 'poses-tracked.jsonl').read_text(encoding='utf-8').splitlines()]
    assert len(rows) == 360
    assert [r['source_frame_index'] for r in rows] == list(range(540, 900))
    assert digest(input_path) == source_hash
    git = shutil.which('git') or str(Path.home() / '.cache/codex-runtimes/codex-primary-runtime/dependencies/native/git/cmd/git.exe')
    commit = subprocess.check_output([git, '-C', str(REPO), 'rev-parse', 'HEAD'], text=True).strip()
    manifest = {
        'schemaVersion': 1, 'status': 'awaiting_body_models_and_linux_runtime',
        'title': 'Multiple attackers · shared 3D scene pilot',
        'input': input_path.name, 'sha256': source_hash, 'bytes': input_path.stat().st_size,
        'sourceStart': 18, 'sourceEnd': 30, 'fps': 30, 'frames': 360,
        'frameMapping': 'clip frame i maps to original frame 540 + i, at source time 18 + i / 30 seconds',
        'reconstruction': {'method': 'PromptHMR world-coordinate multi-person video',
                           'repository': 'https://github.com/yufu-wang/PromptHMR', 'commit': commit,
                           'cameraAssumption': 'moving-camera estimation; static mode requires source review',
                           'noncommercialUseConfirmed': '2026-10-01', 'hasRun': False},
        'bodyModelRequirements': [{'path': p, 'present': (REPO / p).is_file()} for p in BODY_MODELS],
        'reference2d': '../pilot/poses-tracked.jsonl',
        'participants': json.loads((SOURCE / 'identity-anchors.json').read_text(encoding='utf-8'))['participants'],
        'identityMapping3d': None,
        'reviewRequired': ['Match reconstructed track IDs to reviewed 2D participants; do not assume identical IDs.',
                           'Compare source, side and overhead views, especially at 20.5–25.5 seconds.',
                           'Check relative depth, foot placement, body intersections and contact poses.',
                           'Preserve missing/occluded anatomy as estimated and contact as unreviewed.'],
        'deliverablesPending': ['scene.json with shared XYZ skeletons and synchronized cameras',
                                'orbitable viewer', 'source/side/overhead review', 'GLB scene when pipeline export succeeds'],
    }
    (OUT / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
    print(f'Staged {len(rows)} frames, original source seconds 18–30. Input SHA-256 verified.')
    print(f'Missing body-model assets: {sum(not item["present"] for item in manifest["bodyModelRequirements"])}')


if __name__ == '__main__':
    stage()

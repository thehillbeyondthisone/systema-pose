"""Run the approved local reconstruction and enforce Windows drive reserves."""
import json
import argparse
import shutil
import subprocess
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
parser = argparse.ArgumentParser()
parser.add_argument('--all-four', action='store_true')
parser.add_argument('--reviewed-identities', action='store_true')
args = parser.parse_args()
OUTPUT = ROOT / 'outputs/3d-pilot'
validation = json.loads((OUTPUT / 'runtime-validation.json').read_text(encoding='utf-8'))
if validation.get('errors') or validation.get('pipelineImport') != 'passed':
    raise SystemExit('The full inference runtime must pass validation first.')
def check_space():
    for drive in ['C:/', 'D:/']:
        free = shutil.disk_usage(drive).free / 2**30
        if free < 8:
            raise RuntimeError(f'{drive} has {free:.2f} GiB free; preserving the 8 GiB reserve.')
check_space()
manifest_path = OUTPUT / 'manifest.json'
manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
manifest['status'] = 'reconstructing'
manifest_path.write_text(json.dumps(manifest, indent=2), encoding='utf-8')
command = [
    'wsl', '-d', 'Systema3D', '-u', 'root', '--exec', 'env',
    'TORCH_HOME=/mnt/d/systema_pose_3d_assets/torch', 'PYTHONUNBUFFERED=1',
    '/opt/systema3d/env/bin/python',
    '/mnt/c/Users/thefo/OneDrive/Desktop/systema_pose/work/run_3d_pilot.py',
    '--repo', '/opt/systema3d/PromptHMR', '--image-batch-size', '2',
]
if args.all_four:
    command.insert(command.index('/opt/systema3d/env/bin/python'), 'SYSTEMA_SEED_FRAME=30')
    command.extend(['--reconstruction-subdir', 'reconstruction-all-four', '--expected-participants', '4'])
if args.reviewed_identities:
    if args.all_four:
        raise SystemExit('Select one reconstruction mode.')
    command.extend(['--reconstruction-subdir', 'reconstruction-reviewed-ids', '--expected-participants', '4', '--reviewed-identities'])
log_path = OUTPUT / 'inference.log'
with log_path.open('w', encoding='utf-8') as log:
    # WSL can give direct stdout/stderr file handles independent offsets.
    # Merge through one pipe and use one Windows writer to retain every line.
    process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                               text=True, encoding='utf-8', errors='replace')
    def capture_output():
        for line in process.stdout:
            log.write(line)
            log.flush()
    reader = threading.Thread(target=capture_output)
    reader.start()
    print(f'Reconstruction running; log: {log_path}', flush=True)
    try:
        while process.poll() is None:
            check_space()
            time.sleep(3)
    except RuntimeError as error:
        # Terminate only this dedicated runtime, never the user's other WSL work.
        subprocess.run(['wsl', '--terminate', 'Systema3D'], check=False)
        process.wait()
        reader.join()
        raise SystemExit(str(error))
    reader.join()
    print(f'Reconstruction exit code: {process.returncode}', flush=True)
    raise SystemExit(process.returncode)

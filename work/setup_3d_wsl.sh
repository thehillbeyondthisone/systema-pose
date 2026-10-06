#!/usr/bin/env bash
# Dedicated Systema3D WSL runtime; no Docker and no duplicated checkpoints.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive PIP_NO_CACHE_DIR=1 UV_NO_CACHE=1
PROJECT='/mnt/c/Users/thefo/OneDrive/Desktop/systema_pose'
ENVIRONMENT='/opt/systema3d/env'
check_space() {
    python3 - <<'PY'
import shutil
for path, reserve in [('/', 3), ('/mnt/c', 8), ('/mnt/d', 8)]:
    free = shutil.disk_usage(path).free / 2**30
    print(f'{path}: {free:.2f} GiB free', flush=True)
    if free < reserve:
        raise SystemExit(f'Stopping: {path} has less than {reserve} GiB reserve.')
PY
}
case "${1:?Select base, python, torch, requirements, wheels or source}" in
base)
    check_space
    apt-get update
    apt-get install -y --no-install-recommends python3-venv build-essential git ffmpeg libgl1 libegl1 libsuitesparse-dev libglib2.0-0 ca-certificates
    apt-get clean
    ;;
python)
    check_space
    mkdir -p /opt/systema3d
    python3 -m venv /opt/systema3d/bootstrap
    /opt/systema3d/bootstrap/bin/pip install --no-cache-dir uv==0.12.21
    /opt/systema3d/bootstrap/bin/uv venv --python 3.11 --seed "$ENVIRONMENT"
    ;;
torch)
    check_space
    "$ENVIRONMENT/bin/pip" install --no-cache-dir numpy==1.26.4
    "$ENVIRONMENT/bin/pip" install --no-cache-dir torch==2.4.0 torchvision==0.19.0 torchaudio==2.4.0 --index-url https://download.pytorch.org/whl/cu121
    ;;
requirements)
    check_space
    printf 'torch==2.4.0\ntorchvision==0.19.0\ntorchaudio==2.4.0\nnumpy==1.26.4\n' > /opt/systema3d/constraints.txt
    "$ENVIRONMENT/bin/pip" install --no-cache-dir torch-scatter -f https://data.pyg.org/whl/torch-2.4.0+cu121.html -c /opt/systema3d/constraints.txt
    "$ENVIRONMENT/bin/pip" install --no-cache-dir xformers==0.0.27.post2 --index-url https://download.pytorch.org/whl/cu121 --no-deps
    "$ENVIRONMENT/bin/pip" install --no-cache-dir -r "$PROJECT/work/PromptHMR/requirements.txt" -c /opt/systema3d/constraints.txt
    ;;
wheels)
    check_space
    "$ENVIRONMENT/bin/pip" install --no-cache-dir "$PROJECT/work/PromptHMR/data/wheels/"{detectron2-0.8-cp311-cp311-linux_x86_64,droid_backends_intr-0.3-cp311-cp311-linux_x86_64,lietorch-0.3-cp311-cp311-linux_x86_64,sam2-1.5-cp311-cp311-linux_x86_64}.whl -c /opt/systema3d/constraints.txt
    if [ ! -d /opt/systema3d/chumpy ]; then
        git clone https://github.com/Arthur151/chumpy /opt/systema3d/chumpy
    fi
    "$ENVIRONMENT/bin/pip" install --no-cache-dir /opt/systema3d/chumpy --no-build-isolation
    ;;
source)
    check_space
    "$ENVIRONMENT/bin/python" - <<'PY'
from pathlib import Path
import shutil
source = Path('/mnt/c/Users/thefo/OneDrive/Desktop/systema_pose/work/PromptHMR')
destination = Path('/opt/systema3d/PromptHMR')
if destination.exists():
    raise SystemExit('Source destination already exists; inspect before replacing.')
shutil.copytree(source, destination, ignore=shutil.ignore_patterns('data', '.git', '__pycache__'))
(destination / 'data').mkdir()
(destination / 'data/body_models').symlink_to(source / 'data/body_models', target_is_directory=True)
(destination / 'data/pretrain').symlink_to('/mnt/d/systema_pose_3d_assets/pretrain', target_is_directory=True)
print('Source staged; existing body models and checkpoint files are linked without copying.')
PY
    ;;
*) exit 2 ;;
esac
check_space

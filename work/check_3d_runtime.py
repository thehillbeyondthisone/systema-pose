"""Inspect installed dependencies by default; CUDA tests require --use-gpu."""
import importlib
import json
import platform
import sys
import os
import argparse
import shutil
import importlib.util
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
parser = argparse.ArgumentParser()
parser.add_argument('--output', type=Path, default=ROOT / 'outputs/3d-pilot/runtime-validation.json')
parser.add_argument('--repo', type=Path, default=Path(os.environ.get('SYSTEMA_PHMR_REPO', ROOT / 'work/PromptHMR')))
mode = parser.add_mutually_exclusive_group()
mode.add_argument('--inventory-only', action='store_true', help='Inspect files and package availability without importing GPU libraries (default)')
mode.add_argument('--use-gpu', action='store_true', help='Explicitly authorize CUDA operations and body-model forward tests')
parser.add_argument('--pause-file', type=Path)
args = parser.parse_args()
report = {'platform': platform.platform(), 'python': sys.version, 'imports': {}, 'errors': []}
report['assets'] = []
from prepare_3d_pilot import BODY_MODELS
for relative in BODY_MODELS + [
    'data/pretrain/phmr/checkpoint.ckpt', 'data/pretrain/phmr/config.yaml',
    'data/pretrain/phmr_vid/prhmr_release_002.ckpt', 'data/pretrain/phmr_vid/prhmr_release_002.yaml',
    'data/pretrain/vitpose-h-coco_25.pth', 'data/pretrain/camcalib_sa_biased_l2.ckpt',
    'data/pretrain/droidcalib.pth',
    'data/pretrain/sam2_ckpts/sam2_hiera_tiny.pt', 'data/pretrain/sam2_ckpts/keypoint_rcnn_5ad38f.pkl',
]:
    path = args.repo / relative
    present = path.is_file() and path.stat().st_size > 0
    report['assets'].append({'name': relative, 'present': present})
    if not present:report['errors'].append('Missing model file: ' + relative)
torch_home = Path(os.environ.get('TORCH_HOME', str(Path.home() / '.cache/torch')))
for name in ['deeplabv3_resnet50_coco-cd0a2569.pth']:
    present = (torch_home / 'hub/checkpoints' / name).is_file()
    report['assets'].append({'name': name, 'present': present})
    if not present:report['errors'].append('Missing cached camera segmentation model: ' + name)
vision = list((torch_home / 'hub').glob('pytorch_vision*'))
if not vision:report['errors'].append('Missing cached torchvision hub source.')
report['storage'] = []
for mount, reserve in [('/', 3), ('/mnt/c', 8), ('/mnt/d', 8)]:
    try:
        free = shutil.disk_usage(mount).free / 2**30
        report['storage'].append({'name': mount, 'freeGiB': round(free, 2), 'reserveGiB': reserve})
        if free < reserve:report['errors'].append(f'{mount} needs at least {reserve} GiB free.')
    except OSError as error:report['errors'].append(f'{mount}: {error}')
if not shutil.which('ffmpeg'):report['errors'].append('Linux FFmpeg is missing.')
modules = ['torch', 'torchvision', 'torch_scatter', 'xformers', 'detectron2',
               'droid_backends_intr', 'lietorch', 'sam2', 'smplx', 'open_clip',
               'pytorch_lightning', 'cv2', 'smplcodec', 'smpl_rs', 'gloss', 'chumpy']

def write_report():
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2), encoding='utf-8')
    print(json.dumps(report, indent=2))


def require_gpu_permission():
    if args.pause_file and (not args.pause_file.exists() or json.loads(args.pause_file.read_text()).get('gpuPaused', True)):
        raise RuntimeError('GPU use is paused in the dashboard.')


if not args.use_gpu:
    report['mode'] = 'inventory'
    for module in modules:
        if importlib.util.find_spec(module) is None:report['errors'].append('Missing Python package: ' + module)
        else:report['imports'][module] = 'installed; import/GPU validation deferred'
    if not (args.repo / 'pipeline/__init__.py').is_file():report['errors'].append('PromptHMR pipeline source is missing.')
    write_report()
    raise SystemExit(1 if report['errors'] else 0)

require_gpu_permission()
for module in modules:
    try:
        loaded = importlib.import_module(module)
        report['imports'][module] = str(getattr(loaded, '__version__', 'imported'))
    except Exception as error:
        report['errors'].append(f'{module}: {type(error).__name__}: {error}')

try:
    require_gpu_permission()
    import torch
    import torchvision
    import torch_scatter
    from xformers.ops import memory_efficient_attention
    if not torch.cuda.is_available():
        raise RuntimeError('CUDA is unavailable')
    report['gpu'] = torch.cuda.get_device_name(0)
    report['cuda'] = torch.version.cuda
    x = torch.ones((64, 64), device='cuda')
    assert (x @ x).sum().item() == 262144
    boxes = torch.tensor([[0., 0., 1., 1.], [0., 0., 1., 1.]], device='cuda')
    keep = torchvision.ops.nms(boxes, torch.tensor([0.9, 0.8], device='cuda'), 0.5)
    assert keep.tolist() == [0]
    assert torch_scatter.scatter_add(torch.ones(4, device='cuda'),
                                     torch.zeros(4, dtype=torch.long, device='cuda')).item() == 4
    q = torch.randn((1, 32, 2, 32), device='cuda', dtype=torch.float16)
    assert torch.isfinite(memory_efficient_attention(q, q, q)).all()
    torch.cuda.synchronize()
    report['cudaOperations'] = 'matrix multiplication, NMS, scatter and memory-efficient attention passed'
except Exception as error:
    report['errors'].append(f'CUDA operations: {type(error).__name__}: {error}')

try:
    require_gpu_permission()
    os.chdir(args.repo)
    sys.path.insert(0, str(Path.cwd()))
    from pipeline import Pipeline
    from smplx import SMPL, SMPLX
    body = SMPLX('data/body_models/smplx/SMPLX_NEUTRAL.npz', use_pca=False,
                 flat_hand_mean=True, num_betas=10).cuda().eval()
    with torch.no_grad():
        joints = body().joints
    assert joints.shape[1] >= 22 and torch.isfinite(joints).all()
    report['pipelineImport'] = 'passed'
    report['smplxForward'] = 'finite CUDA joints'
    neutral = SMPL('data/body_models/smpl/SMPL_NEUTRAL.pkl', num_betas=10).cuda().eval()
    with torch.no_grad():
        neutral_output = neutral()
    assert neutral_output.vertices.shape == (1, 6890, 3)
    assert torch.isfinite(neutral_output.joints).all()
    report['smplForward'] = 'converted official neutral model produced finite CUDA joints and 6890 vertices'
except Exception as error:
    report['errors'].append(f'Pipeline/model check: {type(error).__name__}: {error}')

write_report()
raise SystemExit(1 if report['errors'] else 0)

"""Exercise Linux/CUDA and inference dependencies before loading the video pipeline."""
import importlib
import json
import platform
import sys
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
report = {'platform': platform.platform(), 'python': sys.version, 'imports': {}, 'errors': []}
for module in ['torch', 'torchvision', 'torch_scatter', 'xformers', 'detectron2',
               'droid_backends_intr', 'lietorch', 'sam2', 'smplx', 'open_clip',
               'pytorch_lightning', 'cv2', 'smplcodec', 'smpl_rs', 'gloss', 'chumpy']:
    try:
        loaded = importlib.import_module(module)
        report['imports'][module] = str(getattr(loaded, '__version__', 'imported'))
    except Exception as error:
        report['errors'].append(f'{module}: {type(error).__name__}: {error}')

try:
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
    os.chdir(Path(os.environ.get('SYSTEMA_PHMR_REPO', ROOT / 'work/PromptHMR')))
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

destination = ROOT / 'outputs/3d-pilot/runtime-validation.json'
destination.write_text(json.dumps(report, indent=2), encoding='utf-8')
print(json.dumps(report, indent=2))
raise SystemExit(1 if report['errors'] else 0)

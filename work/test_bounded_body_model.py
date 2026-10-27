"""Run in the installed Systema3D environment with --allow-gpu."""
import argparse
from dataclasses import dataclass, fields
import os
from pathlib import Path
import sys

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--allow-gpu', action='store_true')
parser.add_argument('--repo', type=Path, default=Path('/opt/systema3d/PromptHMR'))
args = parser.parse_args()
if not args.allow_gpu:raise SystemExit('Pass --allow-gpu when GPU testing is authorized.')
sys.path.insert(0, str(Path(__file__).resolve().parent))
os.chdir(args.repo)
import torch
from smplx import SMPLX
from bounded_body_model import bound_body_model

torch.manual_seed(7)
model = SMPLX('data/body_models/smplx/SMPLX_NEUTRAL.npz', use_pca=False, flat_hand_mean=True, num_betas=10).cuda().eval()
n = 129
kwargs = dict(global_orient=torch.randn(n, 3, device='cuda') * .05,
              body_pose=torch.randn(n, 63, device='cuda') * .05,
              betas=torch.randn(n, 10, device='cuda') * .1, return_full_pose=True,
              jaw_pose=torch.zeros(n, 3, device='cuda'), leye_pose=torch.zeros(n, 3, device='cuda'),
              reye_pose=torch.zeros(n, 3, device='cuda'), left_hand_pose=torch.zeros(n, 45, device='cuda'),
              right_hand_pose=torch.zeros(n, 45, device='cuda'), expression=torch.zeros(n, 10, device='cuda'),
              transl=torch.zeros(n, 3, device='cuda'))
with torch.no_grad():
    reference = model(**kwargs)
    bound_body_model(model)
    actual = model(**kwargs)
for field in fields(reference):
    expected, value = getattr(reference, field.name), getattr(actual, field.name)
    if torch.is_tensor(expected):
        assert expected.shape == value.shape and torch.allclose(expected, value, atol=1e-5, rtol=1e-5), field.name
    else:assert expected == value, field.name
print('PASS actual SMPL-X vertices, joints and pose fields match with bounded mesh batches', flush=True)

@dataclass
class Output:
    joints: object
    vertices: object = None

class Fake:
    def forward(self, values):return Output(values ** 2)

x = torch.randn(9, 3, requires_grad=True)
expected = 2 * x.detach()
output = bound_body_model(Fake(), 4).forward(x)
output.joints.sum().backward()
assert torch.allclose(x.grad, expected)
print('PASS bounded evaluation preserves gradients and non-tensor fields', flush=True)

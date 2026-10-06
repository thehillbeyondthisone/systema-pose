"""Retrieve public assets listed by the pinned official PromptHMR scripts.

No registered SMPL/SMPL-X downloads or browser credentials are accessed here.
"""
import argparse
import json
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'work/download-runtime'))
import gdown

DATA = ROOT / 'work/PromptHMR/data'
INVENTORY = ROOT / 'outputs/3d-pilot/public-asset-inventory.json'
FOLDERS = [
    ('phmr', '1EQ7arZz135T-WpxkS_K1R_hjZp3prh-y', DATA / 'pretrain/phmr'),
    ('phmr_vid', '18SywG7Fc_iTfVNaikjHAZmy-A9I85eKv', DATA / 'pretrain/phmr_vid'),
    ('thirdparty', '1OKhTdL1QVFH3f4hbIEa7jLANx4azuPi1', DATA / 'pretrain/sam2_ckpts'),
    ('body_support', '1JU7CuU2rKkwD7WWjvSZJKpQFFk_Z6NL7', DATA / 'body_models'),
    ('linux_wheels_torch24', '1IXyhVqL25ofI-tYqyUZCqF-h4V20795H', DATA / 'wheels'),
]
DIRECT = [
    ('camcalib_sa_biased_l2.ckpt', '1t4tO0OM5s8XDvAzPW-5HaOkQuV3dHBdO', DATA / 'pretrain'),
    ('droidcalib.pth', '14hgb59Jk2Pvfiqy4nntE7dUrcKgFmKSj', DATA / 'pretrain'),
    ('vitpose-h-coco_25.pth', '1ZprPoNXe_f9a9flr0RhS3XCJBfqhFSeE', DATA / 'pretrain'),
    ('SMPLX_neutral_array_f32_slim.npz', '1v9Qy7ZXWcTM8_a9K2nSLyyVrJMFYcUOk', DATA / 'body_models/smplx'),
]


def inventory():
    entries, errors = [], []
    for group, folder_id, destination in FOLDERS:
        try:
            files = gdown.download_folder(id=folder_id, output=str(destination) + '/',
                                          skip_download=True, quiet=True, use_cookies=False)
            for file in files or []:
                target = Path(file.local_path).resolve()
                if not target.is_relative_to(DATA.resolve()):
                    raise ValueError('Asset path escapes the project data folder')
                entries.append({'group': group, 'id': file.id, 'path': file.path,
                                'target': str(target), 'sourceFolder': folder_id})
            print(f'{group}: {len(files or [])} public files', flush=True)
        except Exception as error:
            errors.append({'group': group, 'error': str(error)})
            print(f'{group}: {error}', flush=True)
    for name, asset_id, destination in DIRECT:
        entries.append({'group': 'direct', 'id': asset_id, 'path': name, 'target': str(destination / name)})
    INVENTORY.write_text(json.dumps({'entries': entries, 'errors': errors}, indent=2), encoding='utf-8')
    for entry in entries:
        print(f'{entry["group"]}: {entry["path"]}', flush=True)


def fetch(groups):
    report = json.loads(INVENTORY.read_text(encoding='utf-8'))
    for entry in report['entries']:
        if groups and entry['group'] not in groups:
            continue
        target = Path(entry['target'])
        if target.is_file() and target.stat().st_size > 0:
            print(f'Present: {target.relative_to(DATA)}', flush=True)
            continue
        if shutil.disk_usage(ROOT).free < 12 * 1024**3:
            raise ValueError('Stopped public downloads to preserve 12 GiB free disk space.')
        target.parent.mkdir(parents=True, exist_ok=True)
        print(f'Downloading: {target.relative_to(DATA)}', flush=True)
        result = gdown.download(id=entry['id'], output=str(target), quiet=True, use_cookies=False,
                               resume=True)
        if not result:
            raise ValueError(f'Download failed: {entry["path"]}')
        print(f'Saved {target.stat().st_size:,} bytes', flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--inventory', action='store_true')
    parser.add_argument('--groups', nargs='*')
    args = parser.parse_args()
    if args.inventory:
        inventory()
    else:
        fetch(args.groups)

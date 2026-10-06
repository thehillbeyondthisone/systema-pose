"""Validate and stage the user-supplied neutral SMPL-X NPZ, without unpickling."""
import argparse
import ast
import hashlib
import json
import shutil
import struct
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def npy_shape(archive, name):
    with archive.open(name + '.npy') as stream:
        if stream.read(6) != b'\x93NUMPY':
            raise ValueError(f'{name}: invalid NPY header')
        major, minor = stream.read(2)
        width = 2 if major == 1 else 4
        length = struct.unpack('<H' if width == 2 else '<I', stream.read(width))[0]
        header = ast.literal_eval(stream.read(length).decode('latin1'))
        return header['shape']


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('source', type=Path)
    args = parser.parse_args()
    source = args.source.resolve()
    with zipfile.ZipFile(source) as archive:
        bad = archive.testzip()
        if bad:
            raise ValueError(f'Corrupt archive member: {bad}')
        shapes = {key: npy_shape(archive, key) for key in
                  ['v_template', 'shapedirs', 'posedirs', 'J_regressor', 'weights', 'kintree_table', 'f']}
    assert shapes['v_template'] == (10475, 3), shapes
    assert shapes['weights'] == (10475, 55), shapes
    assert shapes['J_regressor'] == (55, 10475), shapes
    assert shapes['shapedirs'][0:2] == (10475, 3), shapes
    target = ROOT / 'work/PromptHMR/data/body_models/smplx/SMPLX_NEUTRAL.npz'
    target.parent.mkdir(parents=True, exist_ok=True)
    with source.open('rb') as stream:
        digest = hashlib.file_digest(stream, 'sha256').hexdigest()
    if not target.exists() or hashlib.sha256(target.read_bytes()).hexdigest() != digest:
        shutil.copy2(source, target)
    assert hashlib.sha256(target.read_bytes()).hexdigest() == digest
    evidence = {'source': str(source), 'target': str(target), 'sha256': digest,
                'bytes': target.stat().st_size, 'shapes': shapes,
                'validation': 'ZIP CRC, NPY headers and SHA-256 copy verification',
                'licenseAcceptanceAuthorized': '2026-10-01', 'redistributionAllowed': False}
    (ROOT / 'outputs/3d-pilot/body-model-validation.json').write_text(json.dumps(evidence, indent=2), encoding='utf-8')
    print(f'Validated and staged SMPL-X neutral: {target.stat().st_size:,} bytes; {digest}')


if __name__ == '__main__':
    main()

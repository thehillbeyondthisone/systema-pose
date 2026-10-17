"""Create a compact Gaussian .splat from the studio PLY; standard library only."""
import argparse
import hashlib
import json
import math
import struct
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SOURCE = ROOT / 'Martial Arts Studio - Best Reviewed.ply'
DEFAULT_OUTPUT = ROOT / 'teaching_suite/public/studio/studio.splat'


def convert(source, output):
    digest = hashlib.sha256()
    with source.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix('.tmp')
    count = 0
    try:
        with source.open('rb') as stream, temporary.open('wb') as target:
            fields, vertices, format_name = [], None, None
            if stream.readline().strip() != b'ply':
                raise ValueError('Source is not a PLY file')
            while True:
                raw = stream.readline()
                if not raw:
                    raise ValueError('Incomplete PLY header')
                line = raw.decode('ascii').strip()
                if line.startswith('format '):
                    format_name = line.split()[1]
                elif line.startswith('element vertex '):
                    vertices = int(line.split()[-1])
                elif line.startswith('element '):
                    raise ValueError('Only a vertex-only Gaussian PLY is supported')
                elif line.startswith('property '):
                    words = line.split()
                    if words[1] != 'float':
                        raise ValueError('Only float32 PLY properties are supported')
                    fields.append(words[2])
                elif line == 'end_header':
                    break
            if format_name != 'binary_little_endian' or not vertices:
                raise ValueError('Expected binary little-endian Gaussian PLY')
            required = ['x','y','z','f_dc_0','f_dc_1','f_dc_2','opacity',
                        'scale_0','scale_1','scale_2','rot_0','rot_1','rot_2','rot_3']
            if not set(required).issubset(fields):
                raise ValueError('PLY is missing Gaussian properties')
            indices = [fields.index(name) for name in required]
            row = struct.Struct('<' + 'f' * len(fields))
            for index in range(vertices):
                raw = stream.read(row.size)
                if len(raw) != row.size:
                    raise ValueError(f'Truncated PLY at vertex {index}')
                values = row.unpack(raw)
                x,y,z,r,g,b,opacity,sx,sy,sz,qw,qx,qy,qz = [values[i] for i in indices]
                if not all(math.isfinite(v) for v in (x,y,z,r,g,b,opacity,sx,sy,sz,qw,qx,qy,qz)):
                    continue
                # Soft-deleted Gaussians remain in the PLY with negligible opacity.
                alpha = 1 / (1 + math.exp(-max(-80, min(80, opacity))))
                if alpha < 1 / 255:
                    continue
                scales = [math.exp(max(-30, min(12, s))) for s in (sx,sy,sz)]
                length = math.sqrt(qw*qw+qx*qx+qy*qy+qz*qz)
                if length < 1e-8:
                    continue
                colors = [round(max(0,min(1,.5 + .28209479177387814*c))*255) for c in (r,g,b)]
                rotation = [round(max(0,min(255,128+128*q/length))) for q in (qw,qx,qy,qz)]
                target.write(struct.pack('<6f8B',x,y,z,*scales,*colors,round(alpha*255),*rotation))
                count += 1
        temporary.replace(output)
    finally:
        temporary.unlink(missing_ok=True)
    manifest = {'schemaVersion':1,'source':source.name,'sourceSha256':digest.hexdigest(),
                'inputSplats':vertices,'splats':count,'bytes':output.stat().st_size,
                'format':'splat','color':'SH degree 0; higher-order view-dependent color omitted',
                'preserves':['centers','anisotropic scales','rotation','opacity']}
    output.with_suffix('.manifest.json').write_text(json.dumps(manifest,indent=2)+'\n',encoding='utf-8')
    print(f'Prepared {count:,} Gaussian splats ({output.stat().st_size/1024/1024:.1f} MiB): {output}')
    return manifest


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source',type=Path,default=DEFAULT_SOURCE)
    parser.add_argument('--output',type=Path,default=DEFAULT_OUTPUT)
    args = parser.parse_args()
    convert(args.source,args.output)

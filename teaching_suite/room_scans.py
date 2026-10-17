"""Private scan library and explicit per-passage room placement. CPU only."""
import json
import math
from pathlib import Path
import re
import shutil
import struct
import sys


def library(admin):
    root = admin.DATA / 'rooms'
    return [json.loads(path.read_text(encoding='utf-8')) for path in sorted(root.glob('*/record.json'))]


def alignment(value):
    if not isinstance(value, dict):
        raise ValueError('Room placement must be an object.')
    fields = ('x', 'y', 'z', 'pitch', 'yaw', 'roll', 'scale')
    if any(not isinstance(value.get(k), (int, float)) or not math.isfinite(value[k]) for k in fields):
        raise ValueError('Room placement must contain finite numbers.')
    if any(abs(value[k]) > 1000 for k in fields[:3]) or any(abs(value[k]) > 360 for k in fields[3:6]) or not .01 <= value['scale'] <= 100:
        raise ValueError('Room placement is outside the viewer limits.')
    return {k: value[k] for k in fields}


def source_file(raw):
    if not str(raw).strip() or not Path(str(raw)).expanduser().is_absolute():
        raise ValueError('Enter the full path to a scan export on this PC.')
    source = Path(str(raw)).expanduser().resolve()
    if source.is_dir():
        folder = source / '3DGS/ply'
        candidates = list(folder.glob('*_epoch_*.ply')) if folder.is_dir() else list(source.glob('*.ply')) + list(source.glob('*.splat'))
        if not candidates:
            raise ValueError('No Gaussian PLY or .splat found in that folder.')
        epochs = [(int(match[1]), p) for p in candidates if (match := re.search(r'_epoch_(\d+)\.ply$', p.name))]
        if epochs:
            source = max(epochs, key=lambda row: row[0])[1]
        elif len(candidates) == 1:
            source = candidates[0]
        else:
            raise ValueError('This folder contains several scans. Enter the full path to one file.')
    if not source.is_file() or source.suffix.lower() not in ('.ply', '.splat'):
        raise ValueError('Choose a Gaussian PLY, .splat, or a scan export folder on this PC.')
    if source.stat().st_size > 2 * 1024 ** 3:
        raise ValueError('Choose a Gaussian scan under 2 GB.')
    return source


def inspect_splat(path, up_axis):
    """Validate every record and estimate a level floor from opacity-weighted heights."""
    size = path.stat().st_size
    if not size or size % 32:
        raise ValueError('A .splat must contain complete 32-byte Gaussian records.')
    samples = []; bins = {}; stride = max(1, size // 32 // 100000)
    with path.open('rb') as stream:
        for i, row in enumerate(struct.iter_unpack('<6f8B', stream.read())):
            if not all(math.isfinite(v) for v in row[:6]) or any(v <= 0 for v in row[3:6]):
                raise ValueError('Scan contains invalid Gaussian centers or scales.')
            if i % stride or row[9] < 80:
                continue
            x, y, z = row[:3]; height = z if up_axis == 'z' else y
            samples.append((x, y, z)); cell = round(height / .025)
            bins[cell] = bins.get(cell, 0) + row[9] / 255
    if len(samples) < 100:
        raise ValueError('Scan has too few visible Gaussians.')
    axis = 2 if up_axis == 'z' else 1
    heights = sorted(p[axis] for p in samples); low, high = heights[len(heights)//100], heights[len(heights)*99//100]
    # Only lower surfaces can be the floor; this remains an explicitly labelled estimate.
    candidates = {k: v for k, v in bins.items() if low - .1 <= k * .025 <= low + (high-low)*.3}
    floor = max(candidates, key=candidates.get) * .025 if candidates else low
    horizontal = (0, 1) if up_axis == 'z' else (0, 2)
    centers = [sorted(p[a] for p in samples)[len(samples)//2] for a in horizontal]
    return {'x': -centers[0], 'y': -floor, 'z': centers[1] if up_axis == 'z' else -centers[1],
            'pitch': -90 if up_axis == 'z' else 0, 'yaw': 0, 'roll': 0, 'scale': 1}


def import_scan(admin, raw):
    source = source_file(raw.get('path', ''))
    up_axis = raw.get('upAxis', 'z')
    if up_axis not in ('y', 'z'):
        raise ValueError('Choose the scan’s up axis.')
    title = str(raw.get('title', '')).strip()[:120] or source.stem

    def action(identity, progress):
        progress['message'] = 'Preparing the Gaussian room scan on the CPU…'
        source_hash = admin.digest(source); scan_id = 'room-' + source_hash[:16]
        root = admin.DATA / 'rooms' / scan_id
        temp = admin.DATA / 'room-imports' / identity; temp.mkdir(parents=True)
        target = temp / 'studio.splat'
        if source.suffix.lower() == '.ply':
            sys.path.insert(0, str(admin.WORKSPACE / 'work'))
            from prepare_studio import convert
            convert(source, target)
        else:
            shutil.copyfile(source, target)
        if target.stat().st_size > admin.MAX_ASSET:
            raise ValueError('The compact scan exceeds 95 MB. Export a smaller scan for Pages.')
        initial = inspect_splat(target, up_axis)
        environment = {'schemaVersion': 1, 'id': scan_id, 'title': title, 'asset': 'studio.splat',
                       'sourceSha256': source_hash, 'registration': 'Floor and placement estimate; compare with the footage.',
                       'alignment': initial}
        admin.onboarding.save(temp / 'environment.json', environment)
        record = {'id': scan_id, 'title': title, 'bytes': target.stat().st_size, 'splats': target.stat().st_size//32,
                  'sourceSha256': source_hash, 'upAxis': up_axis, 'importedAt': admin.now()}
        admin.onboarding.save(temp / 'record.json', record)
        root.parent.mkdir(parents=True, exist_ok=True)
        if root.exists():
            if not temp.resolve().is_relative_to((admin.DATA / 'room-imports').resolve()):
                raise ValueError('Invalid temporary import directory.')
            shutil.rmtree(temp)
        else:
            temp.replace(root)
        return {'message': 'Room scan imported locally. Attach it to a staged 3D passage and review its placement.', 'roomId': scan_id}
    return admin.job('room-import', action)


def attach(admin, clip_id, raw):
    with admin.LOCK:
        if admin.BUSY.locked() or clip_id not in admin.saved()['staged']:
            raise ValueError('Choose an idle, newly staged passage.')
        catalog = admin.catalog(); entry = next(e for e in catalog['lessons'] if e['id'] == clip_id)
        if not entry.get('scene'):
            raise ValueError('Reconstruct this passage before attaching a room.')
        room_id = raw.get('roomId')
        if not isinstance(room_id, str) or not re.fullmatch(r'room-[a-f0-9]{16}', room_id):
            raise ValueError('Choose a room from the local scan library.')
        root = admin.DATA / 'rooms' / room_id
        if not (root / 'record.json').is_file():
            raise ValueError('That room scan is unavailable.')
        prefix = f'site/clips/{clip_id}/'
        destination = admin.PROJECT / prefix
        config = json.loads((root / 'environment.json').read_text(encoding='utf-8'))
        shutil.copyfile(root / 'studio.splat', destination / 'studio.splat')
        admin.onboarding.save(destination / 'environment.json', config)
        entry['environment'] = prefix + 'environment.json'; admin.onboarding.save(admin.CATALOG, catalog)
        state = admin.saved(); state['preview'] = None; admin.save_state(state)
        return {'message': 'Room attached. Build a preview, adjust its placement in the viewer, then save that placement here.'}


def save_placement(admin, clip_id, raw):
    with admin.LOCK:
        if admin.BUSY.locked() or clip_id not in admin.saved()['staged']:
            raise ValueError('Choose an idle, newly staged passage.')
        entry = next(e for e in admin.catalog()['lessons'] if e['id'] == clip_id)
        if not entry.get('environment'):
            raise ValueError('Attach a room first.')
        path = admin.PROJECT / entry['environment']; config = json.loads(path.read_text(encoding='utf-8'))
        if raw.get('studio') != config['id'] or raw.get('sourceSha256') != entry['sourceSha256'] or raw.get('calibrationId'):
            raise ValueError('Room placement belongs to another scan, video or calibration.')
        config['alignment'] = alignment(raw.get('alignment'))
        admin.onboarding.save(path, config)
        state = admin.saved(); state['preview'] = None; admin.save_state(state)
        return {'message': 'Room placement saved for publication. Build and review a fresh public preview.'}

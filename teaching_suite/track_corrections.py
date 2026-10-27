"""Reviewed track inclusion, trimming and identity joins for staged passages.

The immutable detector output stays in private admin storage. Each edit is rebuilt
from that output, so exclusions and joins can always be undone without inference.
"""
from collections import Counter
import copy
import json
import shutil
import unicodedata
import uuid


def _read(path):
    return json.loads(path.read_text(encoding='utf-8'))


def _asset(admin, clip_id, relative):
    if not isinstance(relative, str):
        raise ValueError('The staged clip has an invalid asset path.')
    clip_root = (admin.PROJECT / 'site' / 'clips').resolve()
    folder = (clip_root / clip_id).resolve()
    path = (admin.PROJECT / relative).resolve()
    if (not clip_root.is_relative_to(admin.PROJECT.resolve()) or folder != clip_root / clip_id
            or not path.is_relative_to(folder) or not path.is_file()):
        raise ValueError('The staged clip asset is missing or outside its clip folder.')
    return path


def _context(admin, clip_id):
    if not isinstance(clip_id, str) or len(clip_id) > 64 or not admin.SLUG.fullmatch(clip_id):
        raise ValueError('Unknown staged clip.')
    if clip_id not in admin.saved()['staged']:
        raise ValueError('Track corrections are available for newly staged clips.')
    catalog = admin.catalog()
    entry = next((row for row in catalog['lessons'] if row['id'] == clip_id), None)
    if entry is None:
        raise ValueError('Unknown staged clip.')
    video = _asset(admin, clip_id, entry.get('video'))
    if admin.digest(video) != entry.get('sourceSha256'):
        raise ValueError('The staged video changed. Prepare this passage again before correcting its tracks.')
    motion_path = _asset(admin, clip_id, entry.get('motion'))
    root = (admin.DATA / 'track-corrections' / clip_id).resolve()
    if not root.is_relative_to(admin.DATA.resolve()):
        raise ValueError('Invalid correction storage location.')
    source = root / 'source-motion.json'
    metadata = root / 'source-metadata.json'
    if source.exists() != metadata.exists():
        raise ValueError('The original tracking backup is incomplete. Restore it before editing tracks.')
    for path in (source, metadata, root / 'corrections.json'):
        if not path.resolve().is_relative_to(root):
            raise ValueError('Invalid correction storage location.')
    if source.exists():
        original = _read(source)
        info = _read(metadata)
        if info.get('motionSha256') != admin.digest(source):
            raise ValueError('The original tracking backup changed. Restore it before editing tracks.')
        if info.get('sourceSha256') != entry.get('sourceSha256'):
            raise ValueError('The original tracks belong to different footage. Prepare this passage again.')
        people = info['people']
    else:
        original = _read(motion_path)
        people = original.get('people', entry['people'])
    return catalog, entry, motion_path, root, original, people


def _tracks(motion, people):
    frames = motion.get('frames')
    if not isinstance(frames, list) or not frames:
        raise ValueError('The staged clip has no tracked frames.')
    seen = {}
    for index, frame in enumerate(frames):
        if frame.get('frame') != index or not isinstance(frame.get('people'), list):
            raise ValueError('Tracking must contain every frame indexed from zero. Prepare this passage again.')
        ids = set()
        for person in frame['people']:
            identity = person.get('id')
            if type(identity) is not int or not 1 <= identity <= 100 or identity in ids:
                raise ValueError('Tracking contains invalid or duplicate participant IDs. Prepare this passage again.')
            ids.add(identity)
            seen.setdefault(identity, []).append(index)
    metadata = {person['id']: person for person in people}
    if not seen or set(seen) != set(metadata):
        raise ValueError('Participant names and detected tracks do not match. Prepare this passage again.')
    return [{'id': identity, 'name': metadata[identity]['name'], 'color': metadata[identity].get('color', '#58c4dd'),
             'count': len(indices), 'firstFrame': indices[0], 'lastFrame': indices[-1]}
            for identity, indices in sorted(seen.items())]


def _defaults(tracks, frame_count):
    return [{'sourceId': row['id'], 'targetId': row['id'], 'startFrame': 0,
             'endFrame': frame_count, 'name': row['name']} for row in tracks]


def get(admin, clip_id):
    with admin.LOCK:
        _, entry, path, root, motion, people = _context(admin, clip_id)
        tracks = _tracks(motion, people)
        saved = _read(root / 'corrections.json') if (root / 'corrections.json').exists() else {}
        corrections = saved.get('corrections', _defaults(tracks, len(motion['frames'])))
        return {'clipId': clip_id, 'revision': admin.digest(path), 'motion': motion,
                'tracks': tracks, 'corrections': corrections, 'effectivePeople': entry['people'],
                'overlapPolicy': saved.get('overlapPolicy', 'reject'), 'overlapsResolved': saved.get('overlapsResolved', 0)}


def _validate(raw, tracks, frame_count):
    if not isinstance(raw, dict) or not isinstance(raw.get('revision'), str):
        raise ValueError('Reload tracking before saving corrections.')
    if raw.get('overlapPolicy', 'reject') not in ('reject', 'prefer-primary'):
        raise ValueError('Choose whether overlapping joined tracks must be rejected or explicitly prefer the primary track.')
    rows = raw.get('corrections')
    source_ids = {track['id'] for track in tracks}
    if not isinstance(rows, list) or len(rows) != len(source_ids):
        raise ValueError('Include exactly one correction for every original track. Reload the participant editor.')
    result = {}
    for row in rows:
        if not isinstance(row, dict):
            raise ValueError('Each track correction must be an object.')
        source = row.get('sourceId'); target = row.get('targetId')
        if type(source) is not int or source not in source_ids or source in result:
            raise ValueError('Use each original track ID exactly once.')
        if target is not None and (type(target) is not int or target not in source_ids):
            raise ValueError('Choose an original track ID as the participant, or exclude the track.')
        start, end = row.get('startFrame'), row.get('endFrame')
        if type(start) is not int or type(end) is not int or not 0 <= start < end <= frame_count:
            raise ValueError(f'Track {source}: choose whole frame bounds inside 0–{frame_count}; the end frame is exclusive.')
        name = row.get('name')
        if (not isinstance(name, str) or not name.strip() or len(name.strip()) > 80
                or any(c in '<>' or unicodedata.category(c).startswith('C') for c in name)):
            raise ValueError(f'Track {source}: use a plain participant name of 1–80 characters.')
        result[source] = {'sourceId': source, 'targetId': target, 'startFrame': start,
                          'endFrame': end, 'name': name.strip()}
    if not any(row['targetId'] is not None for row in result.values()):
        raise ValueError('Keep at least one participant before saving tracking.')
    return result


def _effective(original, people, corrections, overlap_policy='reject'):
    motion = copy.deepcopy(original)
    counts = Counter(); resolutions = []
    for frame in motion['frames']:
        groups = {}
        for detection in frame['people']:
            source = detection['id']; row = corrections[source]; target = row['targetId']
            if target is None or not row['startFrame'] <= frame['frame'] < row['endFrame']:
                continue
            groups.setdefault(target, []).append(detection)
        kept = []
        for target, candidates in groups.items():
            if len(candidates) > 1:
                if overlap_policy == 'reject':
                    raise ValueError(f'Tracks {candidates[0]["id"]} and {candidates[1]["id"]} both contain participant {target} in frame '
                                     f'{frame["frame"]}. Trim their frame ranges so they do not overlap, or explicitly confirm that the overlapping boxes show the same person.')
                # An explicit user choice enables deterministic duplicate resolution.
                # The primary identity wins; otherwise use the lowest source ID.
                selected = min(candidates, key=lambda person: (person['id'] != target, person['id']))
                resolutions.append({'frame': frame['frame'], 'targetId': target, 'selectedSourceId': selected['id'],
                                    'discardedSourceIds': sorted(person['id'] for person in candidates if person is not selected)})
            else:
                selected = candidates[0]
            selected['id'] = target
            kept.append(selected); counts[target] += 1
        frame['people'] = kept
    if not counts:
        raise ValueError('The selected ranges contain no detections. Keep at least one tracked participant.')
    metadata = {row['id']: row for row in people}
    motion['people'] = [{**metadata[identity], 'name': corrections[identity]['name']} for identity in sorted(counts)]
    return motion, resolutions


def save(admin, clip_id, raw):
    with admin.LOCK:
        if (admin.BUSY.locked() or admin.onboarding.ACTIVE
                or any(job.get('status') == 'running' for job in admin.JOBS.values())
                or any(run.get('status') == 'running' for run in admin.reconstruction.records(admin).values())):
            raise ValueError('Wait for the current preparation or reconstruction job to finish before changing tracks.')
        catalog, entry, path, root, original, people = _context(admin, clip_id)
        tracks = _tracks(original, people)
        corrections = _validate(raw, tracks, len(original['frames']))
        before = admin.digest(path)
        if raw['revision'] != before:
            raise ValueError('Tracking changed after this editor was opened. Reload tracking and apply your corrections again.')
        overlap_policy = raw.get('overlapPolicy', 'reject')
        motion, resolutions = _effective(original, people, corrections, overlap_policy)
        # Advance even when the selected detections happen to match an earlier
        # edit (including reset). A stale editor must never overwrite that edit.
        motion['trackCorrectionRevision'] = uuid.uuid4().hex
        root.mkdir(parents=True, exist_ok=True)
        source = root / 'source-motion.json'
        if not source.exists():
            # Exclusive creation guarantees that a later edit never replaces detector output.
            with source.open('xb') as output:
                output.write(path.read_bytes())
            admin.onboarding.save(root / 'source-metadata.json', {'people': people, 'createdAt': admin.now(),
                                  'motionSha256': admin.digest(source), 'sourceSha256': entry.get('sourceSha256')})
        history = root / 'history' / uuid.uuid4().hex
        history.mkdir(parents=True)
        shutil.copyfile(path, history / 'effective-motion.json')
        admin.onboarding.save(history / 'catalog-entry.json', entry)
        for key in ('scene', 'environment'):
            if entry.get(key):
                asset = _asset(admin, clip_id, entry[key])
                shutil.copyfile(asset, history / (key + '.json'))
                if key == 'environment':
                    scan = (asset.parent / _read(asset)['asset']).resolve()
                    if not scan.is_relative_to(asset.parent) or not scan.is_file():
                        raise ValueError('The room scan is missing or outside its clip folder.')
                    shutil.copyfile(scan, history / scan.name)
        state_path = admin.reconstruction.record_path(admin, clip_id)
        previous_run = _read(state_path) if state_path.exists() else None
        if previous_run:
            admin.onboarding.save(history / 'reconstruction-state.json', previous_run)
        admin.onboarding.save(path, motion)
        entry['people'] = motion['people']
        entry.pop('scene', None); entry.pop('environment', None)
        admin.onboarding.save(admin.CATALOG, catalog)
        state = admin.saved(); state['preview'] = None; admin.save_state(state)
        after = admin.digest(path)
        audit = {'clipId': clip_id, 'savedAt': admin.now(), 'beforeRevision': before, 'afterRevision': after,
                 'corrections': [corrections[identity] for identity in sorted(corrections)],
                 'overlapPolicy': overlap_policy, 'overlapsResolved': len(resolutions), 'overlapResolutions': resolutions}
        admin.onboarding.save(root / 'corrections.json', audit)
        admin.onboarding.save(history / 'audit.json', audit)
        if previous_run:
            previous_run.update(status='stale', reviewed=False, message='Participant tracks changed. Reconstruct and review this passage again.')
            previous_run.pop('reviewUrl', None); previous_run.pop('reviewedAt', None)
            admin.onboarding.save(state_path, previous_run)
        return {**get(admin, clip_id), 'message': 'Participant corrections saved. Reconstruct this passage with the selected tracks.'}

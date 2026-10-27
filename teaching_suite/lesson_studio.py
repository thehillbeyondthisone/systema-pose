"""Connect workstation lessons to their 3D scene, and keep each lesson's trim range.

A prepared lesson and its published clip share the same source video, so the
video's SHA-256 links a lesson to the catalog entry that carries its 3D scene.
"""
import json
import math
import threading
from pathlib import Path

import admin
import onboarding

_DIGESTS = {}
_LOCK = threading.Lock()
MIN_TRIM_SECONDS = 1.0


def source_digest(lesson_id):
    path = onboarding.folder(lesson_id) / 'source.mp4'
    if not path.is_file():
        return None
    stat = path.stat()
    key = (str(path), stat.st_size, stat.st_mtime_ns)
    with _LOCK:
        if key not in _DIGESTS:
            _DIGESTS[key] = admin.digest(path)
        return _DIGESTS[key]


def catalog_entry(lesson):
    """The catalog clip with a 3D scene made from this lesson's exact video."""
    if lesson.get('status') != 'ready':
        return None
    sha = source_digest(lesson['id'])
    if not sha:
        return None
    try:
        entries = admin.catalog()['lessons']
    except (OSError, ValueError, KeyError):
        return None
    for entry in entries:
        if entry.get('sourceSha256') == sha and entry.get('scene') and (admin.PROJECT / entry['scene']).is_file():
            return entry
    return None


def clip_range(lesson):
    start, end = lesson['sourceStart'], lesson['sourceEnd']
    trim_start, trim_end = lesson.get('trimStart'), lesson.get('trimEnd')
    if isinstance(trim_start, (int, float)) and isinstance(trim_end, (int, float)) and start <= trim_start < trim_end <= end:
        return trim_start, trim_end
    return start, end


def studio(lesson):
    """Lesson data for the 3D page, shaped like a published lesson.json."""
    entry = catalog_entry(lesson)
    base = f"/lesson-studio/{lesson['id']}/"
    value = {
        'id': lesson['id'], 'projectId': lesson['id'], 'title': lesson['title'],
        'category': (entry or {}).get('category', 'Training'), 'description': lesson.get('description', ''),
        'sourceStart': lesson['sourceStart'], 'sourceEnd': lesson['sourceEnd'], 'fps': lesson['fps'],
        'video': lesson['video'], 'people': lesson.get('people', []), 'lessonUrl': f"/?project={lesson['id']}",
        'scene': None, 'manifest': None, 'environment': None,
    }
    for key in ('trimStart', 'trimEnd'):
        if key in lesson:
            value[key] = lesson[key]
    if entry:
        value.update(scene=base + 'scene.json', manifest=base + 'manifest.json')
        if 'videoFrameOffset' in entry:
            value['videoFrameOffset'] = entry['videoFrameOffset']
        if entry.get('environment') and environment(lesson) is not None:
            value['environment'] = base + 'environment.json'
    return value


def scene_path(lesson):
    entry = catalog_entry(lesson)
    return admin.PROJECT / entry['scene'] if entry else None


def manifest(lesson):
    entry = catalog_entry(lesson)
    if not entry:
        return None
    people = json.loads((admin.PROJECT / entry['scene']).read_text(encoding='utf-8')).get('people', [])
    return {'sha256': entry['sourceSha256'], 'reconstruction': {'expectedParticipants': len(people)}}


def environment(lesson):
    """The clip's studio configuration, with its scan asset resolved for this server."""
    entry = catalog_entry(lesson)
    if not entry or not entry.get('environment'):
        return None
    path = (admin.PROJECT / entry['environment']).resolve()
    if not path.is_file():
        return None
    config = json.loads(path.read_text(encoding='utf-8'))
    asset = (path.parent / config.get('asset', '')).resolve()
    public = (Path(__file__).resolve().parent / 'public').resolve()
    if not asset.is_file() or not asset.is_relative_to(public):
        return None
    config['asset'] = '/' + asset.relative_to(public).as_posix()
    return config


def set_trim(lesson_id, raw):
    """Save or clear the playable range. Footage and motion files are not changed."""
    with admin.LOCK:
        lesson = onboarding.read(lesson_id)
        if lesson.get('status') != 'ready':
            raise ValueError('Finish preparing this lesson before trimming it.')
        if raw.get('clear') is True:
            lesson.pop('trimStart', None)
            lesson.pop('trimEnd', None)
        else:
            start, end = raw.get('start'), raw.get('end')
            if not all(isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) for v in (start, end)):
                raise ValueError('Enter the trim start and end in seconds.')
            frame = 1 / lesson['fps']
            start = round(max(lesson['sourceStart'], start) / frame) * frame
            end = round(min(lesson['sourceEnd'], end) / frame) * frame
            if end - start < MIN_TRIM_SECONDS:
                raise ValueError('Keep at least one second between the trim start and end.')
            if start <= lesson['sourceStart'] + frame / 2 and end >= lesson['sourceEnd'] - frame / 2:
                lesson.pop('trimStart', None)
                lesson.pop('trimEnd', None)
            else:
                lesson['trimStart'], lesson['trimEnd'] = round(start, 4), round(end, 4)
        onboarding.save(onboarding.folder(lesson_id) / 'lesson.json', lesson)
        _sync_catalog(lesson)
        return {'trimStart': lesson.get('trimStart'), 'trimEnd': lesson.get('trimEnd'),
                'message': 'Trim saved.' if 'trimStart' in lesson else 'Showing the full clip.'}


def _sync_catalog(lesson):
    """Carry the trim to catalog clips made from the same video, so a published build keeps it."""
    sha = source_digest(lesson['id'])
    if not sha:
        return
    value = admin.catalog()
    changed = False
    for entry in value['lessons']:
        if entry.get('sourceSha256') != sha:
            continue
        for key in ('trimStart', 'trimEnd'):
            if key in lesson and entry.get(key) != lesson[key]:
                entry[key] = lesson[key]
                changed = True
            elif key not in lesson and key in entry:
                entry.pop(key)
                changed = True
    if changed:
        onboarding.save(admin.CATALOG, value)
        record = admin.saved()
        if record.get('preview'):
            record['preview'] = None
            admin.save_state(record)

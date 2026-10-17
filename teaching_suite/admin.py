"""Loopback-only video preparation, reviewed clip staging and Pages publication."""
import datetime as dt
import hashlib
import ipaddress
import json
import math
import os
from pathlib import Path
import re
import secrets
import shutil
import subprocess
import sys
import threading
import uuid
from urllib.parse import urlparse

import onboarding
import reconstruction
import room_scans

WORKSPACE = Path(__file__).resolve().parent.parent
PROJECT = Path(os.environ.get('SYSTEMA_ADMIN_PROJECT_ROOT', str(WORKSPACE))).resolve()
DATA = onboarding.LESSONS.parent / 'admin'
CATALOG = PROJECT / 'site/lessons.json'
TOKEN = secrets.token_urlsafe(32)
LOCK = threading.RLock()
BUSY = threading.Lock()
JOBS = {}
SLUG = re.compile(r'^[a-z0-9]+(?:-[a-z0-9]+)*$')
MAX_ASSET = 95 * 1024 * 1024


def now():
    return dt.datetime.now(dt.timezone.utc).isoformat()


def digest(path):
    sha = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            sha.update(chunk)
    return sha.hexdigest()


def local_request(handler, write=False):
    """Ignore proxy headers: only the actual loopback peer and Host may administer."""
    try:
        peer = ipaddress.ip_address(handler.client_address[0])
        host = urlparse('http://' + handler.headers.get('Host', ''))
        local_host = host.hostname == 'localhost' or ipaddress.ip_address(host.hostname).is_loopback
        if not peer.is_loopback or not local_host or host.port != handler.server.server_port:
            return False
    except (ValueError, TypeError):
        return False
    if handler.headers.get('Sec-Fetch-Site') not in (None, 'same-origin', 'none'):
        return False
    if write:
        expected = 'http://' + handler.headers.get('Host', '')
        if handler.headers.get('Origin') != expected:
            return False
        return secrets.compare_digest(handler.headers.get('X-Systema-Admin-Token', ''), TOKEN)
    return True


def catalog():
    return json.loads(CATALOG.read_text(encoding='utf-8'))


def saved():
    path = DATA / 'state.json'
    return json.loads(path.read_text(encoding='utf-8')) if path.exists() else {'staged': [], 'preview': None}


def save_state(value):
    DATA.mkdir(parents=True, exist_ok=True)
    onboarding.save(DATA / 'state.json', value)


def delete_draft(lesson_id):
    with LOCK:
        lesson = onboarding.read(lesson_id)
        if lesson['status'] != 'draft' or lesson_id in onboarding.ACTIVE:
            raise ValueError('Only an unprocessed draft can be deleted.')
        source = onboarding.folder(lesson_id)
        target = source.resolve()
        parent = onboarding.LESSONS.resolve()
        if source.is_symlink() or target.parent != parent or target.name != lesson_id:
            raise ValueError('Invalid draft storage location.')
        shutil.rmtree(target)
        return {'message': 'Draft and its uploaded video copy deleted.', 'lessonId': lesson_id}


def state():
    with LOCK:
        record = saved()
        entries = catalog()['lessons']
        runtime = reconstruction.runtime_state(sys.modules[__name__])
        lessons = [{**{key: lesson.get(key) for key in ('id', 'title', 'status', 'message', 'progress', 'segments', 'sourceEnd', 'video', 'people')},
                    'canDelete': lesson['status'] == 'draft' and lesson['id'] not in onboarding.ACTIVE}
                   for lesson in onboarding.library()]
        return {'token': TOKEN, 'lessons': lessons, 'clips': entries, 'staged': record['staged'],
                'preview': record.get('preview'), 'jobs': [dict(value) for value in list(JOBS.values())[-10:]],
                'processingAvailable': runtime.get('videoReady',
                    (WORKSPACE / 'work/models/manifest.json').is_file() and (WORKSPACE / 'work/runtime/cv2').is_dir()),
                'threeD': runtime,
                'rooms': room_scans.library(sys.modules[__name__]),
                'reconstructions': reconstruction.records(sys.modules[__name__])}


def job(kind, action):
    if not BUSY.acquire(blocking=False):
        raise ValueError('A staging, preview or publish job is already running.')
    identity = uuid.uuid4().hex
    value = {'id': identity, 'kind': kind, 'status': 'running', 'message': 'Starting…', 'startedAt': now()}
    with LOCK:
        JOBS[identity] = value

    def run():
        try:
            result = action(identity, value) or {}
            with LOCK:
                value.update(result, status=result.pop('status', 'complete'), completedAt=now())
        except Exception as failure:
            with LOCK:
                value.update(status='failed', message=str(failure), completedAt=now())
        finally:
            BUSY.release()
    threading.Thread(target=run, daemon=True).start()
    return dict(value)


def ffmpeg(*args):
    # The same local FFmpeg runtime used for upload normalization.
    runtime = WORKSPACE / 'work/runtime'
    if str(runtime) not in sys.path:
        sys.path.insert(0, str(runtime))
    import imageio_ffmpeg
    result = subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(), '-nostdin', '-y', *map(str, args)],
                            capture_output=True, text=True, timeout=300)
    if result.returncode:
        raise ValueError('Video export failed: ' + result.stderr[-1500:])


def stage(raw):
    lesson = onboarding.read(raw['lessonId'])
    if lesson['status'] != 'ready':
        raise ValueError('Finish 2D preparation before staging passages.')
    if raw.get('reviewed') is not True:
        raise ValueError('Review the motion and approve this footage for public sharing first.')
    slug = str(raw.get('slug', ''))
    if not SLUG.fullmatch(slug) or len(slug) > 64:
        raise ValueError('Use a short lowercase clip ID with words separated by hyphens.')
    title = str(raw.get('title', '')).strip()[:120]
    category = raw.get('category')
    if not title or category not in ('Training', 'Sparring', 'Fight'):
        raise ValueError('Choose a title and footage category.')
    tags = [str(tag).strip()[:50] for tag in raw.get('tags', []) if str(tag).strip()][:12]
    description = str(raw.get('description', '')).strip()[:1000]
    segments = onboarding.passages(lesson['segments'], lesson['sourceEnd'])
    original_catalog = catalog()
    ids = [slug if len(segments) == 1 else f'{slug}-{index+1:02}' for index in range(len(segments))]
    if any(identity in {entry['id'] for entry in original_catalog['lessons']} or (PROJECT / 'site/clips' / identity).exists() for identity in ids):
        raise ValueError('That clip ID already exists. Choose a new stable ID.')
    original_hash = digest(CATALOG)

    def action(identity, progress):
        source_folder = onboarding.folder(lesson['id'])
        motion = json.loads((source_folder / 'motion.json').read_text(encoding='utf-8'))
        entries = []
        output_root = DATA / 'staging' / identity
        output_root.mkdir(parents=True)
        for index, (segment, clip_id) in enumerate(zip(segments, ids)):
            progress['message'] = f'Exporting passage {index+1} of {len(segments)}…'
            folder = output_root / clip_id
            folder.mkdir()
            start, end = math.ceil(segment['start'] * 30), math.ceil(segment['end'] * 30)
            rows = [frame for frame in motion['frames'] if start <= frame['frame'] < end]
            if len(rows) != end-start or [row['frame'] for row in rows] != list(range(start, end)):
                raise ValueError('Prepared tracking does not cover every selected frame. Generate the passages again.')
            people_ids = {person['id'] for row in rows for person in row['people']}
            people = [person for person in lesson['people'] if person['id'] in people_ids]
            if not people or any(not 1 <= person['id'] <= 100 for person in people):
                raise ValueError('Review participant tracking before publishing this passage.')
            ffmpeg('-ss', start/30, '-i', source_folder / 'source.mp4', '-t', (end-start)/30,
                   '-map', '0:v:0', '-map', '0:a:0?', '-vf', 'fps=30', '-c:v', 'libx264', '-preset', 'fast',
                   '-crf', '22', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', folder / 'source.mp4')
            if (folder / 'source.mp4').stat().st_size > MAX_ASSET:
                raise ValueError('The exported passage exceeds 95 MB. Choose shorter passages before publishing.')
            clean = {'fps': 30, 'sourceStart': start/30, 'sourceEnd': end/30, 'width': motion['width'], 'height': motion['height'],
                     'people': people, 'frames': [{**row, 'frame': row['frame']-start} for row in rows]}
            onboarding.save(folder / 'motion.json', clean)
            ffmpeg('-i', folder / 'source.mp4', '-frames:v', '1', '-vf', 'scale=640:-2', folder / 'poster.jpg')
            prefix = f'site/clips/{clip_id}/'
            entry = {'id': clip_id, 'title': title if len(segments) == 1 else title+' · '+(segment['label'] or f'Passage {index+1}'),
                     'description': description, 'category': category, 'tags': tags, 'video': prefix+'source.mp4',
                     'motion': prefix+'motion.json', 'poster': prefix+'poster.jpg', 'frameMapping': 'frame', 'people': people}
            entry['sourceSha256'] = digest(folder / 'source.mp4')
            entries.append(entry)
        with LOCK:
            if digest(CATALOG) != original_hash:
                raise ValueError('The publishing catalog changed during export. Refresh and try again.')
            for clip_id in ids:
                destination = PROJECT / 'site/clips' / clip_id
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copytree(output_root / clip_id, destination)
            original_catalog['lessons'].extend(entries)
            onboarding.save(CATALOG, original_catalog)
            record = saved();record['staged'] = sorted(set(record['staged']+ids));record['preview'] = None;save_state(record)
        return {'message': f'{len(ids)} reviewed passage(s) staged. Build a preview before publishing.', 'clips': ids}
    return job('stage', action)


def attach_scene(clip_id, scene, internal=False):
    with LOCK:
        if BUSY.locked() and not internal:
            raise ValueError('Wait for the current publishing job to finish.')
        if clip_id not in saved()['staged']:
            raise ValueError('Attach 3D to a newly staged clip before publishing.')
        value = catalog();entry = next((entry for entry in value['lessons'] if entry['id'] == clip_id), None)
        if not entry:
            raise ValueError('Unknown staged clip.')
        motion = json.loads((PROJECT / entry['motion']).read_text(encoding='utf-8'))
        expected = len(motion['frames'])
        if (scene.get('coordinateSpace') != 'world-3d' or scene.get('upAxis') != 'y' or scene.get('sourceSha256') != digest(PROJECT / entry['video'])
            or any(scene.get(key) != motion[key] for key in ('fps', 'sourceStart', 'sourceEnd')) or len(scene.get('frames', [])) != expected):
            raise ValueError('3D scene must match this exported video hash, passage timing and frame count exactly.')
        names = scene.get('jointNames', [])
        people = {person['id'] for person in entry['people']}
        if (scene.get('schemaVersion') != 1 or len(names) < 22 or len(set(names)) != len(names)
            or not {'pelvis', 'head', 'left_wrist', 'right_wrist', 'left_ankle', 'right_ankle'}.issubset(names)
            or not scene.get('people') or len(scene['people']) != len(people) or {person['id'] for person in scene['people']} != people):
            raise ValueError('Review and match the 3D participant IDs to the prepared 2D tracks.')
        if not scene.get('edges') or any(len(edge) != 2 or any(not isinstance(i, int) or not 0 <= i < len(names) for i in edge) for edge in scene['edges']):
            raise ValueError('3D scene has invalid skeleton edges.')
        for index, frame in enumerate(scene['frames']):
            if frame.get('frame', index) != index:
                raise ValueError('3D frames must be dense and indexed from zero.')
            for person in frame.get('people', []):
                if person['id'] not in people or len(person['xyz']) != len(names) or any(len(point) != 3 or any(not isinstance(v, (int, float)) or not math.isfinite(v) for v in point) for point in person['xyz']):
                    raise ValueError('3D scene contains invalid participants or joint coordinates.')
        # A new camera/room match needs its own calibration. Never reuse the pilot's.
        scene.pop('roomCalibration', None)
        scene['people'] = entry['people']
        destination = 'site/clips/'+clip_id+'/scene.json';onboarding.save(PROJECT / destination, scene);entry['scene'] = destination
        onboarding.save(CATALOG, value);record = saved();record['preview'] = None;save_state(record)
        managed = reconstruction.record_path(sys.modules[__name__], clip_id)
        if not internal and managed.exists():
            review = json.loads(managed.read_text(encoding='utf-8'))
            review.update(status='ready', reviewed=False, sceneSha256=digest(PROJECT / destination), message='Imported scene ready for 3D review.')
            review.pop('reviewUrl', None)
            onboarding.save(managed, review)
        return {'message': 'Matching 3D scene attached. Room calibration remains separate.'}


def unstage(clip_id):
    with LOCK:
        record = saved()
        if BUSY.locked() or clip_id not in record['staged'] or not SLUG.fullmatch(clip_id):
            raise ValueError('Choose an idle, newly staged clip to unstage.')
        relative = 'site/clips/'+clip_id
        if git('ls-files', '--', relative+'/').stdout:
            raise ValueError('This clip is already committed. Finish or revert that Git publication before unstaging.')
        source_path = PROJECT / relative
        source = source_path.resolve();parent = (PROJECT / 'site/clips').resolve()
        destination = (DATA / 'unstaged' / uuid.uuid4().hex / clip_id).resolve()
        if source.parent != parent or not destination.is_relative_to(DATA.resolve()) or source_path.is_symlink():
            raise ValueError('Invalid staged clip location.')
        destination.parent.mkdir(parents=True)
        if source.exists():shutil.move(str(source), str(destination))
        value = catalog();value['lessons'] = [entry for entry in value['lessons'] if entry['id'] != clip_id]
        onboarding.save(CATALOG, value);record['staged'].remove(clip_id);record['preview'] = None;save_state(record)
        reconstruction_state = reconstruction.record_path(sys.modules[__name__], clip_id)
        if reconstruction_state.exists():reconstruction_state.replace(reconstruction_state.with_name('unstaged.json'))
        return {'message': 'Clip unstaged. Exported files are preserved locally; the original video is unchanged.'}


def git(*args, check=True):
    result = subprocess.run(['git', '-C', str(PROJECT), *args], capture_output=True, text=True, timeout=120)
    if check and result.returncode:
        raise ValueError((result.stderr or result.stdout or 'Git action failed.')[-2500:])
    return result


def fingerprint():
    value = catalog();paths = {CATALOG}
    for entry in value['lessons']:
        for key in ('video', 'motion', 'poster', 'scene', 'environment'):
            if entry.get(key):
                path = (PROJECT / entry[key]).resolve()
                if not path.is_relative_to(PROJECT) or not path.is_file():
                    raise ValueError('A publishing asset is missing or outside the project.')
                paths.add(path)
                if key == 'environment':
                    config = json.loads(path.read_text(encoding='utf-8'))
                    asset = (path.parent / config['asset']).resolve()
                    if not asset.is_relative_to(PROJECT) or not asset.is_file():
                        raise ValueError('A room scan is missing or outside the project.')
                    paths.add(asset)
    sha = hashlib.sha256(git('rev-parse', 'HEAD').stdout.encode())
    for path in sorted(paths):
        sha.update(str(path.relative_to(PROJECT)).encode());sha.update(digest(path).encode())
    return sha.hexdigest()


def make_preview(identity):
    before = fingerprint();output = DATA / 'previews' / identity
    result = subprocess.run([sys.executable, str(PROJECT / 'work/build_pages.py'), '--output', str(output), '--catalog', str(CATALOG)],
                            cwd=PROJECT, capture_output=True, text=True, timeout=300)
    if result.returncode:
        raise ValueError((result.stderr or result.stdout)[-2500:])
    if before != fingerprint():
        raise ValueError('The catalog or assets changed during the build. Build a fresh preview.')
    preview = {'id': identity, 'url': f'/admin-preview/{identity}/', 'fingerprint': before, 'createdAt': now()}
    with LOCK:
        record = saved();record['preview'] = preview;save_state(record)
    return preview


def build_preview():
    def action(identity, progress):
        progress['message'] = 'Building the public viewer preview…'
        preview = make_preview(identity)
        return {'message': 'Preview ready. Review it, then publish.', 'preview': preview['url']}
    return job('preview', action)


def publish(raw):
    if raw.get('reviewed') is not True:
        raise ValueError('Review the public preview before publishing.')
    def action(identity, progress):
        record = saved();preview = record.get('preview')
        reconstruction.publish_check(sys.modules[__name__], record['staged'])
        if not record['staged'] or not preview or preview['fingerprint'] != fingerprint():
            raise ValueError('Build and review a fresh preview for the staged clips first.')
        if git('branch', '--show-current').stdout.strip() != 'main':
            raise ValueError('Publishing requires the main branch on this workstation.')
        if git('diff', '--cached', '--quiet', check=False).returncode:
            raise ValueError('Other Git changes are staged. Finish those before publishing videos.')
        allowed = {'site/lessons.json'}
        for entry in catalog()['lessons']:
            if entry['id'] not in record['staged']:
                continue
            folder = (PROJECT / 'site/clips' / entry['id']).resolve()
            for key in ('video', 'motion', 'poster', 'scene', 'environment'):
                if not entry.get(key):
                    continue
                path = (PROJECT / entry[key]).resolve()
                if not path.is_relative_to(folder) or not path.is_file() or path.stat().st_size > MAX_ASSET:
                    raise ValueError('A staged asset is invalid or exceeds the 95 MB publishing limit.')
                allowed.add(path.relative_to(PROJECT).as_posix())
                if key == 'environment':
                    config = json.loads(path.read_text(encoding='utf-8'))
                    asset = (path.parent / config['asset']).resolve()
                    if not asset.is_relative_to(folder) or not asset.is_file() or asset.suffix != '.splat' or asset.stat().st_size > MAX_ASSET:
                        raise ValueError('A room scan must be a compact .splat inside this passage, under 95 MB.')
                    allowed.add(asset.relative_to(PROJECT).as_posix())
        dirty = git('status', '--porcelain', '--untracked-files=all').stdout.splitlines()
        if any(line[3:].replace('\\', '/') not in allowed for line in dirty):
            raise ValueError('Unrelated workspace changes are present. Commit or set them aside before publishing videos.')
        progress['message'] = 'Committing reviewed clip files…'
        git('add', '--', *sorted(allowed))
        if git('diff', '--cached', '--quiet', check=False).returncode:
            git('commit', '-m', 'Publish reviewed movement clips: '+', '.join(record['staged']))
        progress['message'] = 'Pushing the reviewed clips to GitHub…'
        git('push', 'origin', 'HEAD:main')
        commit = git('rev-parse', 'HEAD').stdout.strip()
        with LOCK:
            record = saved();record['staged'] = [];record['lastPublished'] = {'commit': commit, 'at': now()};record['preview'] = None;save_state(record)
        return {'message': 'Pushed successfully. GitHub Pages is building the public update.', 'commit': commit}
    return job('publish', action)

"""Personal annotations and a local queue of student video-link requests."""
import json
import os
import uuid
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(os.environ.get('SYSTEMA_DATA_DIR', str(Path(__file__).resolve().parent / 'data')))
STUDENTS = ROOT / 'students'
REQUESTS = ROOT / 'video-requests'


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix('.tmp')
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')
    temp.replace(path)


def scope(project=None, snapshot=None):
    if project and snapshot:
        raise ValueError('Choose one lesson.')
    if project:
        if len(project) != 32 or any(c not in '0123456789abcdef' for c in project):
            raise ValueError('Unknown lesson.')
        return 'project-' + project
    if snapshot:
        if not 1 <= len(snapshot) <= 80 or any(not (c.isascii() and (c.isalnum() or c in '_-')) for c in snapshot):
            raise ValueError('Unknown lesson.')
        return 'snapshot-' + snapshot
    return 'sample'


def notes_path(student, lesson_scope):
    return STUDENTS / student / (lesson_scope + '.json')


def notes(student, lesson_scope):
    path = notes_path(student, lesson_scope)
    return json.loads(path.read_text(encoding='utf-8')) if path.exists() else []


def audio_folder(student):
    path = STUDENTS / student / 'audio'
    path.mkdir(parents=True, exist_ok=True)
    return path


def requests(student=None):
    values = [json.loads(p.read_text(encoding='utf-8')) for p in REQUESTS.glob('*.json')]
    if student:
        values = [v for v in values if v['studentId'] == student]
    return sorted(values, key=lambda v: v['createdAt'], reverse=True)


def submit(student, raw, timestamp):
    if not isinstance(raw, dict):
        raise ValueError('Enter a video link and request details.')
    name = str(raw.get('name', '')).strip()[:120]
    title = str(raw.get('title', '')).strip()[:120]
    url = str(raw.get('url', '')).strip()
    if not name:
        raise ValueError('Enter your name so your teacher knows who requested this video.')
    if not title:
        raise ValueError('Give the video request a title.')
    try:
        parsed = urlsplit(url)
        valid = (parsed.scheme in {'http', 'https'} and parsed.hostname and parsed.netloc
                 and not parsed.username and not parsed.password and parsed.port != 0)
    except ValueError:
        valid = False
    if not valid or len(url) > 2048 or any(c.isspace() or ord(c) < 32 for c in url):
        raise ValueError('Enter a complete http:// or https:// video link.')
    value = {'id': uuid.uuid4().hex, 'studentId': student, 'name': name, 'title': title,
             'url': url, 'passage': str(raw.get('passage', '')).strip()[:2000],
             'message': str(raw.get('message', '')).strip()[:4000], 'status': 'requested',
             'createdAt': timestamp, 'updatedAt': timestamp, 'lessonId': None}
    save(REQUESTS / (value['id'] + '.json'), value)
    return value

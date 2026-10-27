"""Local uploads, passage drafts, and one-at-a-time pose preparation jobs."""
import json
import math
import os
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PROJECT = ROOT.parent
LESSONS = Path(os.environ.get('SYSTEMA_DATA_DIR', str(ROOT / 'data'))) / 'lessons'
LESSONS.mkdir(parents=True, exist_ok=True)
JOB_LOCK = threading.Lock()
ACTIVE = set()
PROCESSES = {}
GPU_STOPPED = set()
MAX_UPLOAD = 500 * 1024 * 1024
MAX_SECONDS = 90


def gpu_paused():
    path = LESSONS.parent / 'admin/state.json'
    return not path.exists() or json.loads(path.read_text(encoding='utf-8')).get('gpuPaused', True)


def stop_gpu_jobs():
    stopped = 0
    for lesson_id, value in list(PROCESSES.items()):
        if value['usesGpu'] and value['process'].poll() is None:
            GPU_STOPPED.add(lesson_id)
            try:value['process'].terminate();stopped += 1
            except ProcessLookupError:pass
    return stopped


def save(path, value):
    temp = path.with_suffix('.tmp')
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')
    # Windows file readers and OneDrive can briefly hold the destination open.
    # Retry the atomic rename only; keep the original error if the lock persists.
    for attempt in range(5):
        try:
            os.replace(temp, path)
            break
        except PermissionError:
            if attempt == 4:raise
            time.sleep(.05)


def folder(lesson_id):
    if not isinstance(lesson_id, str) or len(lesson_id) != 32 or any(c not in '0123456789abcdef' for c in lesson_id):
        raise ValueError('Unknown lesson.')
    dest = LESSONS / lesson_id
    if not (dest / 'lesson.json').is_file():
        raise ValueError('Unknown lesson.')
    return dest


def read(lesson_id):
    return json.loads((folder(lesson_id) / 'lesson.json').read_text(encoding='utf-8'))


def library():
    return sorted([json.loads(p.read_text(encoding='utf-8')) for p in LESSONS.glob('*/lesson.json')],
                  key=lambda v: v['updatedAt'], reverse=True)


def worker_command(*args):
    return [sys.executable, str(ROOT / 'prepare_motion.py'), *map(str, args)]


def upload(stream, size, name, timestamp):
    extension = Path(name).suffix.lower()
    if extension not in {'.mp4', '.mov', '.m4v', '.webm'}:
        raise ValueError('Choose an MP4, MOV, M4V or WebM video.')
    if not 0 < size <= MAX_UPLOAD:
        raise ValueError('Choose a video under 500 MB.')
    lesson_id = uuid.uuid4().hex
    dest = LESSONS / lesson_id
    dest.mkdir()
    original = dest / ('original' + extension)
    try:
        with original.open('wb') as output:
            remaining = size
            while remaining:
                chunk = stream.read(min(1024 * 1024, remaining))
                if not chunk:
                    raise ValueError('Upload interrupted. Choose the video again.')
                output.write(chunk)
                remaining -= len(chunk)
        result = subprocess.run(worker_command('--prepare', original, dest), capture_output=True, text=True, timeout=600)
        if result.returncode:
            (dest / 'prepare.log').write_text(result.stderr, encoding='utf-8')
            raise ValueError('This video could not be prepared. Try an MP4 video; check the local video runtime if it persists.')
        meta = json.loads((dest / 'video.json').read_text(encoding='utf-8'))
        lesson = {'schemaVersion': 2, 'id': lesson_id, 'title': Path(name).stem[:120] or 'Untitled lesson',
                  'description': 'Explore the selected passages and add teaching notes.', 'updatedAt': timestamp,
                  'originalName': name[:240], 'video': f'/lessons/{lesson_id}/source.mp4',
                  'motion': f'/lessons/{lesson_id}/motion.json', 'sourceStart': 0, 'sourceEnd': meta['duration'],
                  'width': meta['width'], 'height': meta['height'], 'fps': meta['fps'],
                  'segments': [], 'notes': [], 'people': [], 'status': 'draft', 'progress': 0,
                  'message': 'Choose the passages to generate.'}
        save(dest / 'lesson.json', lesson)
        return lesson
    except Exception:
        # Incomplete uploads never enter the library. Keep diagnostic logs only.
        for p in dest.iterdir():
            if p.suffix != '.log' and p.is_file():
                p.unlink()
        raise


def passages(raw, duration):
    if not isinstance(raw, list) or not 1 <= len(raw) <= 12:
        raise ValueError('Mark between 1 and 12 passages.')
    result = []
    for entry in raw:
        if not isinstance(entry, dict):
            raise ValueError('Invalid passage.')
        start, end = float(entry['start']), float(entry['end'])
        if not (math.isfinite(start) and math.isfinite(end) and 0 <= start < end <= duration):
            raise ValueError('Each passage must end after its start and stay inside the video.')
        if end - start < 1 / 30:
            raise ValueError('Each passage must contain at least one frame.')
        result.append({'start': start, 'end': end, 'label': str(entry.get('label', '')).strip()[:80]})
    result.sort(key=lambda v: v['start'])
    if any(a['end'] > b['start'] for a, b in zip(result, result[1:])):
        raise ValueError('Passages overlap. Adjust their times or combine them.')
    if sum(v['end'] - v['start'] for v in result) > MAX_SECONDS:
        raise ValueError('Select up to 90 seconds total for this local prototype.')
    return result


def draft(lesson_id, raw, timestamp):
    lesson = read(lesson_id)
    if lesson['status'] in {'queued', 'processing', 'ready'}:
        raise ValueError('These passages are locked after generation starts. Upload a new lesson for different passages.')
    title = str(raw.get('title', '')).strip()[:120]
    if not title:
        raise ValueError('Give the lesson a title.')
    lesson.update(title=title, segments=passages(raw.get('segments'), lesson['sourceEnd']), updatedAt=timestamp,
                  status='draft', message='Passages saved. Ready to generate skeletons.', progress=0)
    save(folder(lesson_id) / 'lesson.json', lesson)
    return lesson


def run_job(lesson_id):
    dest = folder(lesson_id)
    try:
        with JOB_LOCK:
            with (dest / 'generation.log').open('w', encoding='utf-8') as log:
                uses_gpu = not gpu_paused()
                provider = 'DmlExecutionProvider' if uses_gpu else 'CPUExecutionProvider'
                process = subprocess.Popen(worker_command('--generate', dest, '--execution-provider', provider), stdout=log, stderr=log,
                                           creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
                PROCESSES[lesson_id] = {'process': process, 'usesGpu': uses_gpu}
                deadline = time.monotonic() + 3600
                try:
                    while True:
                        try:code = process.wait(timeout=1);break
                        except subprocess.TimeoutExpired:
                            if uses_gpu and gpu_paused():GPU_STOPPED.add(lesson_id);process.terminate()
                            if time.monotonic() > deadline:
                                process.kill();process.wait();raise RuntimeError('2D preparation timed out. Retry a shorter passage.')
                finally:PROCESSES.pop(lesson_id, None)
            if lesson_id in GPU_STOPPED:
                raise RuntimeError('Preparation stopped to free the GPU. Your video is saved; retry to prepare on the CPU.')
            if code:
                raise RuntimeError('Skeleton generation stopped. Your video and passages are saved. Retry generation; details are in the local generation log.')
    except Exception as failure:
        lesson = read(lesson_id)
        lesson.update(status='failed', message=str(failure), progress=0)
        save(dest / 'lesson.json', lesson)
    finally:
        ACTIVE.discard(lesson_id)
        GPU_STOPPED.discard(lesson_id)


def generate(lesson_id):
    lesson = read(lesson_id)
    if lesson['status'] in {'queued', 'processing', 'ready'}:
        return lesson
    passages(lesson['segments'], lesson['sourceEnd'])
    lesson.update(status='queued', message='Waiting for the local skeleton worker.', progress=0)
    save(folder(lesson_id) / 'lesson.json', lesson)
    ACTIVE.add(lesson_id)
    threading.Thread(target=run_job, args=(lesson_id,), daemon=True).start()
    return lesson


def recover():
    for lesson in library():
        if lesson['status'] in {'queued', 'processing'}:
            lesson.update(status='failed', message='Preparation was interrupted when the server stopped. Retry to continue.', progress=0)
            save(folder(lesson['id']) / 'lesson.json', lesson)

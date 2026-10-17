"""Local dashboard bridge to the existing dedicated WSL/CUDA reconstruction runtime."""
import json
import os
from pathlib import Path, PureWindowsPath
import shutil
import subprocess
import sys
import threading
import time

DISTRO = os.environ.get('SYSTEMA_3D_DISTRO', 'Systema3D')
PYTHON = '/opt/systema3d/env/bin/python'
REPO = '/opt/systema3d/PromptHMR'
TORCH_HOME = '/mnt/d/systema_pose_3d_assets/torch'
CANCEL = {}


def linux_path(path):
    value = PureWindowsPath(str(path))
    if len(value.drive) != 2 or value.drive[1] != ':':
        raise ValueError('3D preparation needs a local Windows drive accessible to WSL.')
    return '/mnt/' + value.drive[0].lower() + '/' + '/'.join(value.parts[1:])


def command(admin, script, *args):
    return ['wsl', '-d', DISTRO, '-u', 'root', '--exec', 'env', 'PYTHONUNBUFFERED=1',
            'TORCH_HOME=' + TORCH_HOME, 'SYSTEMA_PHMR_REPO=' + REPO,
            PYTHON, linux_path(admin.WORKSPACE / 'work' / script), *map(str, args)]


def storage(admin):
    checks = []
    for label, path, reserve in [('Project drive', admin.PROJECT, 8), ('GPU runtime drive', Path('D:/'), 8)]:
        try:
            free = shutil.disk_usage(path).free / 2**30
            checks.append({'name': label, 'ok': free >= reserve, 'detail': f'{free:.1f} GiB free · {reserve} GiB reserve'})
        except OSError:
            checks.append({'name': label, 'ok': False, 'detail': f'{path} is unavailable'})
    return checks


def runtime_state(admin):
    path = admin.DATA / 'requirements.json'
    report = json.loads(path.read_text(encoding='utf-8')) if path.exists() else {'status': 'unchecked', 'checks': []}
    report['storage'] = storage(admin)
    report['gpuPaused'] = admin.onboarding.gpu_paused()
    report['ready'] = not report['gpuPaused'] and report.get('gpuValidated', False) and report['status'] == 'ready' and all(c['ok'] for c in report['storage'])
    return report


def check(admin, progress, use_gpu=False):
    admin.DATA.mkdir(parents=True, exist_ok=True)
    destination = admin.DATA / 'runtime-details.json'
    report = {'status': 'checking', 'checks': [], 'checkedAt': admin.now()}
    admin.onboarding.save(admin.DATA / 'requirements.json', report)
    progress['message'] = 'Checking installed video tools, tracking models and 3D dependencies…'
    try:
        video = subprocess.run([sys.executable, str(admin.WORKSPACE / 'teaching_suite/prepare_motion.py'), '--check'],
                               capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=60,
                               creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        video_check = json.loads(video.stdout.strip().splitlines()[-1])
        report['videoReady'] = video.returncode == 0 and video_check['ready']
        video_detail = video_check['detail']
    except Exception as error:
        report['videoReady'] = False;video_detail = str(error)
    try:
        if destination.exists():destination.unlink()
        if not shutil.which('wsl'):raise ValueError('WSL is missing. Install WSL and restore the dedicated Systema3D runtime.')
        mode = ['--use-gpu', '--pause-file', linux_path(admin.DATA / 'state.json')] if use_gpu else ['--inventory-only']
        result = subprocess.run(command(admin, 'check_3d_runtime.py', '--repo', REPO, '--output', linux_path(destination), *mode),
                                capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=180,
                                creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        if not destination.is_file():
            raise ValueError('The Systema3D Python runtime did not start. ' + (result.stderr or result.stdout)[-1500:])
        details = json.loads(destination.read_text(encoding='utf-8'))
        errors = details.get('errors', [])
        if result.returncode and not errors:errors.append('Runtime validation exited unsuccessfully. Run the check again.')
        report.update(status='missing' if errors else ('ready' if use_gpu else 'installed'), gpu=details.get('gpu'), cuda=details.get('cuda'),
                      gpuValidated=use_gpu and not errors,
                      checks=[{'name': 'WSL runtime', 'ok': True, 'detail': DISTRO},
                              {'name': 'GPU & CUDA', 'ok': bool(details.get('cudaOperations')) if use_gpu else None, 'detail': details.get('gpu', 'Validation deferred · GPU untouched')},
                              {'name': 'Python dependencies', 'ok': len(details.get('imports', {})) == 16,
                               'detail': f"{len(details.get('imports', {}))}/16 inference libraries " + ('imported' if use_gpu else 'installed')},
                              {'name': 'Model files', 'ok': all(a['present'] for a in details.get('assets', [])),
                               'detail': f"{sum(a['present'] for a in details.get('assets', []))}/{len(details.get('assets', []))} files present"},
                              {'name': 'Body-model GPU test', 'ok': bool(details.get('smplForward') and details.get('smplxForward')) if use_gpu else None,
                               'detail': 'SMPL and SMPL-X forward passes' if use_gpu else 'Deferred until GPU is enabled'}], errors=errors)
    except Exception as error:
        report.update(status='missing', errors=[str(error)])
    report['checks'].insert(0, {'name': 'Video & 2D tracking', 'ok': report['videoReady'], 'detail': video_detail})
    if not report['videoReady']:
        report['status'] = 'missing';report.setdefault('errors', []).append('Video / 2D tracking: ' + video_detail)
    report.update(checkedAt=admin.now(), storage=storage(admin))
    if any(not c['ok'] for c in report['storage']):report['status'] = 'missing'
    admin.onboarding.save(admin.DATA / 'requirements.json', report)
    return report


def requirements(admin, use_gpu=False):
    def action(identity, progress):
        if use_gpu:
            with admin.LOCK:
                record = admin.saved();record['gpuPaused'] = False;admin.save_state(record)
        report = check(admin, progress, use_gpu=use_gpu)
        return {'message': '3D workstation is ready.' if report['status'] == 'ready' else 'Installed requirements checked without GPU use.' if report['status'] == 'installed' else 'Setup needs attention. See the workstation checks.',
                'status': 'complete' if report['status'] in ('ready', 'installed') else 'failed'}
    return admin.job('requirements', action)


def pause_gpu(admin):
    with admin.LOCK:
        record = admin.saved();record['gpuPaused'] = True;admin.save_state(record)
    for event in list(CANCEL.values()):event.set()
    stopped = admin.onboarding.stop_gpu_jobs()
    return {'message': 'GPU use paused. New 2D preparation uses the CPU; GPU jobs are stopping. Your videos are preserved.', 'stopped2dJobs': stopped}


def records(admin):
    result = {}
    for path in (admin.DATA / 'reconstruction').glob('*/state.json'):
        value = json.loads(path.read_text(encoding='utf-8'))
        if value.get('status') == 'running':
            update = path.parent / value['runId'] / 'progress.json'
            try:value['message'] = json.loads(update.read_text(encoding='utf-8'))['message']
            except (OSError, ValueError):pass
        result[value['clipId']] = value
    return result


def record_path(admin, clip_id):
    if not admin.SLUG.fullmatch(clip_id):raise ValueError('Unknown clip.')
    return admin.DATA / 'reconstruction' / clip_id / 'state.json'


def cancel(admin, clip_id):
    event = CANCEL.get(clip_id)
    if event is None:raise ValueError('This clip has no active reconstruction.')
    event.set()
    return {'message': 'Stopping this reconstruction. The source and previous results will be preserved.'}


def stop(admin, output, force=False):
    if (output / 'process.json').exists():
        args = ['--output', linux_path(output), '--repo', REPO, '--cancel']
        if force:args.append('--force')
        subprocess.run(command(admin, 'dashboard_3d_worker.py', *args),
                       capture_output=True, timeout=20, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))


def reconstruct(admin, clip_id, raw):
    if admin.onboarding.gpu_paused():raise ValueError('GPU use is paused. Enable and check the GPU when it is available.')
    if clip_id not in admin.saved()['staged']:raise ValueError('Prepare a reviewed passage before reconstructing it.')
    if not runtime_state(admin)['ready']:raise ValueError('Run the workstation check and resolve the missing requirements first.')
    camera = raw.get('camera', 'moving')
    if camera not in ('moving', 'static'):raise ValueError('Choose moving or fixed camera.')
    entry = next(e for e in admin.catalog()['lessons'] if e['id'] == clip_id)
    motion = json.loads((admin.PROJECT / entry['motion']).read_text(encoding='utf-8'))
    if len(motion['frames']) < 30:raise ValueError('Choose at least one second for 3D reconstruction.')
    if any(sum(p['id'] == person['id'] for frame in motion['frames'] for p in frame['people']) < 2 for person in entry['people']):
        raise ValueError('Each participant needs at least two tracked frames. Review the 2D tracking first.')
    event = threading.Event()

    def action(identity, progress):
        path = record_path(admin, clip_id);path.parent.mkdir(parents=True, exist_ok=True)
        output = path.parent / identity;output.mkdir()
        value = {'clipId': clip_id, 'runId': identity, 'status': 'running', 'message': 'Checking the workstation…',
                 'startedAt': admin.now(), 'camera': camera, 'reviewed': False}
        admin.onboarding.save(path, value);CANCEL[clip_id] = event
        def finish(status, message):
            value.update(status=status, message=message, completedAt=admin.now())
            admin.onboarding.save(path, value)
            return {'message': message, 'status': 'complete' if status == 'ready' else status}
        process = None;reader = None
        try:
            # Check actual dependencies again for every run; old success isn't proof the GPU is still available.
            if admin.onboarding.gpu_paused():return finish('cancelled', 'GPU use is paused.')
            if check(admin, progress, use_gpu=True)['status'] != 'ready':raise ValueError('Workstation check failed. Resolve the reported requirements and retry.')
            if event.is_set():return finish('cancelled', 'Reconstruction cancelled.')
            if admin.onboarding.ACTIVE:raise ValueError('Wait for 2D preparation to finish before starting 3D.')
            with admin.onboarding.JOB_LOCK:
                source = admin.PROJECT / entry['video'];source_hash = admin.digest(source)
                if source_hash != entry['sourceSha256']:raise ValueError('The staged video changed. Prepare it again.')
                shutil.copyfile(source, output / 'source.mp4')
                admin.onboarding.save(output / 'motion.json', motion)
                admin.onboarding.save(output / 'manifest.json', {'input': 'source.mp4', 'sha256': source_hash,
                    'fps': motion['fps'], 'frames': len(motion['frames']), 'sourceStart': motion['sourceStart'],
                    'sourceEnd': motion['sourceEnd'], 'participants': {str(p['id']): p['name'] for p in entry['people']},
                    'reconstruction': {'method': 'PromptHMR world-video', 'hasRun': False}})
                worker = command(admin, 'dashboard_3d_worker.py', '--output', linux_path(output), '--repo', REPO)
                worker.extend(['--pause-file', linux_path(admin.DATA / 'state.json')])
                if camera == 'static':worker.append('--static-camera')
                process = subprocess.Popen(worker, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                           text=True, encoding='utf-8', errors='replace',
                                           creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
                def capture():
                    with (output / 'inference.log').open('w', encoding='utf-8') as log:
                        for line in process.stdout:log.write(line);log.flush()
                reader = threading.Thread(target=capture, daemon=True);reader.start()
                started = time.monotonic()
                while process.poll() is None:
                    if admin.onboarding.gpu_paused():event.set()
                    if event.wait(1):
                        stop(admin, output)
                        try:process.wait(timeout=15)
                        except subprocess.TimeoutExpired:stop(admin, output, force=True);process.wait(timeout=15)
                        reader.join(timeout=5)
                        return finish('cancelled', 'Reconstruction cancelled. You can retry this passage.')
                    if any(not c['ok'] for c in storage(admin)):
                        raise ValueError('Stopped to preserve the 8 GiB free-space reserve.')
                    if time.monotonic() - started > 4*3600:raise ValueError('Reconstruction exceeded four hours. Retry a shorter passage.')
                    try:
                        message = json.loads((output / 'progress.json').read_text())['message']
                        progress['message'] = message
                        if value['message'] != message:
                            value['message'] = message
                            admin.onboarding.save(path, value)
                    except (OSError, ValueError):pass
                reader.join(timeout=5)
                if process.returncode:
                    raise ValueError('3D reconstruction stopped. Your video is saved; review the local run log and retry.')
                scene = json.loads((output / 'scene.json').read_text(encoding='utf-8'))
                if event.is_set():return finish('cancelled', 'Reconstruction cancelled.')
                if admin.digest(source) != source_hash:raise ValueError('The input video changed during reconstruction.')
                admin.attach_scene(clip_id, scene, internal=True)
                value['sceneSha256'] = admin.digest(admin.PROJECT / 'site/clips' / clip_id / 'scene.json')
                progress['message'] = 'Building the synchronized 3D review…'
                preview = admin.make_preview(identity)
                value['reviewUrl'] = preview['url'] + 'scene.html?clip=' + clip_id
                return finish('ready', '3D scene ready. Review the source, side and overhead views before publishing.')
        except Exception as error:
            if process and process.poll() is None:
                stop(admin, output)
                try:process.wait(timeout=30)
                except subprocess.TimeoutExpired:
                    stop(admin, output, force=True)
                    try:process.wait(timeout=15)
                    except subprocess.TimeoutExpired:process.terminate()
            finish('failed', str(error))
            raise
        finally:
            if reader:reader.join(timeout=5)
            CANCEL.pop(clip_id, None)

    return admin.job('reconstruct', action)


def approve(admin, clip_id, raw):
    path = record_path(admin, clip_id)
    if not path.exists():raise ValueError('No reconstructed scene is ready for this clip.')
    value = json.loads(path.read_text(encoding='utf-8'))
    scene = admin.PROJECT / 'site/clips' / clip_id / 'scene.json'
    if admin.BUSY.locked() or value['status'] != 'ready' or raw.get('reviewed') is not True or raw.get('runId') != value['runId']:
        raise ValueError('Review the finished 3D run before approving it.')
    if value['sceneSha256'] != admin.digest(scene):raise ValueError('This scene changed. Reconstruct and review it again.')
    value.update(reviewed=True, reviewedAt=admin.now())
    admin.onboarding.save(path, value)
    return {'message': '3D review saved. Build and check the final public preview, then publish.'}


def publish_check(admin, staged):
    for clip_id, value in records(admin).items():
        if clip_id not in staged:continue
        if value['status'] != 'ready' or not value.get('reviewed'):
            raise ValueError('Finish and review the 3D reconstruction for ' + clip_id + ' before publishing.')
        if admin.digest(admin.PROJECT / 'site/clips' / clip_id / 'scene.json') != value['sceneSha256']:
            raise ValueError('The reviewed 3D scene changed. Reconstruct and review it again.')


def log(admin, clip_id):
    record = record_path(admin, clip_id)
    if not record.exists():raise ValueError('No reconstruction log exists for this clip.')
    value = json.loads(record.read_text(encoding='utf-8'))
    path = record_path(admin, clip_id).parent / value['runId'] / 'inference.log'
    if not path.exists():return {'text': 'Workstation checks are running; inference has not started.'}
    with path.open('rb') as stream:
        stream.seek(max(0, path.stat().st_size - 24000))
        return {'text': stream.read().decode('utf-8', errors='replace')}


def recover(admin):
    for clip_id, value in records(admin).items():
        if value['status'] != 'running':continue
        try:stop(admin, record_path(admin, clip_id).parent / value['runId'])
        except Exception:pass
        value.update(status='failed', message='The dashboard restarted. The interrupted run is preserved; retry this passage.')
        admin.onboarding.save(record_path(admin, clip_id), value)

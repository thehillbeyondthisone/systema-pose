"""Run real upload → 2D → GPU reconstruction → browser review → isolated Git publication."""
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import time
import urllib.request
import uuid
import argparse

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument('--resume', help='Resume browser review of an already reconstructed isolated test run')
parser.add_argument('--retry', action='store_true', help='Repeat inference on the same isolated staged passage')
parser.add_argument('--allow-gpu', action='store_true', help='Required: authorizes real CUDA validation and reconstruction')
args = parser.parse_args()
if not args.allow_gpu:raise SystemExit('GPU testing is deferred. Pass --allow-gpu only when the GPU is available.')
if args.resume and (len(args.resume) != 32 or any(c not in '0123456789abcdef' for c in args.resume)):
    raise SystemExit('Resume requires an isolated run ID.')
OUT = ROOT / 'outputs/dashboard-3d' / (args.resume or uuid.uuid4().hex)
PROJECT = OUT / 'project'
if not args.resume:
    (PROJECT / 'site').mkdir(parents=True)
    (PROJECT / 'work').mkdir()
    (PROJECT / 'teaching_suite').mkdir()
    shutil.copytree(ROOT / 'teaching_suite/public', PROJECT / 'teaching_suite/public', copy_function=os.link)
    shutil.copyfile(ROOT / 'work/build_pages.py', PROJECT / 'work/build_pages.py')
    (PROJECT / 'site/lessons.json').write_text(json.dumps({'title': 'GPU dashboard verification', 'lessons': []}))
    (PROJECT / '.gitignore').write_text('/teaching_suite/public/\n')

def git(*args, cwd=PROJECT):
    return subprocess.check_output(['git', '-C', str(cwd), *args], stderr=subprocess.STDOUT, text=True).strip()

if not args.resume:
    subprocess.run(['git', 'init', '--bare', str(OUT / 'remote.git')], check=True, capture_output=True)
    git('init', '-b', 'main');git('config', 'user.name', 'GPU dashboard verification');git('config', 'user.email', 'test@example.invalid')
    git('add', '.');git('commit', '-m', 'Isolated verification baseline');git('remote', 'add', 'origin', str(OUT / 'remote.git'));git('push', '-u', 'origin', 'main')
with socket.socket() as probe:
    probe.bind(('127.0.0.1', 0));port = probe.getsockname()[1]
base = f'http://127.0.0.1:{port}'
environment = {**os.environ, 'SYSTEMA_DATA_DIR': str(OUT / 'private-data'), 'SYSTEMA_ADMIN_PROJECT_ROOT': str(PROJECT),
               'SYSTEMA_ADMIN_TEST_URL': base, 'SYSTEMA_ADMIN_TEST_OUTPUT': str(OUT), 'SYSTEMA_ADMIN_TEST_PROJECT': str(PROJECT)}
environment['SYSTEMA_ADMIN_ALLOW_GPU'] = '1'
if args.resume:environment['SYSTEMA_ADMIN_RESUME'] = '1'
if args.retry:environment['SYSTEMA_ADMIN_RETRY'] = '1'
log = (OUT / 'server.log').open('w')
server = subprocess.Popen([sys.executable, str(ROOT / 'teaching_suite/server.py'), '--port', str(port)], cwd=ROOT,
                          env=environment, stdout=log, stderr=log, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
(ROOT / 'outputs/dashboard-3d/latest.json').write_text(json.dumps({'directory': str(OUT), 'base': base, 'status': 'running'}))
try:
    for _ in range(150):
        try:
            with urllib.request.urlopen(base + '/api/admin/state', timeout=2) as response:
                if response.status == 200:break
        except OSError:time.sleep(.1)
    else:raise AssertionError('Test dashboard did not start')
    print('Isolated GPU dashboard test: ' + str(OUT), flush=True)
    subprocess.run(['node', str(ROOT / 'work/verify_dashboard_3d.cjs')], cwd=ROOT, env=environment, check=True)
    published = git('ls-tree', '-r', '--name-only', 'main', cwd=OUT / 'remote.git').splitlines()
    assert 'site/clips/gpu-dashboard-test/scene.json' in published
    assert not any('private-data' in p or p.endswith('.log') or 'original' in p or 'reconstruction' in p for p in published)
    print('PASS Real 3D publication contains only reviewed clip assets; reconstruction intermediates remain private', flush=True)
    (ROOT / 'outputs/dashboard-3d/latest.json').write_text(json.dumps({'directory': str(OUT), 'base': base, 'status': 'passed', 'publishedFiles': published}, indent=2))
finally:
    # If a browser assertion interrupts inference, stop only this isolated run first.
    cleanup = "import sys;sys.path.insert(0,'teaching_suite');import admin;admin.reconstruction.recover(admin)"
    subprocess.run([sys.executable, '-c', cleanup], cwd=ROOT, env=environment, timeout=80)
    server.terminate();server.wait(timeout=20);log.close()

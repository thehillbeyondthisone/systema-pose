"""Exercise local admin with real media/2D processing and an isolated bare Git remote."""
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid

ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'outputs/video-admin'/uuid.uuid4().hex
PROJECT=OUT/'project'
PROJECT.mkdir(parents=True)
(PROJECT/'site').mkdir();(PROJECT/'work').mkdir();(PROJECT/'teaching_suite').mkdir()
shutil.copytree(ROOT/'teaching_suite/public',PROJECT/'teaching_suite/public',copy_function=os.link)
shutil.copyfile(ROOT/'work/build_pages.py',PROJECT/'work/build_pages.py')
(PROJECT/'site/lessons.json').write_text(json.dumps({'title':'Isolated admin verification','lessons':[]}))
(PROJECT/'.gitignore').write_text('/teaching_suite/public/\n')
def git(*args,cwd=PROJECT):
    return subprocess.check_output(['git','-C',str(cwd),*args],stderr=subprocess.STDOUT,text=True).strip()
subprocess.run(['git','init','--bare',str(OUT/'remote.git')],check=True,capture_output=True)
git('init','-b','main');git('config','user.name','Admin verification');git('config','user.email','local-test@example.invalid')
git('add','.');git('commit','-m','Isolated verification baseline');git('remote','add','origin',str(OUT/'remote.git'));git('push','-u','origin','main')
with socket.socket() as probe:
    probe.bind(('127.0.0.1',0));port=probe.getsockname()[1]
base=f'http://127.0.0.1:{port}'
environment={**os.environ,'SYSTEMA_DATA_DIR':str(OUT/'private-data'),'SYSTEMA_ADMIN_PROJECT_ROOT':str(PROJECT)}
log=(OUT/'server.log').open('w')
server=subprocess.Popen([sys.executable,str(ROOT/'teaching_suite/server.py'),'--port',str(port)],cwd=ROOT,env=environment,stdout=log,stderr=log,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
def request(path,body=None,headers=None):
    req=urllib.request.Request(base+path,data=None if body is None else json.dumps(body).encode(),headers=headers or {})
    try:
        with urllib.request.urlopen(req,timeout=10) as response:return response.status,json.load(response)
    except urllib.error.HTTPError as error:return error.code,json.load(error)
try:
    for _ in range(150):
        try:
            status,state=request('/api/admin/state')
            if status==200:break
        except OSError:time.sleep(.1)
    else:raise AssertionError('Local admin did not start')
    token=state['token'];headers={'Content-Type':'application/json','Origin':base,'X-Systema-Admin-Token':token}
    assert request('/api/admin/preview',{}, {'Content-Type':'application/json'})[0]==403
    assert request('/api/admin/preview',{}, {**headers,'Origin':'https://other.example'})[0]==403
    assert request('/api/admin/preview',{}, {**headers,'X-Systema-Admin-Token':'incorrect'})[0]==403
    assert request('/api/admin/state',headers={'Host':'other.example:'+str(port)})[0]==403
    print('PASS Local admin rejects missing token, cross-origin writes and non-loopback Host names',flush=True)
    environment.update(SYSTEMA_ADMIN_TEST_URL=base,SYSTEMA_ADMIN_TEST_PROJECT=str(PROJECT),SYSTEMA_ADMIN_TEST_OUTPUT=str(OUT),SYSTEMA_ADMIN_TEST_REMOTE=str(OUT/'remote.git'))
    subprocess.run(['node',str(ROOT/'work/verify_video_admin.cjs')],cwd=ROOT,env=environment,check=True)
    privacy="""import json,sys;sys.path.insert(0,'teaching_suite');import server,admin,onboarding
from types import SimpleNamespace
handler=object.__new__(server.Handler);handler.client_address=('192.168.1.40',1);handler.headers={'Host':'127.0.0.1:8771'};handler.server=SimpleNamespace(server_port=8771)
assert not admin.local_request(handler)
identity=onboarding.library()[0]['id']
try:handler.read_project(identity)
except ValueError:pass
else:raise AssertionError('Private admin footage is exposed to LAN requests')
print('PASS Original admin sources are inaccessible to LAN lesson requests')
"""
    subprocess.run([sys.executable,'-c',privacy],cwd=ROOT,env=environment,check=True)
    assert git('rev-list','--count','main',cwd=OUT/'remote.git')=='2'
    published=git('ls-tree','-r','--name-only','main',cwd=OUT/'remote.git').splitlines()
    assert not any('original' in path or 'private-data' in path or 'annotations' in path for path in published)
    assert 'site/clips/admin-review-test/source.mp4' in published
    print('PASS Isolated publisher commits only reviewed assets and catalog; original video and private data stay local',flush=True)
    (ROOT/'outputs/video-admin/latest.json').write_text(json.dumps({'directory':str(OUT),'base':base,'checks':'passed','publishedFiles':published},indent=2))
finally:
    server.terminate();server.wait(timeout=20);log.close()

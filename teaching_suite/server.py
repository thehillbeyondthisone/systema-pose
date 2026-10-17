"""Student movement workspace with personal annotations and video-link requests."""
import argparse
import datetime as dt
import json
import os
import re
import socket
import subprocess
import sys
import threading
import uuid
from http.cookies import SimpleCookie
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs, unquote
import onboarding
import student_data
import admin

ROOT = Path(__file__).resolve().parent
PROJECT = ROOT.parent
DATA = Path(os.environ.get('SYSTEMA_DATA_DIR', str(ROOT / 'data')))
PUBLIC = ROOT / 'public'
PUBLISHED = ROOT / 'published'
for p in [DATA, PUBLIC, PUBLISHED]:p.mkdir(parents=True, exist_ok=True)
LOCK = threading.Lock()
ID = re.compile(r'^[a-zA-Z0-9_-]{1,80}$')

def lan_address():
    """Return the preferred LAN address without sending any network traffic."""
    probe=socket.socket(socket.AF_INET,socket.SOCK_DGRAM)
    try:
        probe.connect(('192.0.2.1',80))
        return probe.getsockname()[0]
    except OSError:
        return None
    finally:
        probe.close()

def now():return dt.datetime.now(dt.timezone.utc).isoformat()

def write_json(path, value):
    temp=path.with_suffix('.tmp')
    temp.write_text(json.dumps(value,ensure_ascii=False,indent=2),encoding='utf-8')
    os.replace(temp,path)

def initialize():
    studio_source=Path(os.environ.get('SYSTEMA_STUDIO_PLY',str(PROJECT/'Martial Arts Studio - Best Reviewed.ply')))
    if studio_source.is_file() and not (PUBLIC/'studio/studio.splat').is_file():
        print('Preparing the studio Gaussian scan for the viewer...',flush=True)
        try:
            subprocess.run([sys.executable,str(PROJECT/'work/prepare_studio.py'),'--source',str(studio_source)],check=True)
        except subprocess.CalledProcessError:
            print('Studio preparation failed. The motion viewer remains available.',flush=True)
    if not (PUBLIC/'motion.json').exists():
        rows=[json.loads(line) for line in (PROJECT/'outputs/pilot/poses-tracked.jsonl').read_text(encoding='utf-8').splitlines()]
        frames=[{'frame':r['source_frame_index'],'people':[{'id':p['track_id'],'xy':p['keypoints_xy'][:23],
                 'confidence':p['confidence'][:23],'bbox':p['bbox_xyxy'],'status':p['track_status']}
                 for p in r['people'] if p['track_id']]} for r in rows]
        write_json(PUBLIC/'motion.json',{'fps':30,'sourceStart':18,'sourceEnd':30,'width':1920,'height':1080,'frames':frames})
    if not (DATA/'lesson.json').exists():
        write_json(DATA/'lesson.json',{'schemaVersion':1,'id':'multiple-attackers-pilot','title':'Multiple attackers',
            'description':'Explore a short exchange. Open a note, replay its moment, and compare the movement with the footage.',
            'updatedAt':now(),'notes':[
                {'id':'sample-intro','title':'Watch the exchange first','text':'Sample prompt: Watch the exchange once at normal speed. What movement would you like the instructor to explain?',
                 'start':18.0,'end':20.5,'trackId':0,'jointIndex':None,'anchor':{'x':.50,'y':.34},'audio':None,'sample':True},
                {'id':'sample-hands','title':'A place for a hand explanation','text':'Sample prompt: Add a text explanation to this hand and this moment. The marker follows the joint estimate when one is available.',
                 'start':25.6,'end':27.2,'trackId':1,'jointIndex':10,'anchor':{'x':.60,'y':.50},'audio':None,'sample':True},
                {'id':'sample-pair','title':'Compare two participants','text':'Sample prompt: Switch to the motion view and keep only the instructor and the grey-shirt participant visible. Replay the passage to compare their timing.',
                 'start':25.0,'end':28.0,'trackId':2,'jointIndex':5,'anchor':{'x':.50,'y':.40},'audio':None,'sample':True}
            ]})

def clean_note(raw, lesson):
    if not isinstance(raw,dict):raise ValueError('A note must be an object.')
    title=str(raw.get('title','')).strip()[:120]
    text=str(raw.get('text','')).strip()[:12000]
    if not title:raise ValueError('Give the note a title.')
    if not text:raise ValueError('Add a text explanation.')
    if raw.get('audio'):raise ValueError('Audio annotations are no longer supported. Add a text explanation.')
    start,end=float(raw.get('start',18)),float(raw.get('end',20))
    lower,upper=lesson.get('sourceStart',18),lesson.get('sourceEnd',30)
    if not (lower<=start<end<=upper):raise ValueError(f'Choose a time range within {lower}–{upper} seconds, with an end after the start.')
    track=int(raw.get('trackId',0));joint=raw.get('jointIndex')
    allowed={0}|{p['id'] for p in lesson.get('people', [{'id':i} for i in range(1,5)])}
    if track not in allowed:raise ValueError('Unknown participant.')
    if joint is not None and (not isinstance(joint,int) or joint not in range(23)):raise ValueError('Unknown body part.')
    anchor=raw.get('anchor',{})
    x,y=float(anchor.get('x',.5)),float(anchor.get('y',.5))
    if not(0<=x<=1 and 0<=y<=1):raise ValueError('Choose a point inside the video.')
    note_id=raw.get('id') or uuid.uuid4().hex
    if not ID.fullmatch(note_id):raise ValueError('Invalid note identifier.')
    return {'id':note_id,'title':title,'text':text,'start':round(start,3),'end':round(end,3),'trackId':track,
            'jointIndex':joint,'anchor':{'x':x,'y':y},'sample':False,'updatedAt':now()}

class Handler(SimpleHTTPRequestHandler):
    def __init__(self,*args,**kwargs):super().__init__(*args,directory=str(PUBLIC),**kwargs)
    def read_project(self,lesson_id):
        lesson=onboarding.read(lesson_id)
        if lesson.get('adminPrivate') and not admin.local_request(self):raise ValueError('Unknown lesson.')
        return lesson
    def student(self):
        if hasattr(self,'_student_id'):return self._student_id
        cookies=SimpleCookie()
        try:cookies.load(self.headers.get('Cookie',''))
        except Exception:pass
        cookie=cookies.get('systema_student');value=cookie.value if cookie else ''
        if not re.fullmatch(r'[0-9a-f]{32}',value):
            value=uuid.uuid4().hex
            self._student_cookie=f'systema_student={value}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Strict'
        self._student_id=value
        return value
    def annotation_context(self):
        query=parse_qs(urlparse(self.path).query)
        project=query.get('project',[None])[0];snapshot_id=query.get('lesson',[None])[0]
        lesson_scope=student_data.scope(project,snapshot_id)
        if project:
            lesson=self.read_project(project)
            if lesson['status']!='ready':raise ValueError('This lesson is still being prepared.')
        elif snapshot_id:
            path=PUBLISHED/snapshot_id/'lesson.json'
            if not path.is_file():raise ValueError('Unknown lesson.')
            lesson=json.loads(path.read_text(encoding='utf-8'))
        else:lesson=json.loads((DATA/'lesson.json').read_text(encoding='utf-8'))
        return self.student(),lesson_scope,lesson
    def send_head(self):
        path=Path(self.translate_path(self.path))
        if path.suffix.lower() not in ['.mp4','.webm'] or not path.is_file():
            return super().send_head()
        # Browser seeking requires byte ranges, including Safari's metadata probes.
        size=path.stat().st_size;start=0;end=size-1;requested=self.headers.get('Range')
        if requested:
            match=re.fullmatch(r'bytes=(\d*)-(\d*)',requested)
            try:
                if not match or not any(match.groups()):raise ValueError()
                left,right=match.groups()
                if left:
                    start=int(left);end=min(int(right),size-1) if right else size-1
                else:
                    count=int(right)
                    if count<=0:raise ValueError()
                    start=max(0,size-count)
                if start> end or start>=size:raise ValueError()
            except ValueError:
                self.send_response(416);self.send_header('Content-Range',f'bytes */{size}')
                self.send_header('Content-Length','0');self.end_headers();return None
        stream=path.open('rb');stream.seek(start);self._remaining=end-start+1
        self.send_response(206 if requested else 200)
        self.send_header('Content-Type',self.guess_type(str(path)))
        self.send_header('Accept-Ranges','bytes');self.send_header('Content-Length',str(self._remaining))
        self.send_header('Last-Modified',self.date_time_string(path.stat().st_mtime))
        if requested:self.send_header('Content-Range',f'bytes {start}-{end}/{size}')
        self.end_headers();return stream
    def copyfile(self,source,output):
        remaining=getattr(self,'_remaining',None)
        try:
            if remaining is None:return super().copyfile(source,output)
            while remaining>0:
                chunk=source.read(min(65536,remaining))
                if not chunk:break
                output.write(chunk);remaining-=len(chunk)
        except (BrokenPipeError,ConnectionResetError,ConnectionAbortedError):pass
    def send_json(self,value,status=200):
        payload=json.dumps(value,ensure_ascii=False).encode()
        self.send_response(status);self.send_header('Content-Type','application/json; charset=utf-8')
        self.send_header('Content-Length',str(len(payload)));self.send_header('Cache-Control','no-store')
        self.end_headers();self.wfile.write(payload)
    def end_headers(self):
        if getattr(self,'_student_cookie',None):
            self.send_header('Set-Cookie',self._student_cookie)
            self._student_cookie=None
        self.send_header('X-Content-Type-Options','nosniff')
        self.send_header('Referrer-Policy','same-origin')
        super().end_headers()
    def translate_path(self,path):
        url=urlparse(path).path
        if url in ('/admin','/admin/'):
            return str(PUBLIC/'admin.html')
        asset=re.fullmatch(r'/admin-assets/([a-z0-9]+(?:-[a-z0-9]+)*)/(source\.mp4|motion\.json|poster\.jpg|scene\.json)',url)
        if asset and asset[1] in admin.saved()['staged']:
            return str(admin.PROJECT/'site/clips'/asset[1]/asset[2])
        if url.startswith('/admin-preview/'):
            parts=url.strip('/').split('/')
            if len(parts)>=2 and re.fullmatch(r'[a-f0-9]{32}',parts[1]):
                root=(admin.DATA/'previews'/parts[1]).resolve()
                target=root.joinpath(*parts[2:]).resolve()
                if target.is_relative_to(root):return str(target)
            return str(PUBLIC/'missing')
        if url=='/' and not urlparse(path).query:return str(PUBLIC/'onboarding.html')
        parts=url.strip('/').split('/')
        if len(parts)==3 and parts[0]=='lessons' and parts[2] in ['source.mp4','motion.json']:
            try:
                self.read_project(parts[1])
                return str(onboarding.folder(parts[1])/parts[2])
            except ValueError:return str(PUBLIC/'missing')
        if url=='/media/source-reference.mp4':return str(PROJECT/'outputs/pilot/source-reference.mp4')
        if url in ['/3d-pilot/scene.json','/3d-pilot/manifest.json']:
            return str(PROJECT/'outputs/3d-pilot'/url.split('/')[-1])
        if url.startswith(('/audio/','/student-audio/')):
            return str(PUBLIC/'missing')
        parts=url.strip('/').split('/')
        if len(parts)>=3 and parts[0]=='published' and ID.fullmatch(parts[1]):
            if parts[2]=='audio':return str(PUBLIC/'missing')
            snapshot_root=(PUBLISHED/parts[1]).resolve()
            candidate=snapshot_root.joinpath(*parts[2:]).resolve()
            if candidate.is_relative_to(snapshot_root):return str(candidate)
        return super().translate_path(path)
    def do_GET(self):
        path=urlparse(self.path).path
        try:
            if path.startswith(('/admin','/api/admin')):
                if not admin.local_request(self):return self.send_json({'error':'Open the admin dashboard on this PC using http://127.0.0.1 and the server port.'},403)
                if path=='/api/admin/state':return self.send_json(admin.state())
                match=re.fullmatch(r'/api/admin/clips/([a-z0-9]+(?:-[a-z0-9]+)*)/reconstruction/log',path)
                if match:return self.send_json(admin.reconstruction.log(admin,match[1]))
            if path=='/api/video-requests':
                return self.send_json({'requests':[{k:v for k,v in r.items() if k!='studentId'} for r in student_data.requests(self.student())]})
            if path=='/api/annotations':
                student,lesson_scope,_=self.annotation_context()
                return self.send_json({'notes':student_data.notes(student,lesson_scope)})
            if path=='/api/projects':return self.send_json({'lessons':[v for v in onboarding.library() if v['status']=='ready' and (not v.get('adminPrivate') or admin.local_request(self))]})
            if path.startswith('/api/projects/'):return self.send_json(self.read_project(path.split('/')[-1]))
            if path in ['/api/lesson','/lesson.json']:
                lesson_id=parse_qs(urlparse(self.path).query).get('project',[None])[0]
                return self.send_json(self.read_project(lesson_id) if lesson_id else json.loads((DATA/'lesson.json').read_text(encoding='utf-8')))
        except ValueError as failure:return self.send_json({'error':str(failure)},404)
        return super().do_GET()
    def do_POST(self):
        try:
            path=urlparse(self.path).path
            if path.startswith('/api/admin/'):
                if not admin.local_request(self,write=True):
                    self.close_connection=True
                    return self.send_json({'error':'Use the local admin dashboard to make this change.'},403)
                size=int(self.headers.get('Content-Length','0'))
                if path=='/api/admin/upload':
                    if not 0<size<=onboarding.MAX_UPLOAD:raise ValueError('Choose a video under 500 MB.')
                    name=Path(unquote(self.headers.get('X-File-Name','video.mp4'))).name
                    lesson=onboarding.upload(self.rfile,size,name,now());lesson['adminPrivate']=True
                    onboarding.save(onboarding.folder(lesson['id'])/'lesson.json',lesson)
                    return self.send_json(lesson,201)
                limit=50*1024*1024 if path.endswith('/scene') else 1024*1024
                if not 0<size<=limit:raise ValueError('Admin request is empty or too large.')
                raw=json.loads(self.rfile.read(size))
                if path=='/api/admin/prepare':
                    with admin.LOCK:
                        onboarding.draft(raw['lessonId'],raw,now())
                        return self.send_json(onboarding.generate(raw['lessonId']))
                if path=='/api/admin/drafts/delete':return self.send_json(admin.delete_draft(raw['lessonId']))
                if path=='/api/admin/stage':return self.send_json(admin.stage(raw),202)
                if path=='/api/admin/unstage':return self.send_json(admin.unstage(raw['clipId']))
                if path=='/api/admin/preview':return self.send_json(admin.build_preview(),202)
                if path=='/api/admin/publish':return self.send_json(admin.publish(raw),202)
                if path=='/api/admin/requirements':return self.send_json(admin.reconstruction.requirements(admin,use_gpu=raw.get('gpu') is True),202)
                if path=='/api/admin/gpu/pause':return self.send_json(admin.reconstruction.pause_gpu(admin))
                if path=='/api/admin/rooms/import':return self.send_json(admin.room_scans.import_scan(admin,raw),202)
                match=re.fullmatch(r'/api/admin/clips/([a-z0-9]+(?:-[a-z0-9]+)*)/(room|room-placement)',path)
                if match:
                    if match[2]=='room':return self.send_json(admin.room_scans.attach(admin,match[1],raw))
                    return self.send_json(admin.room_scans.save_placement(admin,match[1],raw))
                match=re.fullmatch(r'/api/admin/clips/([a-z0-9]+(?:-[a-z0-9]+)*)/(reconstruct|cancel|review)',path)
                if match:
                    if match[2]=='reconstruct':return self.send_json(admin.reconstruction.reconstruct(admin,match[1],raw),202)
                    if match[2]=='cancel':return self.send_json(admin.reconstruction.cancel(admin,match[1]))
                    return self.send_json(admin.reconstruction.approve(admin,match[1],raw))
                match=re.fullmatch(r'/api/admin/clips/([a-z0-9]+(?:-[a-z0-9]+)*)/scene',path)
                if match:return self.send_json(admin.attach_scene(match[1],raw))
                return self.send_json({'error':'Unknown admin action.'},404)
            # Reject cross-origin browser writes; the local prototype has no hosted accounts.
            origin=self.headers.get('Origin')
            host=self.headers.get('Host','')
            parsed_origin=urlparse(origin) if origin else None
            if origin and (parsed_origin.scheme not in ['http','https'] or parsed_origin.netloc.lower()!=host.lower()):
                raise ValueError('Use this teaching page to save changes.')
            path=urlparse(self.path).path
            size=int(self.headers.get('Content-Length','0'))
            if path=='/api/audio':
                self.close_connection=True
                return self.send_json({'error':'Audio annotations are no longer supported. Add a text explanation.'},410)
            if path=='/api/videos':
                self.close_connection=True
                return self.send_json({'error':'Submit a video link for your teacher to process.'},410)
            if not(0<size<=20*1024*1024):raise ValueError('The request is empty or too large (20 MB maximum).')
            body=self.rfile.read(size)
            raw=json.loads(body)
            with LOCK:
                if path=='/api/video-requests':
                    value=student_data.submit(self.student(),raw,now())
                    return self.send_json({'request':{k:v for k,v in value.items() if k!='studentId'}},201)
                if path.startswith('/api/projects/'):
                    return self.send_json({'error':'Your teacher prepares lessons from the video request queue.'},410)
                if path in ['/api/notes','/api/notes/delete']:
                    student,lesson_scope,lesson=self.annotation_context()
                    notes=student_data.notes(student,lesson_scope)
                    if path=='/api/notes':
                        if raw.get('id') and not any(n['id']==raw['id'] for n in notes):raise ValueError('This annotation does not belong to you.')
                        note=clean_note(raw,lesson)
                        notes=[n for n in notes if n['id']!=note['id']]+[note]
                        notes.sort(key=lambda n:(n['start'],n['id']))
                    else:
                        if not any(n['id']==raw.get('id') for n in notes):raise ValueError('This annotation does not belong to you.')
                        notes=[n for n in notes if n['id']!=raw['id']]
                    student_data.save(student_data.notes_path(student,lesson_scope),notes)
                    return self.send_json({'notes':notes,**({'note':note} if path=='/api/notes' else {})})
            return self.send_json({'error':'Unknown action.'},404)
        except (ValueError,TypeError,KeyError,json.JSONDecodeError) as e:self.send_json({'error':str(e)},400)
        except Exception as e:
            print(f'Action failed: {e}',flush=True);self.send_json({'error':'The lesson could not be saved. Please try again.'},500)

if __name__=='__main__':
    parser=argparse.ArgumentParser(description='Run the Systema teaching prototype.')
    parser.add_argument('--lan',action='store_true',help='listen on all network interfaces for testing on other devices')
    parser.add_argument('--host',default='127.0.0.1',help='address to bind (default: 127.0.0.1)')
    parser.add_argument('--port',type=int,default=8770,help='TCP port (default: 8770)')
    parser.add_argument('--admin',action='store_true',help='open the local video administration dashboard')
    args=parser.parse_args()
    host='0.0.0.0' if args.lan else args.host
    initialize()
    onboarding.recover()
    admin.reconstruction.recover(admin)
    print(f'Systema teaching prototype: http://127.0.0.1:{args.port}/',flush=True)
    print(f'Local video admin: http://127.0.0.1:{args.port}/admin',flush=True)
    if host=='0.0.0.0':
        address=lan_address()
        if address:print(f'LAN access: http://{address}:{args.port}/',flush=True)
        else:print(f'LAN access: http://<this-computer-ip>:{args.port}/',flush=True)
        print('Keep this window open. Press Ctrl+C to stop.',flush=True)
    httpd=ThreadingHTTPServer((host,args.port),Handler)
    admin.reconstruction.requirements(admin)
    if args.admin:
        import webbrowser
        webbrowser.open(f'http://127.0.0.1:{args.port}/admin')
    httpd.serve_forever()

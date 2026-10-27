"""Ingest the full ground-work working copy and prepare a representative test passage."""
import http.client
import json
from pathlib import Path
import time
import urllib.request
from urllib.parse import quote

ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'outputs/ground-work-validation'
BASE='http://127.0.0.1:8771'

def request(path,body=None):
    state=json.load(urllib.request.urlopen(BASE+'/api/admin/state',timeout=30))
    headers={'Origin':BASE,'X-Systema-Admin-Token':state['token'],'Content-Type':'application/json'}
    req=urllib.request.Request(BASE+'/api/admin/'+path,data=None if body is None else json.dumps(body).encode(),headers=headers)
    with urllib.request.urlopen(req,timeout=600) as response:return json.load(response)

if __name__=='__main__':
    working=OUT/'Systema - Extended ground work - ingestion.mp4'
    state=request('state')
    lesson=next((lesson for lesson in state['lessons'] if lesson['title']=='Systema - Extended ground work'),None)
    if lesson is None:
        print('Importing full-length 1280px working copy through the dashboard upload endpoint.',flush=True)
        connection=http.client.HTTPConnection('127.0.0.1',8771,timeout=600)
        with working.open('rb') as stream:
            connection.request('POST','/api/admin/upload',body=stream,headers={'Origin':BASE,'X-Systema-Admin-Token':state['token'],
                'X-File-Name':quote('Systema - Extended ground work.mp4'),'Content-Type':'application/octet-stream','Content-Length':str(working.stat().st_size)})
            response=connection.getresponse();lesson=json.load(response)
            if response.status!=201:raise RuntimeError(lesson)
        connection.close()
    print('Imported lesson '+lesson['id'],flush=True)
    record={'lessonId':lesson['id'],'source':'D:\\Systema\\Exports\\Systema - Extended ground work.mp4',
            'workingCopy':str(working),'sourceSeconds':339.0387,'testPassage':{'start':25,'end':29},'status':'preparing'}
    (OUT/'ingestion.json').write_text(json.dumps(record,indent=2))
    if lesson['status'] not in ('ready','processing','queued'):
        request('prepare',{'lessonId':lesson['id'],'title':'Systema - Extended ground work','segments':[{'start':25,'end':29,'label':'Ground work · participant correction test'}]})
    last=None
    for _ in range(360):
        state=request('state');lesson=next(row for row in state['lessons'] if row['id']==lesson['id'])
        if lesson['message']!=last:print(lesson['message'],flush=True);last=lesson['message']
        if lesson['status'] in ('ready','failed'):break
        time.sleep(2)
    else:raise TimeoutError('2D preparation did not finish in twelve minutes.')
    record.update(status=lesson['status'],message=lesson['message'])
    (OUT/'ingestion.json').write_text(json.dumps(record,indent=2))
    if lesson['status']!='ready':raise RuntimeError(lesson['message'])
    print('PASS Full clip ingested; 120-frame ground-work passage prepared for participant review.',flush=True)

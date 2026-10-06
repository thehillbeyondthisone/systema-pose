"""Check that the exported student lesson carries all of its referenced assets."""
import json
import zipfile
from pathlib import Path
ROOT=Path(__file__).resolve().parent.parent
report=json.loads((ROOT/'outputs/teaching-suite/validation.json').read_text(encoding='utf-8'))
archive=ROOT/'outputs/teaching-suite/qa-lesson-package.zip'
with zipfile.ZipFile(archive) as z:
    assert z.testzip() is None
    required={'index.html','app.js','style.css','motion.json','lesson.json','media/source-reference.mp4','START-HERE.txt'}
    assert required<=set(z.namelist())
    lesson=json.loads(z.read('lesson.json'))
    motion=json.loads(z.read('motion.json'))
    assert len(motion['frames'])==360
    assert z.read('media/source-reference.mp4')==(ROOT/'outputs/pilot/source-reference.mp4').read_bytes()
    audio=[n['audio'] for n in lesson['notes'] if n.get('audio')]
    assert len(audio)>=2
    for name in audio:assert len(z.read('audio/'+name))>500
    assert any('—' in n['text'] for n in lesson['notes'])
report['packageVerification']={'zipIntegrity':True,'videoMatchesPilot':True,'motionFrames':360,'notes':len(lesson['notes']),'referencedAudioFiles':len(audio),'unicodePreserved':True}
(ROOT/'outputs/teaching-suite/validation.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
print(json.dumps(report['packageVerification']))

import hashlib
import json
import subprocess
from pathlib import Path

import cv2
import imageio_ffmpeg
import onnxruntime as ort
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
SOURCE = Path(r'C:\Users\thefo\OneDrive\Desktop\New folder (2)\MultipleAttackers_Nov1.mp4')
cap = cv2.VideoCapture(str(SOURCE))
fps = cap.get(cv2.CAP_PROP_FPS)
total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
width, height = [int(cap.get(p)) for p in (cv2.CAP_PROP_FRAME_WIDTH, cv2.CAP_PROP_FRAME_HEIGHT)]
sheet = Image.new('RGB', (1440, 4 * 300), '#121722')
draw = ImageDraw.Draw(sheet)
sample_times = [2, 8, 14, 20, 26, 32, 38, 44, 50, 56, 62, 68]
for i, sec in enumerate(sample_times):
    cap.set(cv2.CAP_PROP_POS_FRAMES, round(sec * fps))
    ok, frame = cap.read()
    if not ok:
        continue
    image = Image.fromarray(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)).resize((480, 270))
    x, y = (i % 3) * 480, (i // 3) * 300
    sheet.paste(image, (x, y))
    draw.text((x + 8, y + 276), f'{sec:.1f}s / source frame {round(sec * fps)}', fill='white')
sheet.save(ROOT / 'outputs' / 'source-contact-sheet.jpg', quality=92)
cap.release()
ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
probe = subprocess.run([ffmpeg, '-hide_banner', '-i', str(SOURCE)], capture_output=True, text=True)
(ROOT / 'work' / 'source-ffmpeg.txt').write_text(probe.stderr, encoding='utf-8')
meta = {'path': str(SOURCE), 'bytes': SOURCE.stat().st_size, 'sha256': hashlib.file_digest(SOURCE.open('rb'), 'sha256').hexdigest(),
        'width': width, 'height': height, 'fps': fps, 'reported_frames': total,
        'ffmpeg': ffmpeg, 'onnxruntime_providers': ort.get_available_providers()}
(ROOT / 'work' / 'source-metadata.json').write_text(json.dumps(meta, indent=2), encoding='utf-8')
print(json.dumps(meta, indent=2))

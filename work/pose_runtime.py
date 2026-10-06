import json
from pathlib import Path

import onnxruntime as ort
from rtmlib import RTMPose, YOLOX

ROOT = Path(__file__).resolve().parent.parent

def load_models(provider='DmlExecutionProvider'):
    entries = json.loads((ROOT / 'work' / 'models' / 'manifest.json').read_text())
    paths = {e['role']: e['onnx'][0]['path'] for e in entries}
    det = YOLOX(paths['detector'], model_input_size=(640, 640), score_thr=0.35,
                backend='onnxruntime', device='cpu')
    pose = RTMPose(paths['pose'], model_input_size=(288, 384), to_openpose=False,
                   backend='onnxruntime', device='cpu')
    options = ort.SessionOptions()
    options.enable_mem_pattern = False
    options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
    options.intra_op_num_threads = 4
    for model in (det, pose):
        model.session = ort.InferenceSession(model.onnx_model, sess_options=options,
                                             providers=[provider, 'CPUExecutionProvider'] if provider != 'CPUExecutionProvider' else [provider])
    return det, pose

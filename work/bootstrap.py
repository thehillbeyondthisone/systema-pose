"""Run project scripts with an isolated, project-local dependency directory."""
import os
import runpy
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'work' / 'runtime'))
sys.path.insert(0, str(ROOT / 'work'))
os.environ['XDG_CACHE_HOME'] = str(ROOT / 'work' / 'cache')
os.environ['HF_HOME'] = str(ROOT / 'work' / 'cache' / 'huggingface')
os.environ['TEMP'] = os.environ['TMP'] = str(ROOT / 'work' / 'tmp')
target = sys.argv.pop(1)
runpy.run_path(str(ROOT / 'work' / target), run_name='__main__')

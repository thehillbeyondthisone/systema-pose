"""A locked progress file must not discard an otherwise valid reconstruction."""
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from dashboard_3d_worker import write_progress


class ProgressTests(unittest.TestCase):
    def test_transient_windows_lock(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parents[1] / 'outputs') as directory:
            output = Path(directory)
            original = Path.replace
            calls = []

            def replace(path, target):
                calls.append(path)
                if len(calls) < 3:raise PermissionError('Windows reader holds the file')
                return original(path, target)

            with patch.object(Path, 'replace', replace), patch('dashboard_3d_worker.time.sleep'):
                self.assertTrue(write_progress(output, 'Body frame 15'))
            self.assertEqual(len(calls), 3)
            self.assertEqual(json.loads((output / 'progress.json').read_text())['message'], 'Body frame 15')

    def test_persistent_lock_does_not_abort(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parents[1] / 'outputs') as directory:
            output = Path(directory)
            (output / 'progress.json').write_text('{"message":"Previous progress"}')
            with patch.object(Path, 'replace', side_effect=PermissionError('Locked')), patch('dashboard_3d_worker.time.sleep'):
                self.assertFalse(write_progress(output, 'New progress'))
            self.assertEqual(json.loads((output / 'progress.json').read_text())['message'], 'Previous progress')
            self.assertTrue(write_progress(output, 'Next progress'))


if __name__ == '__main__':unittest.main()

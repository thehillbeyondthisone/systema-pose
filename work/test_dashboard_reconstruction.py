"""Failure-path checks: no GPU installation or source/model mutation."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from types import SimpleNamespace
from unittest.mock import patch, Mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'teaching_suite'))
import admin
import reconstruction as r


class ReconstructionGuards(unittest.TestCase):
    def setUp(self):
        directory = ROOT / 'outputs/dashboard-guards';directory.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=directory)
        self.root = Path(self.temp.name)
        self.patches = [patch.object(admin, 'DATA', self.root / 'private/admin'), patch.object(admin, 'PROJECT', self.root),
                        patch.object(admin.onboarding, 'LESSONS', self.root / 'private/lessons')]
        for p in self.patches:p.start()
        admin.DATA.mkdir(parents=True)
        admin.save_state({'gpuPaused': False, 'staged': ['review-test'], 'preview': None})
        self.path = r.record_path(admin, 'review-test');self.path.parent.mkdir(parents=True)
        self.scene = self.root / 'site/clips/review-test/scene.json';self.scene.parent.mkdir(parents=True);self.scene.write_text('{"frames":[]}')
        self.value = {'clipId': 'review-test', 'runId': 'new-run', 'status': 'ready', 'reviewed': False, 'sceneSha256': admin.digest(self.scene)}
        admin.onboarding.save(self.path, self.value)

    def tearDown(self):
        for p in reversed(self.patches):p.stop()
        self.temp.cleanup()

    def test_windows_paths_are_argument_values(self):
        self.assertEqual(r.linux_path(Path('C:/A folder/video.mp4')), '/mnt/c/A folder/video.mp4')
        with self.assertRaises(ValueError):r.linux_path(Path('//server/share/video.mp4'))
        with self.assertRaises(ValueError):r.record_path(admin, '../elsewhere')

    def test_missing_wsl_and_timeout_report_failure(self):
        video = subprocess.CompletedProcess([], 0, stdout='{"ready":true,"detail":"Video runtime present"}')
        with patch.object(r.shutil, 'which', return_value=None), patch.object(r.subprocess, 'run', return_value=video):
            report = r.check(admin, {})
        self.assertEqual(report['status'], 'missing');self.assertIn('WSL is missing', report['errors'][0])
        with patch.object(r.shutil, 'which', return_value='wsl'), patch.object(r.subprocess, 'run', side_effect=subprocess.TimeoutExpired('check', 180)):
            report = r.check(admin, {})
        self.assertEqual(report['status'], 'missing');self.assertTrue(report['errors'])

    def test_missing_requirements_never_start_gpu_worker(self):
        with patch.object(admin, 'saved', return_value={'staged': ['review-test']}), patch.object(r, 'runtime_state', return_value={'ready': False}), patch.object(r.subprocess, 'Popen') as spawn:
            with self.assertRaisesRegex(ValueError, 'requirements'):r.reconstruct(admin, 'review-test', {})
            spawn.assert_not_called()

    def test_paused_gpu_blocks_worker_even_with_cached_success(self):
        with patch.object(admin.onboarding, 'gpu_paused', return_value=True), patch.object(r.subprocess, 'Popen') as spawn:
            with self.assertRaisesRegex(ValueError, 'GPU use is paused'):r.reconstruct(admin, 'review-test', {})
            spawn.assert_not_called()

    def test_pause_persists_and_cancels_active_work_without_losing_staged_clips(self):
        event = threading.Event()
        with patch.object(r, 'CANCEL', {'test-run': event}):r.pause_gpu(admin)
        self.assertTrue(event.is_set());self.assertTrue(admin.onboarding.gpu_paused())
        self.assertEqual(admin.saved()['staged'], ['review-test'])
        self.assertFalse(r.runtime_state(admin)['ready'])

    def test_pausing_gpu_stops_accelerated_2d_and_leaves_cpu_job_alone(self):
        gpu_process, cpu_process = Mock(), Mock()
        gpu_process.poll.return_value = None;cpu_process.poll.return_value = None
        processes = {'gpu-job': {'process': gpu_process, 'usesGpu': True}, 'cpu-job': {'process': cpu_process, 'usesGpu': False}}
        with patch.object(admin.onboarding, 'PROCESSES', processes), patch.object(admin.onboarding, 'GPU_STOPPED', set()):
            result = r.pause_gpu(admin)
            self.assertEqual(result['stopped2dJobs'], 1);gpu_process.terminate.assert_called_once();cpu_process.terminate.assert_not_called()

    def lesson_fixture(self):
        identity = 'a'*32
        folder = admin.onboarding.LESSONS / identity;folder.mkdir(parents=True)
        (folder / 'source.mp4').write_bytes(b'preserved source fixture')
        admin.onboarding.save(folder / 'lesson.json', {'id': identity, 'status': 'queued'})
        return identity, folder

    def test_cpu_job_keeps_its_provider_when_gpu_policy_changes(self):
        identity, folder = self.lesson_fixture()
        process = Mock();process.wait.return_value = 0
        with patch.object(admin.onboarding, 'gpu_paused', return_value=True), patch.object(admin.onboarding.subprocess, 'Popen', return_value=process) as spawn:
            admin.onboarding.run_job(identity)
        self.assertIn('CPUExecutionProvider', spawn.call_args.args[0]);process.terminate.assert_not_called()
        self.assertNotIn(identity, admin.onboarding.PROCESSES)

    def test_gpu_job_observes_pause_even_from_another_server(self):
        identity, folder = self.lesson_fixture()
        process = Mock();process.wait.side_effect = [subprocess.TimeoutExpired('worker', 1), -15]
        with patch.object(admin.onboarding, 'gpu_paused', side_effect=[False, True]), patch.object(admin.onboarding.subprocess, 'Popen', return_value=process):
            admin.onboarding.run_job(identity)
        process.terminate.assert_called_once()
        lesson = json.loads((folder / 'lesson.json').read_text())
        self.assertEqual(lesson['status'], 'failed');self.assertIn('free the GPU', lesson['message']);self.assertTrue((folder / 'source.mp4').exists())

    def test_installed_check_never_requests_cuda_execution(self):
        def run(command, **kwargs):
            if '--check' in command:return subprocess.CompletedProcess(command, 0, stdout='{"ready":true,"detail":"CPU runtime ready"}')
            self.assertIn('--inventory-only', command);self.assertNotIn('--use-gpu', command)
            details = {'mode': 'inventory', 'imports': {str(i): 'installed' for i in range(16)}, 'assets': [{'name': 'model', 'present': True}], 'errors': []}
            (admin.DATA / 'runtime-details.json').write_text(json.dumps(details))
            return subprocess.CompletedProcess(command, 0, stdout='')
        with patch.object(r.shutil, 'which', return_value='wsl'), patch.object(r.subprocess, 'run', side_effect=run):
            report = r.check(admin, {})
        self.assertEqual(report['status'], 'installed');self.assertFalse(report['gpuValidated'])
        self.assertEqual(len([check for check in report['checks'] if check['ok'] is None]), 2)

    def test_gpu_validation_requires_separate_explicit_command(self):
        def run(command, **kwargs):
            if '--check' in command:return subprocess.CompletedProcess(command, 0, stdout='{"ready":true,"detail":"CPU runtime ready"}')
            self.assertIn('--use-gpu', command);self.assertIn('--pause-file', command);self.assertNotIn('--inventory-only', command)
            details = {'imports': {str(i): 'mock import' for i in range(16)}, 'assets': [{'present': True}], 'errors': [],
                       'gpu': 'Mock GPU (not executed)', 'cudaOperations': 'mock', 'smplForward': 'mock', 'smplxForward': 'mock'}
            (admin.DATA / 'runtime-details.json').write_text(json.dumps(details))
            return subprocess.CompletedProcess(command, 0, stdout='')
        with patch.object(r.shutil, 'which', return_value='wsl'), patch.object(r.subprocess, 'run', side_effect=run):
            report = r.check(admin, {}, use_gpu=True)
        self.assertTrue(report['gpuValidated']);self.assertEqual(report['status'], 'ready')
        r.pause_gpu(admin)
        self.assertFalse(r.runtime_state(admin)['ready'])

    def test_review_is_for_exact_finished_run_and_bytes(self):
        with self.assertRaisesRegex(ValueError, 'finished 3D'):r.approve(admin, 'review-test', {'reviewed': True, 'runId': 'old-run'})
        with self.assertRaisesRegex(ValueError, 'review the 3D'):r.publish_check(admin, ['review-test'])
        self.scene.write_text('changed')
        with self.assertRaisesRegex(ValueError, 'scene changed'):r.approve(admin, 'review-test', {'reviewed': True, 'runId': 'new-run'})
        self.scene.write_text('{"frames":[]}')
        r.approve(admin, 'review-test', {'reviewed': True, 'runId': 'new-run'})
        r.publish_check(admin, ['review-test'])
        self.scene.write_text('changed')
        with self.assertRaisesRegex(ValueError, 'scene changed'):r.publish_check(admin, ['review-test'])

    def test_interrupted_run_recovery_preserves_files(self):
        self.value.update(status='running', reviewed=False)
        admin.onboarding.save(self.path, self.value)
        with patch.object(r, 'stop') as stop:
            r.recover(admin);stop.assert_called_once()
        result = json.loads(self.path.read_text())
        self.assertEqual(result['status'], 'failed');self.assertTrue(self.scene.is_file())

    def test_progress_keeps_image_batches_unchanged(self):
        sys.path.insert(0, str(ROOT / 'work'))
        import dashboard_3d_worker as worker
        class Loader:
            dataset = [10, 20, 30]
            def __len__(self):return 2
            def __iter__(self):yield [10, 20];yield [30]
        module = SimpleNamespace(DataLoader=lambda: Loader())
        methods = ['load_frames', 'run_detect_track', 'camera_motion_estimation', 'estimate_2d_keypoints',
                   'hps_estimation', 'world_hps_estimation', 'post_optimization']
        pipeline = SimpleNamespace(**{name: lambda: None for name in methods})
        with patch.dict(sys.modules, {'pipeline': SimpleNamespace(phmr_vid=module)}):
            worker.install_progress(pipeline, self.root)
            loader = module.DataLoader()
            self.assertEqual(len(loader), 2)
            self.assertEqual(list(loader), [[10, 20], [30]])
        self.assertIn('motion over time', json.loads((self.root / 'progress.json').read_text())['message'])


if __name__ == '__main__':unittest.main(verbosity=2)

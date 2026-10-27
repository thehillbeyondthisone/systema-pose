"""Participant edits preserve source tracking and invalidate dependent 3D results.

Uses isolated files and no video/model execution. Run with:
    python work/test_track_corrections.py
"""
import copy
import io
import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'teaching_suite'))
import admin
import track_corrections as corrections


class TrackCorrections(unittest.TestCase):
    def setUp(self):
        directory = ROOT / 'outputs/track-correction-tests'
        directory.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=directory)
        self.root = Path(self.temp.name)
        self.patches = [
            patch.object(admin, 'PROJECT', self.root),
            patch.object(admin, 'DATA', self.root / 'private/admin'),
            patch.object(admin, 'CATALOG', self.root / 'site/lessons.json'),
            patch.object(admin, 'LOCK', threading.RLock()),
            patch.object(admin, 'BUSY', threading.Lock()),
            patch.object(admin.onboarding, 'ACTIVE', set()),
            patch.object(admin.reconstruction, 'CANCEL', {}),
        ]
        for item in self.patches:
            item.start()
        self.clip = 'track-test'
        self.folder = self.root / 'site/clips' / self.clip
        self.folder.mkdir(parents=True)
        self.source = self.folder / 'source.mp4'
        self.source.write_bytes(b'Unchanged staged footage fixture')
        self.people = [{'id': i, 'name': f'Track {i}', 'color': f'#{i:06x}'} for i in range(1, 5)]
        self.motion = {
            'fps': 30, 'sourceStart': 12, 'sourceEnd': 12 + 8 / 30,
            'width': 1280, 'height': 720, 'people': self.people,
            'frames': [{'frame': frame, 'people': [self.detection(i, frame) for i in range(1, 5)
                       if (i == 1 and frame < 4) or (i == 2 and frame >= 4) or i == 3 or (i == 4 and frame == 6)]}
                       for frame in range(8)],
        }
        self.motion_path = self.folder / 'motion.json'
        admin.onboarding.save(self.motion_path, self.motion)
        self.original_bytes = self.motion_path.read_bytes()
        self.entry = {
            'id': self.clip, 'title': 'Track correction fixture', 'people': self.people,
            'motion': f'site/clips/{self.clip}/motion.json',
            'video': f'site/clips/{self.clip}/source.mp4', 'sourceSha256': admin.digest(self.source),
            'frameMapping': 'frame',
        }
        admin.onboarding.save(admin.CATALOG, {'title': 'Isolated correction tests', 'lessons': [self.entry]})
        admin.save_state({'staged': [self.clip], 'preview': {'id': 'old-preview'}, 'gpuPaused': False})

    def tearDown(self):
        for item in reversed(self.patches):
            item.stop()
        self.temp.cleanup()

    @staticmethod
    def detection(identity, frame):
        return {'id': identity, 'xy': [[identity * 100 + frame, 40], [identity * 100 + frame, 80]],
                'confidence': [.8, .9], 'bbox': [identity * 100, 10, identity * 100 + 40, 110],
                'status': ['tracked']}

    def payload(self):
        state = corrections.get(admin, self.clip)
        return {'revision': state['revision'], 'corrections': copy.deepcopy(state['corrections'])}

    def merge_payload(self):
        value = self.payload()
        for row in value['corrections']:
            row['targetId'] = 1 if row['sourceId'] in (1, 2) else None
            row['name'] = 'Instructor' if row['targetId'] else row['name']
        return value

    def effective(self):
        return json.loads(self.motion_path.read_text(encoding='utf-8'))

    def test_initial_read_returns_original_tracks_and_does_not_change_staged_motion(self):
        before = admin.CATALOG.read_bytes()
        result = corrections.get(admin, self.clip)
        self.assertEqual(result['motion'], self.motion)
        counts = {track['id']: track['count'] for track in result['tracks']}
        self.assertEqual(counts, {1: 4, 2: 4, 3: 8, 4: 1})
        self.assertEqual(len(result['corrections']), 4)
        self.assertTrue(all(row['startFrame'] == 0 and row['endFrame'] == 8 for row in result['corrections']))
        self.assertEqual(self.motion_path.read_bytes(), self.original_bytes)
        self.assertEqual(admin.CATALOG.read_bytes(), before)

    def test_disjoint_fragments_merge_without_renumbering_or_changing_source_timing(self):
        payload = self.merge_payload()
        corrections.save(admin, self.clip, payload)
        effective = self.effective()
        self.assertEqual(effective['people'][0]['id'], 1)
        self.assertEqual(effective['people'][0]['name'], 'Instructor')
        self.assertEqual(len(effective['people']), 1)
        for key in ('fps', 'width', 'height', 'sourceStart', 'sourceEnd'):
            self.assertEqual(effective[key], self.motion[key])
        self.assertEqual([frame['frame'] for frame in effective['frames']], list(range(8)))
        for frame in effective['frames']:
            expected_source = 1 if frame['frame'] < 4 else 2
            expected = self.detection(expected_source, frame['frame'])
            expected['id'] = 1
            self.assertEqual(frame['people'], [expected])
        self.assertEqual(admin.catalog()['lessons'][0]['people'], effective['people'])
        self.assertEqual(self.source.read_bytes(), b'Unchanged staged footage fixture')

    def test_trim_uses_exclusive_end_and_keeps_dense_empty_frames(self):
        payload = self.merge_payload()
        for row in payload['corrections']:
            if row['sourceId'] == 1:
                row.update(startFrame=1, endFrame=3)
            if row['sourceId'] == 2:
                row['targetId'] = None
        corrections.save(admin, self.clip, payload)
        result = self.effective()
        self.assertEqual(len(result['frames']), 8)
        self.assertEqual([frame['frame'] for frame in result['frames'] if frame['people']], [1, 2])
        self.assertEqual(result['sourceEnd'], self.motion['sourceEnd'])

    def test_target_identity_is_preserved_when_not_the_lowest_id(self):
        payload = self.merge_payload()
        for row in payload['corrections']:
            if row['targetId'] is not None:
                row['targetId'] = 2
        corrections.save(admin, self.clip, payload)
        self.assertEqual([person['id'] for person in self.effective()['people']], [2])
        self.assertTrue(all(frame['people'][0]['id'] == 2 for frame in self.effective()['frames']))

    def test_cooccurring_detections_cannot_merge_and_failure_does_not_mutate_files(self):
        payload = self.merge_payload()
        next(row for row in payload['corrections'] if row['sourceId'] == 3).update(targetId=1, name='Instructor')
        before = (self.motion_path.read_bytes(), admin.CATALOG.read_bytes(), admin.saved())
        with self.assertRaises(ValueError):
            corrections.save(admin, self.clip, payload)
        self.assertEqual((self.motion_path.read_bytes(), admin.CATALOG.read_bytes(), admin.saved()), before)

    def test_all_excluded_is_rejected_without_erasing_tracking(self):
        payload = self.payload()
        for row in payload['corrections']:
            row['targetId'] = None
        with self.assertRaises(ValueError):
            corrections.save(admin, self.clip, payload)
        self.assertEqual(self.motion_path.read_bytes(), self.original_bytes)

    def overlap_payload(self):
        value = self.payload()
        value['overlapPolicy'] = 'prefer-primary'
        for row in value['corrections']:
            row.update(targetId=1, name='Instructor')
        return value

    def test_explicit_overlap_policy_chooses_primary_then_smallest_source_id(self):
        corrections.save(admin, self.clip, self.overlap_payload())
        result = self.effective()
        for frame in result['frames']:
            expected = self.detection(1 if frame['frame'] < 4 else 2, frame['frame'])
            expected['id'] = 1
            self.assertEqual(frame['people'], [expected])
        state = corrections.get(admin, self.clip)
        self.assertEqual(state['overlapPolicy'], 'prefer-primary')
        self.assertEqual(state['overlapsResolved'], 8)
        private = admin.DATA / 'track-corrections' / self.clip
        self.assertEqual((private / 'source-motion.json').read_bytes(), self.original_bytes)
        self.assertEqual(state['motion'], self.motion)
        self.assertEqual(state['motion']['frames'][6]['people'], self.motion['frames'][6]['people'])
        audit = json.loads(next((private / 'history').glob('*/audit.json')).read_text(encoding='utf-8'))
        self.assertEqual(audit['overlapPolicy'], 'prefer-primary')
        self.assertEqual(audit['overlapsResolved'], 8)
        resolutions = {row['frame']: row for row in audit['overlapResolutions']}
        self.assertEqual(resolutions[0]['selectedSourceId'], 1)
        self.assertEqual(resolutions[0]['discardedSourceIds'], [3])
        self.assertEqual(resolutions[6]['selectedSourceId'], 2)
        self.assertEqual(resolutions[6]['discardedSourceIds'], [3, 4])

    def test_overlap_resolution_does_not_depend_on_detection_or_correction_order(self):
        corrections.save(admin, self.clip, self.overlap_payload())
        expected = self.effective()
        other_id = 'reverse-order'
        other_folder = self.root / 'site/clips' / other_id
        other_folder.mkdir(parents=True)
        (other_folder / 'source.mp4').write_bytes(self.source.read_bytes())
        original = copy.deepcopy(self.motion)
        for frame in original['frames']:
            frame['people'].reverse()
        admin.onboarding.save(other_folder / 'motion.json', original)
        entry = copy.deepcopy(self.entry)
        entry.update(id=other_id, video=f'site/clips/{other_id}/source.mp4', motion=f'site/clips/{other_id}/motion.json')
        catalog = admin.catalog()
        catalog['lessons'].append(entry)
        admin.onboarding.save(admin.CATALOG, catalog)
        state = admin.saved()
        state['staged'].append(other_id)
        admin.save_state(state)
        payload = self.overlap_payload()
        payload['revision'] = corrections.get(admin, other_id)['revision']
        payload['corrections'].reverse()
        corrections.save(admin, other_id, payload)
        result = json.loads((other_folder / 'motion.json').read_text(encoding='utf-8'))
        self.assertEqual(result['frames'], expected['frames'])
        self.assertEqual(result['people'], expected['people'])

    def test_invalid_overlap_policy_is_rejected_and_policy_cannot_allow_empty_participants(self):
        for policy in ('automatic', '', None, True, [], {}):
            with self.subTest(policy=policy):
                payload = self.overlap_payload()
                payload['overlapPolicy'] = policy
                with self.assertRaises(ValueError):
                    corrections.save(admin, self.clip, payload)
                self.assertEqual(self.motion_path.read_bytes(), self.original_bytes)
        payload = self.overlap_payload()
        for row in payload['corrections']:
            row['targetId'] = None
        with self.assertRaises(ValueError):
            corrections.save(admin, self.clip, payload)
        self.assertEqual(self.motion_path.read_bytes(), self.original_bytes)

    def test_omitted_or_duplicate_source_rows_are_rejected(self):
        for mutation in ('omitted', 'duplicate'):
            with self.subTest(mutation=mutation):
                payload = self.merge_payload()
                if mutation == 'omitted':
                    payload['corrections'].pop()
                else:
                    payload['corrections'].append(copy.deepcopy(payload['corrections'][0]))
                with self.assertRaises(ValueError):
                    corrections.save(admin, self.clip, payload)

    def test_bad_ids_and_trim_bounds_are_rejected(self):
        cases = [('sourceId', True), ('sourceId', 999), ('targetId', True), ('targetId', 0),
                 ('targetId', 101), ('targetId', '1'), ('startFrame', -1), ('startFrame', 1.5),
                 ('startFrame', True), ('endFrame', 9), ('endFrame', 0), ('endFrame', '8')]
        for key, value in cases:
            with self.subTest(key=key, value=value):
                payload = self.merge_payload()
                payload['corrections'][0][key] = value
                with self.assertRaises(ValueError):
                    corrections.save(admin, self.clip, payload)

    def test_stale_revision_cannot_overwrite_newer_selection(self):
        stale = self.merge_payload()
        corrections.save(admin, self.clip, stale)
        before = (self.motion_path.read_bytes(), admin.CATALOG.read_bytes())
        for row in stale['corrections']:
            if row['targetId'] is not None:
                row['name'] = 'Stale overwrite'
        with self.assertRaises(ValueError):
            corrections.save(admin, self.clip, stale)
        self.assertEqual((self.motion_path.read_bytes(), admin.CATALOG.read_bytes()), before)

    def test_reset_and_correction_only_edits_still_advance_revision(self):
        initial = self.payload()
        corrections.save(admin, self.clip, self.merge_payload())
        reset = {'revision': corrections.get(admin, self.clip)['revision'],
                 'corrections': initial['corrections']}
        corrections.save(admin, self.clip, reset)
        self.assertNotEqual(corrections.get(admin, self.clip)['revision'], initial['revision'])
        with self.assertRaises(ValueError):
            corrections.save(admin, self.clip, initial)
        corrections.save(admin, self.clip, self.merge_payload())
        before = self.payload()
        name_only = copy.deepcopy(before)
        next(row for row in name_only['corrections'] if row['sourceId'] == 4)['name'] = 'Excluded background person'
        corrections.save(admin, self.clip, name_only)
        self.assertNotEqual(corrections.get(admin, self.clip)['revision'], before['revision'])
        with self.assertRaises(ValueError):
            corrections.save(admin, self.clip, before)

    def test_original_is_preserved_across_repeated_edits_and_reset(self):
        default = self.payload()['corrections']
        corrections.save(admin, self.clip, self.merge_payload())
        private = admin.DATA / 'track-corrections' / self.clip
        backup = private / 'source-motion.json'
        first_backup = backup.read_bytes()
        next_payload = self.merge_payload()
        for row in next_payload['corrections']:
            if row['targetId'] is not None:
                row['name'] = 'Renamed participant'
        corrections.save(admin, self.clip, next_payload)
        state = corrections.get(admin, self.clip)
        self.assertEqual(state['motion'], self.motion)
        self.assertEqual({track['id'] for track in state['tracks']}, {1, 2, 3, 4})
        self.assertEqual(backup.read_bytes(), first_backup)
        corrections.save(admin, self.clip, {'revision': state['revision'], 'corrections': default})
        self.assertEqual({key: self.effective()[key] for key in self.motion}, self.motion)
        self.assertEqual(backup.read_bytes(), first_backup)
        self.assertGreaterEqual(len(list((private / 'history').glob('*/audit.json'))), 3)

    def test_changed_source_video_requires_new_tracking(self):
        payload = self.merge_payload()
        self.source.write_bytes(b'New source video with mismatched tracking')
        with self.assertRaises(ValueError):
            corrections.save(admin, self.clip, payload)
        self.assertEqual(self.motion_path.read_bytes(), self.original_bytes)

    def test_busy_and_running_reconstruction_prevent_corrections(self):
        payload = self.merge_payload()
        admin.BUSY.acquire()
        try:
            with self.assertRaises(ValueError):
                corrections.save(admin, self.clip, payload)
        finally:
            admin.BUSY.release()
        path = admin.reconstruction.record_path(admin, self.clip)
        path.parent.mkdir(parents=True, exist_ok=True)
        admin.onboarding.save(path, {'clipId': self.clip, 'runId': 'active', 'status': 'running'})
        with self.assertRaises(ValueError):
            corrections.save(admin, self.clip, payload)
        self.assertEqual(self.motion_path.read_bytes(), self.original_bytes)

    def test_published_and_unsafe_clip_ids_cannot_be_edited(self):
        payload = self.merge_payload()
        for identity in ('../track-test', 'track-test/../other', '', 'TRACK-TEST'):
            with self.subTest(identity=identity):
                with self.assertRaises(ValueError):
                    corrections.get(admin, identity)
                with self.assertRaises(ValueError):
                    corrections.save(admin, identity, payload)
        admin.save_state({'staged': [], 'preview': None})
        with self.assertRaises(ValueError):
            corrections.save(admin, self.clip, payload)

    def test_clip_folder_symlink_cannot_escape_the_clip_storage_root(self):
        escaped = self.root / 'elsewhere' / self.clip
        escaped.parent.mkdir()
        self.folder.rename(escaped)
        try:
            self.folder.symlink_to(escaped, target_is_directory=True)
        except OSError as error:
            self.skipTest(f'Directory symlink creation unavailable: {error}')
        with self.assertRaises(ValueError):
            corrections.get(admin, self.clip)

    def test_resolved_clip_folder_escape_is_rejected_without_symlink_privileges(self):
        """Simulate the same resolved paths a junction would return on Windows."""
        escaped = self.root / 'elsewhere' / self.clip
        escaped.parent.mkdir()
        self.folder.rename(escaped)
        original_resolve = Path.resolve

        def junction_resolution(path, *args, **kwargs):
            if path.is_relative_to(self.folder):
                path = escaped / path.relative_to(self.folder)
            return original_resolve(path, *args, **kwargs)

        with patch.object(Path, 'resolve', junction_resolution):
            with self.assertRaises(ValueError):
                corrections.get(admin, self.clip)

    def test_unstage_archives_corrections_and_new_clip_can_reuse_id_with_fresh_original(self):
        corrections.save(admin, self.clip, self.merge_payload())
        private = admin.DATA / 'track-corrections' / self.clip
        original_backup = (private / 'source-motion.json').read_bytes()
        with patch.object(admin, 'git', return_value=SimpleNamespace(stdout='')):
            admin.unstage(self.clip)
        self.assertFalse(private.exists())
        self.assertFalse(self.folder.exists())
        archived = list((admin.DATA / 'unstaged').glob(f'*/track-corrections/{self.clip}/source-motion.json'))
        self.assertEqual(len(archived), 1)
        self.assertEqual(archived[0].read_bytes(), original_backup)
        self.folder.mkdir(parents=True)
        self.source.write_bytes(b'Fresh staged video')
        fresh = copy.deepcopy(self.motion)
        fresh['width'] = 1920
        admin.onboarding.save(self.motion_path, fresh)
        entry = copy.deepcopy(self.entry)
        entry['sourceSha256'] = admin.digest(self.source)
        admin.onboarding.save(admin.CATALOG, {'lessons': [entry]})
        admin.save_state({'staged': [self.clip], 'preview': None})
        self.assertEqual(corrections.get(admin, self.clip)['motion'], fresh)
        corrections.save(admin, self.clip, self.merge_payload())
        self.assertEqual(json.loads((private / 'source-motion.json').read_text(encoding='utf-8')), fresh)
        self.assertEqual(archived[0].read_bytes(), original_backup)

    def test_saved_corrections_invalidate_scene_review_room_and_preview(self):
        scene = self.folder / 'scene.json'
        scene.write_text('{"frames":[],"fixture":"old scene"}', encoding='utf-8')
        environment = self.folder / 'environment.json'
        environment.write_text('{"id":"old-room","asset":"studio.splat"}', encoding='utf-8')
        splat = self.folder / 'studio.splat'
        splat.write_bytes(b'old room scan fixture')
        catalog = admin.catalog()
        catalog['lessons'][0].update(scene=f'site/clips/{self.clip}/scene.json',
                                     environment=f'site/clips/{self.clip}/environment.json')
        admin.onboarding.save(admin.CATALOG, catalog)
        path = admin.reconstruction.record_path(admin, self.clip)
        path.parent.mkdir(parents=True, exist_ok=True)
        old_review = {'clipId': self.clip, 'runId': 'approved-run', 'status': 'ready', 'reviewed': True,
                      'sceneSha256': admin.digest(scene), 'reviewUrl': '/old-review'}
        admin.onboarding.save(path, old_review)
        corrections.save(admin, self.clip, self.merge_payload())
        entry = admin.catalog()['lessons'][0]
        self.assertNotIn('scene', entry)
        self.assertNotIn('environment', entry)
        self.assertIsNone(admin.saved()['preview'])
        current = json.loads(path.read_text(encoding='utf-8')) if path.exists() else {}
        self.assertFalse(current.get('reviewed'))
        self.assertNotEqual(current.get('status'), 'ready')
        self.assertNotIn('reviewUrl', current)
        private = admin.DATA / 'track-corrections' / self.clip
        archived = [file for file in (private / 'history').rglob('*') if file.is_file()]
        self.assertTrue(any(file.name == 'scene.json' for file in archived))
        self.assertTrue(any(file.name == 'environment.json' for file in archived))
        self.assertEqual(self.source.read_bytes(), b'Unchanged staged footage fixture')

    def prepared_reconstruction(self):
        """Make a one-second corrected clip so the real handoff guards execute."""
        self.motion['frames'] = [
            {'frame': frame, 'people': [self.detection(1 if frame < 16 else 2, frame),
                                       self.detection(3, frame)] + ([self.detection(4, frame)] if frame == 6 else [])}
            for frame in range(32)]
        self.motion['sourceEnd'] = self.motion['sourceStart'] + 32 / 30
        admin.onboarding.save(self.motion_path, self.motion)
        corrections.save(admin, self.clip, self.merge_payload())

    def execute_reconstruction(self, during_worker=None):
        runtime = admin.reconstruction
        output = admin.DATA / 'reconstruction' / self.clip / 'test-run'
        process = Mock(stdout=[], returncode=0)
        process.poll.return_value = 0

        def start_worker(*args, **kwargs):
            if during_worker:
                during_worker()
            admin.onboarding.save(output / 'scene.json', {'fixture': 'worker output'})
            return process

        def attach(clip_id, scene, internal=False):
            admin.onboarding.save(self.folder / 'scene.json', scene)

        with patch.object(admin.onboarding, 'gpu_paused', return_value=False), \
                patch.object(runtime, 'runtime_state', return_value={'ready': True}), \
                patch.object(runtime, 'check', return_value={'status': 'ready'}), \
                patch.object(runtime, 'command', return_value=['mock-worker']), \
                patch.object(runtime.subprocess, 'Popen', side_effect=start_worker), \
                patch.object(admin, 'job', side_effect=lambda kind, action: action('test-run', {})), \
                patch.object(admin, 'attach_scene', side_effect=attach) as attached, \
                patch.object(admin, 'make_preview', return_value={'url': '/test-preview/'}):
            result = runtime.reconstruct(admin, self.clip, {})
        return output, result, attached

    def test_reconstruction_worker_receives_only_corrected_tracks(self):
        self.prepared_reconstruction()
        effective = self.effective()
        output, result, attached = self.execute_reconstruction()
        snapshot = json.loads((output / 'motion.json').read_text(encoding='utf-8'))
        manifest = json.loads((output / 'manifest.json').read_text(encoding='utf-8'))
        self.assertEqual(snapshot, effective)
        self.assertEqual(manifest['participants'], {'1': 'Instructor'})
        self.assertEqual(manifest['sourceStart'], self.motion['sourceStart'])
        self.assertEqual(manifest['sourceEnd'], self.motion['sourceEnd'])
        self.assertEqual(manifest['frames'], 32)
        self.assertEqual(result['status'], 'complete')
        attached.assert_called_once()
        self.assertEqual(attached.call_args.args[1]['motionSha256'], admin.digest(self.motion_path))

    def test_tracking_changed_during_inference_prevents_stale_scene_attachment(self):
        self.prepared_reconstruction()

        def change_tracking():
            motion = self.effective()
            motion['frames'][0]['people'] = []
            admin.onboarding.save(self.motion_path, motion)

        with self.assertRaisesRegex(ValueError, 'tracking changed'):
            self.execute_reconstruction(during_worker=change_tracking)
        self.assertFalse((self.folder / 'scene.json').exists())
        run = json.loads(admin.reconstruction.record_path(admin, self.clip).read_text(encoding='utf-8'))
        self.assertEqual(run['status'], 'failed')

    def test_approval_and_publication_reject_scene_for_different_tracking(self):
        scene = self.folder / 'scene.json'
        scene.write_text('{"frames":[]}', encoding='utf-8')
        state = {'clipId': self.clip, 'runId': 'reviewed-run', 'status': 'ready', 'reviewed': True,
                 'sceneSha256': admin.digest(scene), 'motionSha256': admin.digest(self.motion_path)}
        path = admin.reconstruction.record_path(admin, self.clip)
        path.parent.mkdir(parents=True, exist_ok=True)
        admin.onboarding.save(path, state)
        admin.reconstruction.publish_check(admin, [self.clip])
        motion = self.effective()
        motion['frames'][0]['people'] = []
        admin.onboarding.save(self.motion_path, motion)
        with self.assertRaisesRegex(ValueError, 'tracking changed'):
            admin.reconstruction.approve(admin, self.clip, {'reviewed': True, 'runId': 'reviewed-run'})
        with self.assertRaisesRegex(ValueError, 'tracking changed'):
            admin.reconstruction.publish_check(admin, [self.clip])


class AtomicJsonSave(unittest.TestCase):
    """Windows sharing locks may be retried without replacing the old JSON early."""
    def setUp(self):
        directory = ROOT / 'outputs/track-correction-tests'
        directory.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=directory)
        self.path = Path(self.temp.name) / 'state.json'
        self.path.write_text('{"old":true}', encoding='utf-8')

    def tearDown(self):
        self.temp.cleanup()

    def test_atomic_save_retries_short_destination_sharing_lock(self):
        original_replace = admin.onboarding.os.replace
        attempts = []

        def locked_then_ready(source, destination):
            attempts.append((source, destination))
            if len(attempts) < 3:
                self.assertEqual(json.loads(self.path.read_text(encoding='utf-8')), {'old': True})
                raise PermissionError('Destination temporarily open')
            return original_replace(source, destination)

        with patch.object(admin.onboarding.os, 'replace', side_effect=locked_then_ready), \
                patch.object(admin.onboarding.time, 'sleep') as sleep:
            admin.onboarding.save(self.path, {'new': True})
        self.assertEqual(len(attempts), 3)
        self.assertEqual(sleep.call_count, 2)
        self.assertEqual(json.loads(self.path.read_text(encoding='utf-8')), {'new': True})
        self.assertFalse(self.path.with_suffix('.tmp').exists())

    def test_persistent_destination_lock_reports_failure_and_preserves_old_json(self):
        with patch.object(admin.onboarding.os, 'replace', side_effect=PermissionError('Still locked')) as replace, \
                patch.object(admin.onboarding.time, 'sleep') as sleep:
            with self.assertRaisesRegex(PermissionError, 'Still locked'):
                admin.onboarding.save(self.path, {'new': True})
        self.assertEqual(replace.call_count, 5)
        self.assertEqual(sleep.call_count, 4)
        self.assertEqual(json.loads(self.path.read_text(encoding='utf-8')), {'old': True})

    def test_other_filesystem_errors_are_reported_without_retry(self):
        with patch.object(admin.onboarding.os, 'replace', side_effect=FileNotFoundError('Missing directory')) as replace, \
                patch.object(admin.onboarding.time, 'sleep') as sleep:
            with self.assertRaises(FileNotFoundError):
                admin.onboarding.save(self.path, {'new': True})
        replace.assert_called_once()
        sleep.assert_not_called()


class TrackCorrectionRoutes(unittest.TestCase):
    """The participant editor shares admin's local-only and CSRF protection."""
    @staticmethod
    def handler(path, body=None, **headers):
        import server
        handler = object.__new__(server.Handler)
        handler.path = path
        handler.client_address = ('127.0.0.1', 50001)
        handler.server = SimpleNamespace(server_port=8771)
        raw = json.dumps(body).encode() if body is not None else b''
        handler.headers = {'Host': '127.0.0.1:8771', 'Content-Length': str(len(raw)),
                           'Content-Type': 'application/json', **headers}
        handler.rfile = io.BytesIO(raw)
        handler.send_json = Mock()
        return server, handler

    def test_get_dispatches_locally_and_blocks_remote_peer(self):
        server, handler = self.handler('/api/admin/clips/track-test/tracks')
        with patch.object(corrections, 'get', return_value={'revision': 'fixture'}) as get:
            server.Handler.do_GET(handler)
            get.assert_called_once_with(admin, 'track-test')
        handler.client_address = ('192.168.1.40', 50001)
        with patch.object(corrections, 'get') as get:
            server.Handler.do_GET(handler)
            get.assert_not_called()
        self.assertEqual(handler.send_json.call_args.args[1], 403)

    def test_post_requires_token_and_origin_before_saving(self):
        body = {'revision': 'fixture', 'corrections': []}
        for extra in ({}, {'Origin': 'http://127.0.0.1:8771'},
                      {'Origin': 'https://other.example', 'X-Systema-Admin-Token': admin.TOKEN}):
            with self.subTest(headers=extra):
                server, handler = self.handler('/api/admin/clips/track-test/tracks', body, **extra)
                with patch.object(corrections, 'save') as save:
                    server.Handler.do_POST(handler)
                    save.assert_not_called()
                self.assertEqual(handler.send_json.call_args.args[1], 403)
        server, handler = self.handler('/api/admin/clips/track-test/tracks', body,
                                      **{'Origin': 'http://127.0.0.1:8771', 'X-Systema-Admin-Token': admin.TOKEN})
        with patch.object(corrections, 'save', return_value={'message': 'saved'}) as save:
            server.Handler.do_POST(handler)
            save.assert_called_once_with(admin, 'track-test', body)


if __name__ == '__main__':
    unittest.main(verbosity=2)

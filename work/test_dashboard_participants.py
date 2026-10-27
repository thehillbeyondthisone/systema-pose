"""CPU-only checks that exported 3D observations match reviewed participants."""
import builtins
import copy
from pathlib import Path
import sys
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'work'))
import dashboard_3d_worker as worker
import run_3d_pilot as exporter


class ExportParticipants(unittest.TestCase):
    def setUp(self):
        self.motion = {'people': [{'id': 4, 'name': 'Instructor'}, {'id': 6, 'name': 'Partner'}],
                       'frames': [{'frame': frame, 'people': [{'id': identity, 'bbox': [10, 20, 30, 40]}
                                  for identity in (4, 6)]} for frame in range(3)]}
        self.scene = {'people': copy.deepcopy(self.motion['people']),
                      'jointNames': [f'joint-{index}' for index in range(22)],
                      'frames': [{'frame': frame, 'people': [
                          {'id': identity, 'xyz': [[float(identity), float(frame), float(joint)] for joint in range(22)]}
                          for identity in (4, 6)]} for frame in range(3)]}

    def test_exact_ids_accept_integer_subclasses_and_order_changes(self):
        class TrackerInteger(int):
            pass
        self.assertEqual(worker.validate_participant_ids([TrackerInteger(6), TrackerInteger(4)], self.motion),
                         {4: 'Instructor', 6: 'Partner'})

    def test_ids_reject_missing_extra_duplicate_boolean_and_non_integer_values(self):
        for identities in ([4], [4, 6, 9], [4, 6, 6], [True, 6], [4.0, 6], ['4', 6], [None, 6], []):
            with self.subTest(identities=identities):
                with self.assertRaises(ValueError):
                    worker.validate_participant_ids(identities, self.motion)

    def test_valid_scene_preserves_measured_coordinates_and_participant_ids(self):
        before = copy.deepcopy(self.scene)
        self.assertIs(worker.validate_participants(self.scene, self.motion), self.scene)
        self.assertEqual(self.scene, before)

    def test_scene_metadata_cannot_hide_a_missing_or_duplicate_result_identity(self):
        for identities in ([4], [4, 4, 6], [4, 6, 9]):
            with self.subTest(identities=identities):
                scene = copy.deepcopy(self.scene)
                scene['people'] = [{'id': identity} for identity in identities]
                with self.assertRaises(ValueError):
                    worker.validate_participants(scene, self.motion)

    def test_each_selected_participant_needs_two_actual_3d_observations(self):
        scene = copy.deepcopy(self.scene)
        for frame in scene['frames'][1:]:
            frame['people'] = [person for person in frame['people'] if person['id'] != 6]
        with self.assertRaisesRegex(ValueError, 'Partner.*ID 6: 1 frame'):
            worker.validate_participants(scene, self.motion)
        scene['frames'][1]['people'].append(copy.deepcopy(self.scene['frames'][1]['people'][1]))
        worker.validate_participants(scene, self.motion)

    def test_per_frame_unknown_duplicate_and_boolean_ids_are_rejected(self):
        for identity in (9, 4, True):
            with self.subTest(identity=identity):
                scene = copy.deepcopy(self.scene)
                extra = copy.deepcopy(scene['frames'][0]['people'][0])
                extra['id'] = identity
                scene['frames'][0]['people'].append(extra)
                with self.assertRaises(ValueError):
                    worker.validate_participants(scene, self.motion)

    def test_joint_vectors_require_three_finite_numeric_coordinates(self):
        for point in ([float('nan'), 0, 0], [0, float('inf'), 0], [True, 0, 0], ['1', 0, 0], [1, 2], None):
            with self.subTest(point=point):
                scene = copy.deepcopy(self.scene)
                scene['frames'][0]['people'][0]['xyz'][0] = point
                with self.assertRaises(ValueError):
                    worker.validate_participants(scene, self.motion)

    def test_joint_count_and_missing_skeleton_are_rejected(self):
        scene = copy.deepcopy(self.scene)
        scene['frames'][0]['people'][0]['xyz'].pop()
        with self.assertRaises(ValueError):
            worker.validate_participants(scene, self.motion)
        scene = copy.deepcopy(self.scene)
        scene['jointNames'] = []
        with self.assertRaises(ValueError):
            worker.validate_participants(scene, self.motion)

    def test_annotation_checks_actual_results_before_reference_metadata_can_be_applied(self):
        annotation = Mock()
        scene = copy.deepcopy(self.scene)
        scene['people'].pop()
        with patch.dict(sys.modules, {'annotate_3d_quality': SimpleNamespace(annotate_tracking_quality=annotation)}):
            with self.assertRaisesRegex(ValueError, 'Missing: Partner'):
                worker.annotate(scene, self.motion)
        annotation.assert_not_called()

    def test_export_rejects_missing_result_ids_before_importing_gpu_dependencies(self):
        original_import = builtins.__import__
        gpu_imports = []

        def guarded_import(name, *args, **kwargs):
            if name.split('.')[0] in ('numpy', 'torch', 'smplx'):
                gpu_imports.append(name)
                raise AssertionError('GPU import happened before participant validation')
            return original_import(name, *args, **kwargs)

        with patch('builtins.__import__', side_effect=guarded_import):
            with self.assertRaisesRegex(ValueError, 'Missing: Partner'):
                exporter.export_scene(None, {'people': {4: {'track_id': 4}}}, None, {}, reference_motion=self.motion)
        self.assertEqual(gpu_imports, [])


if __name__ == '__main__':
    unittest.main(verbosity=2)

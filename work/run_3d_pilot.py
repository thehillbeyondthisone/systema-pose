"""Run inside the prepared PromptHMR Linux environment; never synthesize depth from XY."""
import argparse
import hashlib
import json
import os
import platform
import sys
from pathlib import Path

from prepare_3d_pilot import BODY_MODELS

ROOT = Path(__file__).resolve().parent.parent


def preflight(repo, input_path, output):
    manifest = json.loads((output / 'manifest.json').read_text(encoding='utf-8'))
    with input_path.open('rb') as stream:
        actual = hashlib.file_digest(stream, 'sha256').hexdigest()
    if actual != manifest['sha256']:
        raise ValueError('The staged input changed. Run prepare_3d_pilot.py again.')
    missing = [p for p in BODY_MODELS if not (repo / p).is_file()]
    issues = []
    if platform.system() != 'Linux':
        issues.append('The documented world-video wheels require a prepared Linux environment.')
    if missing:
        issues.append('Missing body-model assets:\n' + '\n'.join(missing))
    for relative in ['data/pretrain/phmr/checkpoint.ckpt', 'data/pretrain/phmr/config.yaml', 'data/pretrain/phmr_vid/prhmr_release_002.ckpt',
                     'data/pretrain/phmr_vid/prhmr_release_002.yaml', 'data/pretrain/vitpose-h-coco_25.pth',
                     'data/pretrain/camcalib_sa_biased_l2.ckpt', 'data/pretrain/droidcalib.pth',
                     'data/pretrain/sam2_ckpts/sam2_hiera_tiny.pt', 'data/pretrain/sam2_ckpts/keypoint_rcnn_5ad38f.pkl']:
        if not (repo / relative).is_file():
            issues.append('Missing reconstruction checkpoint: ' + relative)
    if issues:
        raise ValueError('\n\n'.join(issues))
    return manifest


def export_scene(pipeline, results, output, manifest, reviewed_identities=False, reference_motion=None):
    """Export final world pose parameters as joints; all people retain shared translations."""
    import numpy as np
    import torch
    from smplx import SMPLX
    from smplx.joint_names import JOINT_NAMES
    model = SMPLX('data/body_models/smplx/SMPLX_NEUTRAL.npz', use_pca=False, flat_hand_mean=True, num_betas=10).cuda().eval()
    if not results['people']:
        raise ValueError('No participants were reconstructed; an empty scene cannot be accepted.')
    if abs(float(pipeline.fps) - manifest['fps']) > 0.001:
        raise ValueError('Reconstruction FPS does not match the verified source timeline.')
    frame_count = len(results['camera_world']['Rwc'])
    if frame_count != manifest['frames']:
        raise ValueError(f'Reconstruction returned {frame_count} frames; expected {manifest["frames"]}.')
    frames = [{'frame': i, 'sourceTime': manifest['sourceStart'] + i / pipeline.fps, 'people': []} for i in range(frame_count)]
    people_meta = []
    for key, track in results['people'].items():
        world = track['smplx_world']
        indices = np.asarray(track['frames'], dtype=int)
        pose = np.asarray(world['pose']).reshape(len(indices), 55, 3)
        shape = np.asarray(world['shape']).reshape(len(indices), -1)
        translation = np.asarray(world['trans']).reshape(len(indices), 3)
        track_id = int(track['track_id'])
        matched = reviewed_identities or reference_motion is not None
        reference_id = track_id if matched else None
        name = manifest['participants'][str(track_id)] if matched else f'Reconstructed person {track_id}'
        palette = ['#ffc45f', '#7bc7ed', '#bda4ee', '#94d8b8']
        people_meta.append({'id': track_id, 'name': name, 'reference2dId': reference_id,
                            'color': palette[(track_id - 1) % len(palette)] if matched else None})
        for start in range(0, len(indices), 16):
            stop = min(len(indices), start + 16)
            aa = torch.as_tensor(pose[start:stop], dtype=torch.float32, device='cuda')
            with torch.no_grad():
                joints = model(global_orient=aa[:, 0], body_pose=aa[:, 1:22].reshape(-1, 63),
                               jaw_pose=aa[:, 22], leye_pose=aa[:, 23], reye_pose=aa[:, 24],
                               left_hand_pose=aa[:, 25:40].reshape(-1, 45), right_hand_pose=aa[:, 40:55].reshape(-1, 45),
                               betas=torch.as_tensor(shape[start:stop], dtype=torch.float32, device='cuda'),
                               expression=torch.zeros((stop - start, model.num_expression_coeffs), dtype=torch.float32, device='cuda'),
                               transl=torch.as_tensor(translation[start:stop], dtype=torch.float32, device='cuda')).joints[:, :22].cpu().numpy()
            if not np.isfinite(joints).all():
                raise ValueError('Reconstruction produced nonfinite joint positions.')
            for i, xyz in zip(indices[start:stop], joints):
                if i < 0 or i >= frame_count:
                    raise ValueError('Track frame is outside the source timeline.')
                identity_status = 'identity_from_reviewed_2d_tracks' if matched else 'identity_unreviewed'
                frames[i]['people'].append({'id': track_id, 'xyz': xyz.tolist(), 'reviewed': False,
                                            'status': ['monocular_depth_estimate', identity_status, 'contact_unreviewed']})
    parent = model.parents[:22].cpu().tolist()
    scene = {'schemaVersion': 1, 'coordinateSpace': 'world-3d', 'units': 'model-meters', 'upAxis': 'y',
             'scaleVerified': False, 'reviewed': False, 'fps': float(pipeline.fps),
             'sourceStart': manifest['sourceStart'], 'sourceEnd': manifest['sourceEnd'],
             'sourceSha256': manifest['sha256'], 'jointNames': JOINT_NAMES[:22],
             'edges': [[int(p), i] for i, p in enumerate(parent) if p >= 0],
             'people': people_meta, 'frames': frames,
             'camera': {key: np.asarray(results['camera_world'][key]).tolist()
                        for key in ['Rwc', 'Twc', 'Rcw', 'Tcw', 'img_focal', 'img_center']},
             'method': 'PromptHMR world-video reconstruction',
             'identityMapping2d': {str(track_id): track_id for track_id in [p['id'] for p in people_meta]} if matched else None}
    if reference_motion is not None:
        from dashboard_3d_worker import annotate
        annotate(scene, reference_motion)
        scene['people'] = reference_motion['people']
    elif reviewed_identities:
        from annotate_3d_quality import annotate_tracking_quality
        annotate_tracking_quality(scene, ROOT / 'outputs/pilot/poses-tracked.jsonl')
    scene_path = output / 'scene.json'
    temp = scene_path.with_suffix('.tmp')
    temp.write_text(json.dumps(scene, allow_nan=False, separators=(',', ':')), encoding='utf-8')
    temp.replace(scene_path)
    manifest['status'] = 'reconstructed_awaiting_review'
    manifest['reconstruction']['hasRun'] = True
    manifest['scene'] = scene_path.name
    (output / 'manifest.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--repo', type=Path, default=ROOT / 'work' / 'PromptHMR')
    parser.add_argument('--output', type=Path, default=ROOT / 'outputs' / '3d-pilot')
    parser.add_argument('--input', default='multiple-attackers-18-30.mp4')
    parser.add_argument('--reference-motion', type=Path)
    parser.add_argument('--check', action='store_true')
    parser.add_argument('--reconstruction-subdir', default='reconstruction')
    parser.add_argument('--expected-participants', type=int)
    parser.add_argument('--reviewed-identities', action='store_true')
    parser.add_argument('--image-batch-size', type=int, default=2,
                        help='Frames per image-model batch; 2 limits memory on the 12 GB GPU.')
    parser.add_argument('--static-camera', action='store_true', help='Only use after reviewing the camera motion.')
    args = parser.parse_args()
    repo, output = args.repo.resolve(), args.output.resolve()
    if Path(args.input).name != args.input:raise ValueError('Input must be a filename inside the run folder.')
    input_path = output / args.input
    try:
        manifest = preflight(repo, input_path, output)
        if args.check:
            print('Required files and platform checks passed. CUDA and dependency imports still need validation.')
            return
        os.chdir(repo)
        sys.path.insert(0, str(repo))
        import torch
        if not torch.cuda.is_available():
            raise ValueError('A CUDA GPU is required by the selected reconstruction pipeline.')
        if not 1 <= args.image_batch_size <= 16:
            raise ValueError('Image batch size must be between 1 and 16.')
        from pipeline import Pipeline
        from pipeline import phmr_vid
        import open_clip
        import torch.utils.data
        import pipeline.pipeline as pipeline_module

        # The main checkpoint contains the complete CLIP text encoder and is
        # loaded with strict=True upstream. Avoid downloading a second full
        # image/text backbone that would immediately be overwritten.
        original_create_model = open_clip.create_model
        def checkpoint_clip_model(model_name, *model_args, **model_kwargs):
            if model_name == 'ViT-L-14-quickgelu' and model_kwargs.get('pretrained') == 'metaclip_fullcc':
                model_kwargs['pretrained'] = None
            return original_create_model(model_name, *model_args, **model_kwargs)
        open_clip.create_model = checkpoint_clip_model

        # Upstream depth inference uses batches of eight large images. Keep
        # the same model and frames while fitting the 12 GiB GPU.
        original_metric_slam = pipeline_module.run_metric_slam
        def memory_bounded_metric_slam(*slam_args, **slam_kwargs):
            original_loader = torch.utils.data.DataLoader
            def small_depth_loader(*loader_args, **loader_kwargs):
                if 'batch_size' in loader_kwargs:
                    loader_kwargs['batch_size'] = min(loader_kwargs['batch_size'], args.image_batch_size)
                return original_loader(*loader_args, **loader_kwargs)
            torch.utils.data.DataLoader = small_depth_loader
            try:
                return original_metric_slam(*slam_args, **slam_kwargs)
            finally:
                torch.utils.data.DataLoader = original_loader
        pipeline_module.run_metric_slam = memory_bounded_metric_slam
        original_loader = phmr_vid.DataLoader

        def bounded_image_loader(*loader_args, **loader_kwargs):
            loader_kwargs['batch_size'] = args.image_batch_size
            return original_loader(*loader_args, **loader_kwargs)

        phmr_vid.DataLoader = bounded_image_loader
        manifest['reconstruction']['imageBatchSize'] = args.image_batch_size
        manifest['reconstruction']['gpu'] = torch.cuda.get_device_name(0)
        manifest['reconstruction']['depthBatchSize'] = args.image_batch_size
        manifest['reconstruction']['clipWeights'] = 'complete encoder from main checkpoint; strict state loading retained'
        pipeline = Pipeline(static_cam=args.static_camera)
        reference_motion = None
        if args.reference_motion:
            from dashboard_3d_worker import bind_tracks, install_progress
            reference_motion = json.loads(args.reference_motion.read_text(encoding='utf-8'))
            bind_tracks(pipeline, reference_motion)
            install_progress(pipeline, output)
        elif args.reviewed_identities:
            import joblib
            import numpy as np
            from types import MethodType
            from pipeline.utils import interpolate_bboxes
            reference = ROOT / 'outputs/pilot/poses-tracked.jsonl'
            reference_rows = [json.loads(line) for line in reference.read_text(encoding='utf-8').splitlines()]
            assert [row['source_frame_index'] for row in reference_rows] == list(range(540, 900))
            camera_cache = joblib.load(output / 'reconstruction-all-four/results.pkl')
            assert len(camera_cache['camera']['pred_cam_R']) == manifest['frames']
            def reviewed_tracks(instance):
                height, width = instance.images[0].shape[:2]
                tracks = {}
                for participant_id in range(1, 5):
                    indices, boxes = [], []
                    for index, row in enumerate(reference_rows):
                        people = [person for person in row['people'] if person.get('track_id') == participant_id]
                        assert len(people) <= 1
                        if people:
                            box = np.asarray(people[0]['bbox_xyxy'], dtype=np.float32)
                            box *= np.array([width / row['width'], height / row['height']] * 2)
                            box[[0, 2]] = np.clip(box[[0, 2]], 0, width - 1)
                            box[[1, 3]] = np.clip(box[[1, 3]], 0, height - 1)
                            if box[2] > box[0] and box[3] > box[1]:
                                indices.append(index)
                                boxes.append(box)
                    boxes, indices = interpolate_bboxes(np.asarray(boxes), np.asarray(indices))
                    # This required dataset field carries no segmentation
                    # information. Mask prompts are explicitly disabled below.
                    unused_masks = np.broadcast_to(np.zeros((1, 1, 1), dtype=np.bool_), (len(indices), height, width))
                    tracks[participant_id] = {'track_id': participant_id, 'bbox_format': 'x1y1x2y2',
                                              'frames': indices, 'bboxes': boxes, 'masks': unused_masks}
                instance.results['people'] = tracks
                instance.results['has_tracks'] = True
                instance.results['camera'] = camera_cache['camera']
                instance.results['spec_calib'] = camera_cache['spec_calib']
                instance.results['has_slam'] = True
                print('Using reviewed 2D identities and boxes for all four participants; camera estimate reused.')
            pipeline.run_detect_track = MethodType(reviewed_tracks, pipeline)
            pipeline.cfg.tracker = 'reviewed_2d'
            manifest['reconstruction']['tracking'] = 'reviewed 2D identity tracks, interpolated boxes, fresh ViTPose keypoints'
            manifest['reconstruction']['maskPrompts'] = False
        if Path(args.reconstruction_subdir).name != args.reconstruction_subdir:
            raise ValueError('Reconstruction subdirectory must be a simple folder name.')
        reconstruction_output = output / args.reconstruction_subdir
        results = pipeline(str(input_path), str(reconstruction_output), static_cam=args.static_camera, save_only_essential=True)
        if args.expected_participants is not None and len(results['people']) != args.expected_participants:
            raise ValueError(f"Expected {args.expected_participants} participants, reconstructed {len(results['people'])}.")
        export_scene(pipeline, results, output, manifest, args.reviewed_identities, reference_motion)
        print('Shared XYZ scene exported. Source/side/overhead and contact review are still required.')
    except (ValueError, FileNotFoundError) as failure:
        print(str(failure), file=sys.stderr)
        raise SystemExit(2)


if __name__ == '__main__':
    main()

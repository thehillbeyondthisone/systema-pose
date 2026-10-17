"""Preserve reconstructed XYZ while exposing the source tracking limitations."""
import json
from pathlib import Path


def annotate_tracking_quality(scene, reference_path):
    rows = reference_path if isinstance(reference_path, list) else [json.loads(line) for line in Path(reference_path).read_text(encoding='utf-8').splitlines()]
    assert len(rows) == len(scene['frames'])
    for frame, row in zip(scene['frames'], rows):
        observed = {p['track_id']: p for p in row['people'] if p['track_id'] > 0}
        for person in frame['people']:
            reference = observed.get(person['id'])
            person['sourceTrackPresent'] = reference is not None
            person['sourceBoxInterpolated'] = reference is None
            overlap_ids = []
            if reference:
                a = reference['bbox_xyxy']
                area_a = max(0, a[2] - a[0]) * max(0, a[3] - a[1])
                for other_id, other in observed.items():
                    if other_id == person['id']:
                        continue
                    b = other['bbox_xyxy']
                    intersection = max(0, min(a[2], b[2]) - max(a[0], b[0])) * max(0, min(a[3], b[3]) - max(a[1], b[1]))
                    area_b = max(0, b[2] - b[0]) * max(0, b[3] - b[1])
                    # This is box overlap, not a measurement of limb visibility.
                    if intersection / max(1, min(area_a, area_b)) >= .6:
                        overlap_ids.append(other_id)
            person['overlappingSourceBoxes'] = overlap_ids
            if reference is None:
                person['status'].append('source_tracking_gap_interpolated')
            if overlap_ids:
                person['status'].append('source_box_overlap_needs_review')
    scene['qualityAnnotation'] = 'Faded poses use interpolated tracking boxes or source boxes overlapping at least 60% of the smaller box; visibility and contact remain unverified.'
    return scene


if __name__ == '__main__':
    root = Path(__file__).resolve().parent.parent
    path = root / 'outputs/3d-pilot/scene.json'
    scene = json.loads(path.read_text(encoding='utf-8'))
    for frame in scene['frames']:
        for person in frame['people']:
            person['status'] = [s for s in person['status'] if s not in ('source_tracking_gap_interpolated', 'source_box_overlap_needs_review')]
    annotate_tracking_quality(scene, root / 'outputs/pilot/poses-tracked.jsonl')
    path.write_text(json.dumps(scene, allow_nan=False, separators=(',', ':')), encoding='utf-8')

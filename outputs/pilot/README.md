# Systema 2D pilot

Source interval: 18.000–30.000 seconds, source frames 540–899 (zero based), 360 frames at 30 fps.

Open `index.html` in a desktop browser, or open the running local viewer at http://127.0.0.1:8766/. It offers play/pause, frame stepping, participant selection, overlay visibility, confidence thresholds, enlarged poses and transparent still export. All processing and playback are local.

## Files

- `overlay-review.mp4`: original footage with skeleton overlays and source audio.
- `source-reference.mp4`: frame-accurate pilot reference without overlays.
- `transparent-frames/000000.png` through `000359.png`: full-frame 1920×1080 straight-alpha RGBA master, import at 30 fps and place at source time 18 seconds.
- `skeleton-alpha-prores4444.mov`: 30 fps ProRes 4444 alpha export. True alpha verified by decoding; import in the user's editor still needs testing.
- `enlarged-instructor.mp4`: dark-background review of the instructor's enlarged 2D pose.
- `illustration-frames/`: 1080×1440 transparent instructor images. 53 frames are deliberately empty because no instructor track was assigned; no pose was invented for those frames.
- `teaching-stills/`: clean transparent skeletons and labeled source overlays at seven sampled moments. These are visual references, not claims about force or weight transfer.
- `poses-raw.jsonl`: native COCO-WholeBody 133-joint detections, confidence, timestamps, source pixels and crop transforms.
- `poses-tracked.jsonl`: same estimates plus four participant IDs, uncertainty flags and unassigned detections retained as ID 0. ID 0 is excluded from renders.
- `identity-anchors.json`: visually inspected frame/detection identity assignments and participant descriptions.
- `tracking-events.json`, `review-notes.json`: unresolved tracking events and visual observations.
- `manifest.json`, `validation.json`, `viewer-validation.json`: source/model hashes, versions, timings and completed file/browser checks.

## Review status

The instructor is gold (T1), grey-shirt participant cyan (T2), blue-shirt participant magenta (T3), and white-shirt participant green (T4). Four IDs replace the initial automatic tracker, which fragmented people during crossings. Identity anchors and 36 intermediate samples were inspected. This is a review pilot; frame-by-frame identity and anatomical accuracy have not passed final acceptance.

Severe overlap around 21–25 seconds can attach estimated shoulders or arms to another body. Partial visibility also affects the start and 29–30 seconds. Confidence is model confidence, not ground-truth visibility. Faded bones have scores below 0.55; scores below 0.35 are omitted. High-confidence mistakes remain possible. Raw data is preserved; no temporal smoothing, interpolation or manual joint correction was applied.

The enlarged view fits the instructor bounding box independently each frame; changing detection boxes can change apparent scale. The interactive viewer uses one transform for a selected pair, retaining relative 2D placement. Neither produces reconstructed 3D depth.

## Verified

The original MP4 SHA-256 is unchanged. The full source decodes to 2,756 frames. Both PNG sequences contain 360 valid RGBA frames, and all three rendered videos decode to 360 frames at 30 fps. Source timestamp error is below one source time-base tick. PNG and decoded ProRes alpha were checked, with preview composites on light, dark and checkerboard backgrounds. Browser playback, stepping, selection and transparent export passed without JavaScript errors.

Extraction took 35.15 seconds and tracking/rendering took 94.11 seconds. These exclude installation, visual review and final exports. This pilot's exports initially used about 274 MiB before the reference video and review page were added; the isolated runtime/models/work files used about 1.15 GiB. See the manifest for the final measured footprint. A simple full-clip timing extrapolation is about 4.5 minutes of inference and 12 minutes of tracking/rendering, plus review and export work; this is not a promise and does not estimate manual correction effort.

## Reproduce

Project scripts are in `../../work/`. Dependencies are isolated in `../../work/runtime/`; no global Python, driver or unrelated app was modified. `../../work/installed-packages.json` contains the pinned install report and model paths/hashes are in `../../work/models/manifest.json`.

Use the Python runtime recorded in `../../work/runtime-info.json` and run these commands from the project root:

```text
<python> work/bootstrap.py extract_pilot.py
<python> work/bootstrap.py render_pilot.py
<python> work/bootstrap.py verify_pilot.py
<python> work/bootstrap.py make_review_viewer.py
<python> -m http.server 8766 --bind 127.0.0.1 --directory outputs/pilot
```

The source path is recorded in `../../work/source-metadata.json`. Rendering regenerates estimates from the existing raw data and overwrites this pilot's generated exports. Identity anchors are intentionally specific to this pilot; inspect new footage before extending them.

## Remaining plan

Review this pilot's style and accuracy before expanding to the full clip. Correct critical occluded/contact joints and tracking assignments where useful. Test PNG/MOV import in the intended editor. Resolve the 3D candidate, applicable licenses, supported Linux environment, storage location and gated model access. Then produce reviewed XYZ data, an orbitable scene and a rotated teaching render. No 3D reconstruction has been installed or generated in this continuation.

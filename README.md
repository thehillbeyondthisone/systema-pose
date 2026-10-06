# Systema Pose

A local movement study workspace for watching prepared video lessons, comparing
2D and 3D motion estimates, and adding personal text annotations.
Students can request a video by link; the teacher reviews and processes requests
on the workstation.

## Start the sample lesson

Install Python 3.10 or newer. Viewing the included sample and saving annotations
use the Python standard library; no pose models, GPU, npm build, or Python
packages are required.

On Windows, double-click `quickstart.bat`. It starts the server with LAN access
and prints the addresses for this computer and other devices on the same network.

For access only from this computer, run from the repository root:

```powershell
py -3 teaching_suite/server.py
```

On systems with `python3`, use `python3 teaching_suite/server.py` instead.
Open http://127.0.0.1:8770/ and choose **Explore the sample lesson**.

Use **Watch**, **Study motion**, and **Annotate** to switch workspaces. Pause at a
moment and choose **Add annotation** to attach text to a participant,
body part, or scene point. **Views → Explore in 3D** opens the sample's synchronized
orbitable scene.

In the 3D viewer, enable **Contact effects** to draw bones with visible thickness.
Intersecting bones glow yellow and orange spots identify their intersection
regions. The test uses 3D bone capsules between distinct visible participants,
including endpoint spheres; screen overlap alone cannot trigger it. **Bone
thickness** changes both the visible shapes and their intersection bounds.
Effects follow the current frame, participant visibility, and playback; choices
are remembered in the browser. This is available for the included 3D sample.
These intersections describe the reconstruction, not verified physical contact,
force, strikes, grabs, or a participant's felt body position.

The repository includes the 12-second sample reference video, 2D motion data,
3D skeleton scene, and vendored Three.js viewer with its license and provenance.
The server creates its initial sample prompts and local storage on first launch.

## Personal data and local files

Annotations and video requests are stored under `teaching_suite/data/`.
A persistent browser cookie identifies the student; there are no accounts or
cross-device sign-in. Return using the same browser and server address to find
your annotations. Back up this folder separately if the data matters.

`SYSTEMA_DATA_DIR` can select a different data folder. Published lesson copies
are stored separately in `teaching_suite/published/`. Both folders are excluded
from Git, along with installed runtimes, model weights, caches, and generated
exports. Committing the project does not back up these local files.

Annotations are text-only and work over HTTP on the local network. Older audio
files remain on disk, but recording, attachments, and audio playback are removed.
The current server is a local/LAN prototype. A hosted
service would need authentication, teacher authorization, and HTTPS.

## Prepare new footage

Viewing saved lessons does not require the processing runtime. Preparing new
videos requires the existing project-local dependencies in `work/runtime/`,
FFmpeg through `imageio_ffmpeg`, and detector/pose models described by
`work/models/manifest.json`. These are not bundled in Git. `work/download_models.py`
downloads the 2D model archives and writes a manifest for their local paths.

On a workstation with that runtime configured:

```powershell
py -3 teaching_suite/manage_requests.py list
py -3 teaching_suite/manage_requests.py process REQUEST_ID "C:\Videos\movement.mp4" --passage 80 95
```

Submission only saves a request. The teacher obtains the footage and runs
processing. Up to 12 non-overlapping passages and 90 seconds total are supported.
See [the workspace guide](teaching_suite/README.md) for the complete workflow.

3D reconstruction uses a separate PromptHMR/WSL setup. The scripts in `work/`
retain the original workstation paths and assumptions; they are not a portable
installer. Registered SMPL/SMPL-X body-model assets and model checkpoints are
excluded. Consult the applicable model terms before setting up reconstruction.
The included scene contains saved skeleton estimates, not the body-model assets.

## Project layout

- `teaching_suite/`: Python server, request manager, processing worker, and browser UI.
- `work/`: processing, review, setup, and browser verification scripts.
- `outputs/pilot/`: sample video and the original 2D pilot notes.
- `outputs/3d-pilot/`: sample scene, reconstruction provenance, and original review notes.
- `quickstart.bat`: Windows launcher.

The pilot notes describe the full local investigation, including artifacts that
are not bundled in this repository. Only the selected sample assets above are
included.

## Verification

The existing browser checks are `work/verify_student_workspace.cjs` and
`work/verify_view_selection.cjs`. They cover personal annotations, video requests,
view preferences, playback preservation, responsive layouts, and 3D navigation.
The scripts currently use the original workstation's Python and Playwright paths.
The view-selection check expects an isolated server on port 8772, or a URL supplied
through `SYSTEMA_TEST_URL`. Reports and screenshots are generated locally under
`outputs/` and excluded from Git.

Run `node work/verify_contact_geometry.cjs` for the intersection geometry checks,
including 3D crossings, separated depth, parallel bones, endpoints, and
zero-length bones. The view-selection checks also exercise contact visibility,
thickness, remembered settings, and independence from camera angle.

These checks use emulated device sizes. They do not
establish real iPad Safari compatibility or pose accuracy. Depth, metric scale,
identity tracking during overlap, and contact remain estimates; compare the
skeleton with the source footage when interpreting movement.

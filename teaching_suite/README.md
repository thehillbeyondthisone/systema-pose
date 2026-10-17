# Systema student workspace

Students explore prepared movement lessons and add their own text annotations. Annotations appear in a panel beside the footage, with a thin yellow line to a selected joint, participant or scene point during the annotation's source time range. The line follows the available motion estimate. If a participant is hidden or the target estimate is unavailable, the annotation remains in the side panel and its target is labeled unavailable. Overlapping annotations share a scrollable panel, with personal annotations first.

Double-click `quickstart.bat` to start the suite for this computer and other devices on the same LAN. The launcher prints the URLs. For local-only access, run `py -3 teaching_suite/server.py` and open http://127.0.0.1:8770/.

## Student workflow

1. Open a prepared lesson from the home page, or choose **Explore the sample lesson**. Choose **Watch** for footage, **Study motion** for skeletons over the footage, or **Annotate** to show the annotation panels.
2. Pause or scrub to a moment and choose **Add annotation**.
3. Tap a body part or scene point, then enter a title and source time range. The participant and body-part menus let you adjust the target.
4. Write your observation, then choose **Save annotation**.
5. Open an annotation to read or listen, edit or delete your own annotation, replay its passage, or loop it at a slower speed.

There is one student interface. Existing class links also open this workspace and allow personal annotations. Shared lesson notes and sample prompts stay available; students edit their own annotations.

**Views** opens a bottom sheet on phones and a compact dialog on tablets and computers. Choose footage, footage with motion, or motion only, and independently show **At this moment** and **All annotations**. Watch and Study give the movement the full viewer width; Annotate shows both annotation panels. New browsers start in Study. View choices are remembered in this browser across lessons; playback position, speed and selected participants stay unchanged when switching views. Adding an annotation opens its panels, and the editor remains visible until that draft is saved or cancelled. The chooser remains reachable while scrolling. Tablet landscape and desktop layouts place the annotation list beside the viewer; narrower screens put it below.

When available, **Explore in 3D** appears beside the view controls and inside Views. The 3D workspace offers **3D scene**, **Footage**, and **Compare**, plus Front, Side and Overhead camera angles. One shared player controls both views, including source audio, and stays above secondary scene settings. It remembers the selected layout and keeps playback available when footage is hidden. Opening the scene and returning to the lesson preserves the current source frame.

Selecting an annotation highlights its passage on the timeline and seeks to its beginning. Main playback remains the full clip until you choose **Play passage** or **Loop passage**. The player labels passage mode and offers **Play full clip** to continue from the current frame. Scrubbing or stepping frames returns to full-clip mode.

Personal annotations are saved on the lesson server under `teaching_suite/data/students/<browser-id>/`. A persistent, HttpOnly browser cookie identifies each browser. Separate browsers have separate annotation collections, including on the same lesson. Use the same browser and server address to return to your annotations. Clearing the cookie, using a private window, changing devices or changing the server hostname creates a different identity. This prototype does not have student accounts or cross-device sign-in. Text annotation works over HTTP on the local network. Recording, audio attachments, and audio playback are removed; older files remain on disk. An older annotation without text can be edited to add an explanation.

**Contact effects** in the sample's 3D viewer highlights intersecting bone shapes between distinct visible participants. Bones are drawn as capsules, with thickness shared by the rendering and intersection test. The test uses the reconstructed XYZ joints, so a crossing in screen space with separated depth does not trigger it. Yellow bones and orange spots follow the current frame; hide a participant to remove their contacts. **Bone thickness** adjusts the shapes, and both settings are remembered. These are model intersections. Interpret strikes, grabs, and sustained contact by reviewing the source footage; the geometry does not establish physical force or felt proprioception.

## Request a video

On the home page, students enter their name, a request title and an HTTP or HTTPS video link. They can also identify a passage and describe what they want to study. **Submit video request** saves it for the teacher to review and process. Students can refresh their own requests to see **Awaiting review**, **Being processed**, **Lesson ready** or **Closed**. A ready request links directly to its prepared lesson.

Requests are saved as JSON under `teaching_suite/data/video-requests/`. Submission saves the request; it does not download the video, start pose extraction or send an email. The teacher manages this local queue from the workstation.

## Process the request queue

For videos already saved on this workstation, double-click
`quickstart-admin.bat` to open the local dashboard at
`http://127.0.0.1:8771/admin`. It imports footage, prepares selected 2D passages,
stages reviewed clips, runs the installed GPU reconstruction, opens synchronized
3D review, builds a public preview, and publishes through Git. The workstation
panel checks GPU operations, dependencies, model files and disk reserves. Each
3D run has progress, a local log, cancel/retry, and a separate review approval.
Startup and installed-package checks use no GPU. GPU use starts paused; enable
it explicitly when available, or pause it to keep 2D tracking on the CPU. Draft
details and passages are remembered per video in this browser.
Room calibration is not copied from the sample. See the
[publishing workflow](../site/README.md#local-video-dashboard).

The commands below remain an alternative for the student request queue.

Run these commands from the project root, using the same Python interpreter as the server:

```powershell
py -3 teaching_suite/manage_requests.py list
```

This shows each request ID, student's name, video URL, requested passage and message. Save the requested footage locally, then prepare selected passages with source times in seconds:

```powershell
py -3 teaching_suite/manage_requests.py process REQUEST_ID "C:\Videos\movement.mp4" --passage 80 95 --passage 110 120
```

The command normalizes playback, processes the selected passages with the existing pose worker and links the finished lesson to the request. It runs until preparation finishes; keep the command open. At most 12 non-overlapping passages and 90 seconds total are supported. Original footage must be MP4, MOV, M4V or WebM, under 500 MB and at most two hours. Prepared lessons appear in the student library. The existing `work/runtime`, FFmpeg through `imageio_ffmpeg` and `work/models/manifest.json` are required for processing.

For manual processing or an already prepared lesson:

```powershell
py -3 teaching_suite/manage_requests.py status REQUEST_ID processing
py -3 teaching_suite/manage_requests.py status REQUEST_ID ready --lesson LESSON_ID
py -3 teaching_suite/manage_requests.py status REQUEST_ID declined
```

A request can only be marked ready when its linked lesson is ready. The processing command retains failure logs and leaves a failed request awaiting review so it can be retried. Preparation files are saved under `teaching_suite/data/lessons/<id>/`. New videos use automatic spatial tracking: person numbers can change between passages or after overlaps. Compare motion estimates against source footage.

## Verification

`work/test_dashboard_reconstruction.py` verifies GPU pause, requirements checks,
failure recovery and exact-scene review gates without GPU execution.
`work/verify_video_admin.py` exercises real uploads, CPU-only tracking, draft
restoration, saved-scene review controls, preview and publication against an
isolated local Git remote. Its browser disables GPU acceleration and WebGL.
The full reconstruction check is separate:
`work/verify_dashboard_3d.py --allow-gpu`. Run that only when the GPU is available;
it has been deferred while the GPU is reserved for other work.

`work/verify_view_selection.cjs` checks the view presets, independent panels, saved preferences, unchanged playback and participants, draft visibility, keyboard focus, storage failures, and 3D navigation/playback. It checks portrait and landscape phones, iPad sizes, desktop, and a 320px phone for overflow and touch targets. Run it against an isolated lesson server on port 8772, or set `SYSTEMA_TEST_URL`. Screenshots and `validation.json` are in `outputs/view-selection/`. These are browser-emulated layout checks; they do not establish live iPad Safari compatibility.

`work/verify_student_workspace.cjs` runs the updated workflow with Edge/Playwright against an isolated data directory. It verifies link validation and saved requests, processing statuses and lesson links, separate student identities, safe text, joint and scene targets, annotation timing, moving yellow lines, overlapping annotations, edits and deletion, text-only validation, disabled audio endpoints, prepared lessons and existing class links. It also checks desktop, landscape tablet, portrait tablet and phone widths for horizontal overflow and JavaScript errors. Screenshots and `validation.json` are in `outputs/student-workspace/`.

The browser checks use emulated device widths. They do not establish pose accuracy or live iPad Safari compatibility. The historical onboarding and teaching-suite scripts test the previous upload, audio, and instructor/class-copy workflows.

The separate shared 3D scene remains available from the sample lesson when reconstruction data is present. Annotations attach to the synchronized footage and its 2D motion estimates.

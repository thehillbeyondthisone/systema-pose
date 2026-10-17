# Shareable class viewer

The static viewer works on GitHub Pages without running Python on the host.
It includes the clip library, video, 2D motion, optional 3D scenes and model
contact effects. Personal text annotations use browser storage, with JSON
backup and restore inside each lesson. No student data is bundled or uploaded.
Clearing site data removes that browser's notes; downloaded backups preserve them.
The viewer has no accounts, shared annotation service or video request queue.

Build from the project root with Python 3.10+:

```powershell
py -3 work/build_pages.py
py -3 work/preview_pages.py
```

Open http://localhost:8780/. The build also works under a repository subpath,
such as `/systema-pose-viewer/`. Use an empty output folder for every build;
the script refuses to mix a new release with old files. `dist/` is ignored.

## Add a prepared clip

### Local video dashboard

Double-click `quickstart-admin.bat` on the workstation. It opens
`http://127.0.0.1:8771/admin`. The admin page and its write API accept only
loopback connections; they are excluded from the GitHub Pages build.

1. **Import footage.** MP4, MOV, M4V or WebM, under 500 MB and two hours. The
   original stays in the private local data directory.
2. **Choose passages and prepare.** Select up to 12 non-overlapping passages,
   90 seconds total. The existing worker generates 2D tracking and reports progress.
3. **Review footage and motion.** Check participant identities and overlaps, then
   approve the selected passages for public sharing.
4. **Stage reviewed passages.** Each passage becomes a trimmed public clip with
   its own video, tracking, poster, stable ID and original source time range.
   Unselected footage, student notes and original uploads are excluded.
   **Unstage** backs out before publication and preserves the exported files locally.
5. **Reconstruct 3D.** The workstation panel checks the installed `Systema3D`
   WSL environment, Python packages, model files and disk space without using
   the GPU. Choose **Enable & check GPU** when it is available to validate CUDA
   operations, imports and body-model forward passes.
   On a staged passage of at least one second, choose **Reconstruct 3D**.
   Leave camera-motion estimation enabled unless the footage is from a fixed
   tripod. The real PromptHMR pipeline retains reviewed 2D participant IDs,
   estimates a fresh camera, reconstructs shared XYZ motion and fits the floor.
   It does not reuse the sample's camera or room calibration. Follow its phase
   and local log; **Cancel** preserves the source and each retry has a new run
   folder. Reconstruction keeps an 8 GiB reserve on the project/runtime drives.
6. **Review 3D scene.** The synchronized source and orbit viewer opens inside
   the dashboard. Check source, side and overhead views, identity continuity,
   hidden limbs and foot placement, then save the 3D review. Publication checks
   the exact reviewed scene hash. Depth, scale and contact remain estimates.
   Import a Gaussian PLY, .splat, or SHARE export folder under **Room scans**.
   Attach it to the passage, build a preview, adjust **Studio alignment**, then
   choose **Save room placement from review**. Build a fresh final preview.
   New room placements are labelled estimates; exact matching needs calibration.
   Existing matching scene JSON can still be imported under **Advanced**.
7. **Build and review the public preview.** This uses the actual Pages builder.
8. **Publish reviewed clips.** The dashboard commits only the staged clip assets
   (including its compact room scan) and catalog, then pushes to `main` using the workstation's GitHub connection.
   GitHub Actions deploys the update. Unrelated workspace changes and a stale
   preview block publishing. The activity log distinguishes a successful push
   from the subsequent Pages deployment.

The dashboard uses the installed local runtime and model files; it does not
download processing models or remote video links. Keep the server running while
preparation or publication jobs are active. `manage_requests.py` remains available
for requested videos and command-line processing.

Installed-requirement checks run on startup and through **Check installed
requirements**, using the CPU. GPU use starts paused by default; the pause is
saved across restarts, and 2D tracking uses the CPU while paused. **Pause GPU
use** stops accelerated jobs and blocks new reconstruction. Videos are preserved;
interrupted 2D preparation can be retried on the CPU. Only **Enable & check
GPU** authorizes GPU validation, which also runs before a reconstruction.
Missing packages, model files,
GPU support or storage are listed in diagnostics; the check does not silently
install packages or accept model licenses. This workstation already has the
dedicated runtime and licensed body models from the sample reconstruction.
Private reconstruction intermediates/logs are under
`teaching_suite/data/admin/reconstruction/<clip-id>/<run-id>/`; only the matched
scene and selected clip assets are eligible for publication. After a server
restart, interrupted workers are stopped and their runs can be retried.

Lesson details and draft passages are remembered in this browser when switching
videos or refreshing. Once tracking is prepared, the server's locked passage
times remain authoritative. Sharing approvals are not restored automatically.

### Prepared files and manual publishing

1. Process the video on the teacher workstation using the existing request
   workflow. Review participant tracking and skeleton alignment.
2. Copy just its prepared `source.mp4` and `motion.json` into a new folder such
   as `site/clips/footwork/`. These are the video excerpt and motion data that
   viewers will download. Do not copy annotations, requests or original private
   footage. GitHub repositories reject individual files larger than 100 MiB.
3. Add an entry to `site/lessons.json`, using a unique lowercase ID, a title,
   description, category (`Training`, `Sparring` or `Fight`), tags, relative asset
   paths, `frameMapping: "frame"`, and the reviewed participant names/colors.
   The `people` list can be omitted when it is already in the motion file.
   `frameMapping: "index"` is only for dense older motion files whose frame
   numbers refer to the original untrimmed footage.
4. Optionally set `poster` to a JPEG, PNG or WebP still. Without a poster the
   library previews the first skeleton frame. Optionally set `scene` to a
   reconstructed world-3D scene whose SHA-256 and timing match the video.
   2D-only clips do not offer a 3D link.
5. Build and preview the site, then commit the reviewed catalog and clip assets.

Each new video hash gets its own annotation storage. Clip IDs should remain
stable. Backups are tied to the exact clip and cannot be accidentally restored
onto another clip. Restoring merges notes and preserves conflicting observations.

## GitHub Pages

The source repository can remain private. A separate public repository can
contain only the generated static site. Its sample video and motion data are
then public downloads. Publish only footage suitable for public sharing.

For a public source repository or a paid account supporting private-source
Pages, the example `pages-workflow.yml` can be placed in `.github/workflows/`.
Choose **GitHub Actions** under Settings → Pages. Every push to `main` will
build and deploy the allowlisted site. Pages supplies HTTPS automatically.

For a separate public viewer repository, copy the contents of `dist/` to its
root, commit them and select **Deploy from a branch → main → /(root)** under
Settings → Pages. Future releases replace that generated site. Keep the private
source and student data out of the viewer repository.

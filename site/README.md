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

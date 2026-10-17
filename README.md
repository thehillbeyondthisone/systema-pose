# Systema Pose

A movement study viewer for watching Systema lessons, exploring motion in 2D and
3D, and keeping personal notes.

**[Open the live movement library](https://thehillbeyondthisone.github.io/systema-pose/)**

[Explore the scanned studio in 3D](https://thehillbeyondthisone.github.io/systema-pose/scene.html?clip=multiple-attackers) with animated participants and a camera matched to the footage.

## Explore a lesson

- Watch the footage and step through it frame by frame.
- Compare participants and spacing with the motion overlays or rotatable 3D view.
- Swap skeletons for rigged figures and create replayable strike illustrations.
- Explore likely strike locations and relative motion intensity in slow motion.
- Try the included free characters from the character library.
- Rename characters by editing their names above the style selectors.
- Add notes to a moment or passage, then replay that passage to study it.
- Back up your notes from inside the lesson and restore them later.

The live viewer works in your browser with no installation. Notes, strike cues,
and uploaded models stay in that browser. Export your notes/cues and keep the
original model files before clearing site data or switching devices.
Press **backtick** or use Debug for rigged model uploads (up to 65 MB) and raw
contact diagnostics.
Motion, likely strikes, and contact effects are estimates; compare them with the
original footage. Strike intensity reflects relative motion, not measured force.

## Run locally

With Python 3.10 or newer installed, double-click `quickstart.bat`, then open the
address it displays. The local version also lets students request videos for a
teacher to prepare. Notes and requests are saved on your computer.

## Add lessons or contribute

Double-click `quickstart-admin.bat` for the local video dashboard. Import a video,
choose passages, prepare 2D tracking, review, then preview and publish. 3D scenes
come from the separate GPU reconstruction step and can be attached before publishing.

See the [publishing guide](site/README.md) to add prepared clips, or the
[workspace guide](teaching_suite/README.md) for local teaching and processing.
Updates pushed to `main` automatically rebuild and publish the live library.

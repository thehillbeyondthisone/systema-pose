# Systema Pose

A movement study viewer for watching Systema lessons, exploring motion in 2D and
3D, and keeping personal notes.

**[Open the live movement library](https://thehillbeyondthisone.github.io/systema-pose/)**

[Explore the scanned studio in 3D](https://thehillbeyondthisone.github.io/systema-pose/scene.html?clip=multiple-attackers) with animated participants and a camera matched to the footage.

## Explore a lesson

- Watch the footage and step through it frame by frame.
- Compare participants and spacing with the motion overlays or rotatable 3D view.
- Swap skeletons for rigged figures and create replayable strike illustrations.
- Add your own rigged humanoid `.glb` models and switch them during playback.
- Add notes to a moment or passage, then replay that passage to study it.
- Back up your notes from inside the lesson and restore them later.

The live viewer works in your browser with no installation. Notes, strike cues,
and uploaded models stay in that browser. Export your notes/cues and keep the
original model files before clearing site data or switching devices.
Motion and contact effects are estimates; compare them with the original footage.

## Run locally

With Python 3.10 or newer installed, double-click `quickstart.bat`, then open the
address it displays. The local version also lets students request videos for a
teacher to prepare. Notes and requests are saved on your computer.

## Add lessons or contribute

See the [publishing guide](site/README.md) to add prepared clips, or the
[workspace guide](teaching_suite/README.md) for local teaching and processing.
Updates pushed to `main` automatically rebuild and publish the live library.

"""Build an allowlisted, server-free class viewer for GitHub Pages.

Only assets explicitly listed in site/lessons.json enter the output. Student
data, requests, workstation metadata and model runtimes are never copied.
"""
import argparse
import hashlib
import json
import math
from pathlib import Path
import re
import shutil

ROOT = Path(__file__).resolve().parents[1]
PUBLIC = ROOT / 'teaching_suite' / 'public'
ASSETS = ('custom-figure.js', 'model-library.js', 'figure-rig.js', 'scene-navigation.js', 'source-camera.mjs', 'contact-shadows.js', 'strike-cues.js', 'strike-estimates.mjs', 'strike-placement.js', 'studio-environment.js', 'studio-lighting.js', 'studio-registration.mjs', 'app.js', 'style.css', 'annotations.css', 'views.css', 'scene.js',
          'scene.css', 'contact_geometry.mjs', 'site-data.js', 'library.js', 'library.css')


def read_json(path):
    return json.loads(path.read_text(encoding='utf-8'))


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False), encoding='utf-8')


def asset_path(value):
    path = (ROOT / value).resolve()
    if not path.is_relative_to(ROOT) or not path.is_file():
        raise ValueError(f'Asset must be a file inside the project: {value}')
    return path


def check_timing(data):
    start, end, fps = (data[key] for key in ('sourceStart', 'sourceEnd', 'fps'))
    if not all(isinstance(value, (int, float)) and math.isfinite(value) for value in (start, end, fps)):
        raise ValueError('Motion timing must be finite numbers')
    if not 0 <= start < end or not 0 < fps <= 240:
        raise ValueError('Invalid motion timing')
    return math.ceil((end - start) * fps - 1e-7)


def poster_svg(motion, people):
    """A portable preview made from the actual first pose frame, with no video decode dependency."""
    edges = [(5, 6), (5, 7), (7, 9), (6, 8), (8, 10), (5, 11), (6, 12),
             (11, 12), (11, 13), (13, 15), (12, 14), (14, 16)]
    colors = {person['id']: person['color'] for person in people}
    elements = []
    for person in motion['frames'][0]['people']:
        color = colors[person['id']]
        points = person['xy']
        for a, b in edges:
            if min(person['confidence'][a], person['confidence'][b]) < .35:
                continue
            x1, y1 = points[a]
            x2, y2 = points[b]
            elements.append(f'<path d="M{x1:.1f} {y1:.1f}L{x2:.1f} {y2:.1f}" stroke="{color}"/>')
        for point, confidence in zip(points[:17], person['confidence'][:17]):
            if confidence >= .35:
                elements.append(f'<circle cx="{point[0]:.1f}" cy="{point[1]:.1f}" r="8" fill="{color}" stroke="none"/>')
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {motion["width"]} {motion["height"]}">'
            '<rect width="100%" height="100%" fill="#142234"/>'
            '<g fill="none" stroke-width="9" stroke-linecap="round">' + ''.join(elements) + '</g></svg>')


def build_characters(output):
    """Publish reviewed characters and their credits; browser uploads stay local."""
    character_root = (PUBLIC / 'characters').resolve()
    catalog = read_json(character_root / 'catalog.json')
    if not isinstance(catalog, dict) or catalog.get('schemaVersion') != 1 or not isinstance(catalog.get('models'), list):
        raise ValueError('Invalid built-in character catalog')
    seen = set()
    for item in catalog['models']:
        identity = item['id']
        if not re.fullmatch(r'builtin-[a-z0-9]+(?:-[a-z0-9]+)*', identity) or identity in seen:
            raise ValueError('Invalid or duplicate built-in character ID')
        seen.add(identity)
        if not all(item.get(key) for key in ('name', 'creator', 'source', 'license', 'licenseUrl')):
            raise ValueError('Every built-in character needs source and license credits')
        source = (PUBLIC / item['file']).resolve()
        if not source.is_relative_to(character_root) or source.suffix != '.glb' or not source.is_file():
            raise ValueError('Built-in characters must be GLBs inside public/characters')
        if source.stat().st_size > 50 * 1024 * 1024:
            raise ValueError('Built-in character exceeds the viewer file limit')
        if item.get('sha256') and hashlib.sha256(source.read_bytes()).hexdigest() != item['sha256']:
            raise ValueError(f'Character hash does not match its reviewed catalog: {identity}')
        target = output / source.relative_to(PUBLIC.resolve())
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
        if item.get('preview'):
            preview = (PUBLIC / item['preview']).resolve()
            if not preview.is_relative_to(character_root) or preview.suffix.lower() not in ('.png', '.jpg', '.webp') or not preview.is_file():
                raise ValueError('Character previews must be images inside public/characters')
            target = output / preview.relative_to(PUBLIC.resolve())
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(preview, target)
    (output / 'characters').mkdir(exist_ok=True)
    write_json(output / 'characters/catalog.json', catalog)
    for source in character_root.rglob('*'):
        if source.is_file() and source.suffix.lower() in ('.md', '.txt'):
            target = output / 'characters' / source.relative_to(character_root)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, target)


def build(output, config_path):
    config = read_json(config_path)
    if output.exists() and any(output.iterdir()):
        raise ValueError(f'Output must be empty to avoid publishing stale assets: {output}')
    output.mkdir(parents=True, exist_ok=True)
    for name in ASSETS:
        shutil.copyfile(PUBLIC / name, output / name)
    shutil.copytree(PUBLIC / 'vendor', output / 'vendor')
    build_characters(output)
    (output / 'index.html').write_text((PUBLIC / 'library.html').read_text(encoding='utf-8'), encoding='utf-8')
    lesson_html = (PUBLIC / 'index.html').read_text(encoding='utf-8')
    lesson_html = lesson_html.replace('<script src="app.js"', '<link rel="stylesheet" href="library.css"><script src="site-data.js" defer></script><script src="app.js"')
    lesson_html = lesson_html.replace('href="/onboarding.html"', 'href="./"').replace('Lessons &amp; video requests', 'Lesson library')
    lesson_html = lesson_html.replace('src="media/source-reference.mp4"', '').replace('href="/scene.html"', 'href="scene.html"')
    (output / 'lesson.html').write_text(lesson_html, encoding='utf-8')
    scene_html = (PUBLIC / 'scene.html').read_text(encoding='utf-8')
    scene_html = scene_html.replace('<script type="module" src="scene.js">', '<script src="site-data.js"></script><script type="module" src="scene.js">')
    scene_html = scene_html.replace('src="media/source-reference.mp4"', '').replace('href="/?demo=1"', 'href="./"')
    (output / 'scene.html').write_text(scene_html, encoding='utf-8')
    (output / '.nojekyll').write_text('', encoding='utf-8')
    entries = []
    seen = set()
    for item in config['lessons']:
        slug = item['id']
        if not re.fullmatch(r'[a-z0-9]+(?:-[a-z0-9]+)*', slug) or slug in seen:
            raise ValueError(f'Invalid or duplicate clip ID: {slug}')
        seen.add(slug)
        if item['category'] not in ('Training', 'Sparring', 'Fight'):
            raise ValueError('Category must be Training, Sparring, or Fight')
        folder = output / 'lessons' / slug
        folder.mkdir(parents=True)
        video = asset_path(item['video'])
        sha = hashlib.sha256(video.read_bytes()).hexdigest()
        motion = read_json(asset_path(item['motion']))
        frame_count = check_timing(motion)
        if item.get('frameMapping') not in ('index', 'frame'):
            raise ValueError('Declare frameMapping as index (dense legacy sample) or frame (prepared lessons)')
        clean_motion = {key: motion[key] for key in ('fps', 'sourceStart', 'sourceEnd', 'width', 'height')}
        clean_motion['frames'] = []
        frame_ids = set()
        people = item.get('people') or motion.get('people')
        if not people:
            raise ValueError(f'List the participants for {slug}')
        clean_people = [{key: person[key] for key in ('id', 'name', 'color')} for person in people]
        ids = {person['id'] for person in clean_people}
        if len(ids) != len(people) or any(not isinstance(i, int) or i <= 0 or i > 100 for i in ids):
            raise ValueError('Participant IDs must be distinct integers in 1–100')
        if any(not re.fullmatch(r'#[0-9a-fA-F]{6}', person['color']) for person in clean_people):
            raise ValueError('Participant colors must be six-digit hex colors')
        for index, frame in enumerate(motion['frames']):
            frame_id = index if item['frameMapping'] == 'index' else frame['frame']
            if not isinstance(frame_id, int) or not 0 <= frame_id < frame_count or frame_id in frame_ids:
                raise ValueError('Motion frames must have unique in-range indices')
            frame_ids.add(frame_id)
            clean_frame = {'frame': frame_id, 'people': []}
            for person in frame['people']:
                if person['id'] not in ids:
                    raise ValueError('Motion contains an unlisted participant')
                clean_frame['people'].append({key: person[key] for key in ('id', 'xy', 'confidence')})
            clean_motion['frames'].append(clean_frame)
        if not clean_motion['frames']:
            raise ValueError('Motion has no frames')
        prefix = f'lessons/{slug}/'
        lesson = {'schemaVersion': 2, 'id': slug, 'title': item['title'], 'description': item['description'],
                  'category': item['category'], 'people': clean_people, 'notes': [],
                  'sourceSha256': sha, 'video': prefix + 'source.mp4', 'motion': prefix + 'motion.json',
                  **{key: clean_motion[key] for key in ('sourceStart', 'sourceEnd', 'fps')}}
        if 'videoFrameOffset' in item:
            offset = item['videoFrameOffset']
            if not isinstance(offset, (int, float)) or not math.isfinite(offset) or not 0 <= offset < 1 / motion['fps']:
                raise ValueError('Video frame offset must be shorter than one frame')
            lesson['videoFrameOffset'] = offset
        if 'trimStart' in item or 'trimEnd' in item:
            trim = item.get('trimStart'), item.get('trimEnd')
            if (not all(isinstance(v, (int, float)) and math.isfinite(v) for v in trim)
                    or not lesson['sourceStart'] <= trim[0] < trim[1] <= lesson['sourceEnd']):
                raise ValueError('Trim must be a range inside the clip')
            lesson['trimStart'], lesson['trimEnd'] = trim
        shutil.copyfile(video, folder / 'source.mp4')
        write_json(folder / 'motion.json', clean_motion)
        if item.get('poster'):
            poster = asset_path(item['poster'])
            if poster.suffix.lower() not in ('.jpg', '.jpeg', '.png', '.webp'):
                raise ValueError('Poster must be JPEG, PNG or WebP')
            poster_name = 'poster' + poster.suffix.lower()
            shutil.copyfile(poster, folder / poster_name)
        else:
            poster_name = 'poster.svg'
            (folder / poster_name).write_text(poster_svg(clean_motion, clean_people), encoding='utf-8')
        if item.get('scene'):
            scene = read_json(asset_path(item['scene']))
            if scene['sourceSha256'] != sha or check_timing(scene) != frame_count or any(scene[key] != motion[key] for key in ('sourceStart', 'sourceEnd', 'fps')):
                raise ValueError('3D scene does not match the video and 2D timing')
            scene_keys = ('schemaVersion', 'coordinateSpace', 'units', 'upAxis', 'scaleVerified', 'reviewed',
                          'fps', 'sourceStart', 'sourceEnd', 'sourceSha256', 'jointNames', 'edges', 'people', 'frames', 'qualityAnnotation', 'camera', 'roomCalibration')
            write_json(folder / 'scene.json', {key: scene[key] for key in scene_keys if key in scene})
            write_json(folder / 'manifest.json', {'sha256': sha, 'reconstruction': {'expectedParticipants': len(scene['people'])}})
            lesson.update(scene=prefix + 'scene.json', manifest=prefix + 'manifest.json')
            if item.get('environment'):
                environment_path=asset_path(item['environment'])
                environment=read_json(environment_path)
                studio_asset=(environment_path.parent/environment['asset']).resolve()
                if not studio_asset.is_relative_to(ROOT.resolve()) or not studio_asset.is_file():
                    raise ValueError('Prepare the studio scan with work/prepare_studio.py before building')
                if studio_asset.suffix != '.splat':
                    raise ValueError('The static studio viewer expects a compact .splat asset')
                shutil.copyfile(studio_asset,folder/'studio.splat')
                environment['asset']='studio.splat'
                write_json(folder/'environment.json',environment)
                lesson['environment']=prefix+'environment.json'

        write_json(folder / 'lesson.json', lesson)
        entries.append({key: item[key] for key in ('id', 'title', 'description', 'category', 'tags')} |
                       {'lesson': prefix + 'lesson.json', 'duration': lesson.get('trimEnd', lesson['sourceEnd']) - lesson.get('trimStart', lesson['sourceStart']),
                        'has3d': bool(item.get('scene')), 'poster': prefix + poster_name})
    write_json(output / 'catalog.json', {'title': config['title'], 'lessons': entries})
    print(f'Built {len(entries)} clip(s) in {output}')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=ROOT / 'dist')
    parser.add_argument('--catalog', type=Path, default=ROOT / 'site' / 'lessons.json')
    args = parser.parse_args()
    try:
        build(args.output.resolve(), args.catalog.resolve())
    except (ValueError, KeyError, OSError) as error:
        parser.exit(1, f'Build failed: {error}\n')

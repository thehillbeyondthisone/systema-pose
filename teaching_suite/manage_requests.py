"""Review and process the local video request queue without an instructor UI."""
import argparse
import datetime as dt
import json
from pathlib import Path
import onboarding
import student_data


def now():
    return dt.datetime.now(dt.timezone.utc).isoformat()


def request_path(request_id):
    if len(request_id) != 32 or any(c not in '0123456789abcdef' for c in request_id):
        raise ValueError('Unknown video request.')
    path = student_data.REQUESTS / (request_id + '.json')
    if not path.is_file():
        raise ValueError('Unknown video request.')
    return path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    commands.add_parser('list', help='list requests from all students')
    status = commands.add_parser('status', help='update a request after manual processing')
    status.add_argument('request_id')
    status.add_argument('status', choices=['requested', 'processing', 'ready', 'declined'])
    status.add_argument('--lesson', help='ID of an existing prepared lesson')
    process = commands.add_parser('process', help='prepare a request from a video saved on this workstation')
    process.add_argument('request_id')
    process.add_argument('video', type=Path)
    process.add_argument('--passage', type=float, nargs=2, action='append', required=True, metavar=('START', 'END'))
    args = parser.parse_args()
    if args.command == 'list':
        for request in student_data.requests():
            print(f"{request['id']}  [{request['status']}]  {request['name']}: {request['title']}")
            print(f"  {request['url']}")
            if request['passage']: print(f"  Passage: {request['passage']}")
            if request['message']: print(f"  {request['message']}")
        return
    path = request_path(args.request_id)
    request = json.loads(path.read_text(encoding='utf-8'))
    if args.command == 'status':
        lesson_id = args.lesson or request.get('lessonId')
        if args.status == 'ready':
            if not lesson_id or onboarding.read(lesson_id)['status'] != 'ready':
                raise ValueError('Link a prepared lesson with --lesson before marking the request ready.')
        elif args.lesson:
            onboarding.read(lesson_id)
        request.update(status=args.status, lessonId=lesson_id, updatedAt=now())
        student_data.save(path, request)
        print(f"Request {args.request_id}: {args.status}")
        return
    if request['status'] in {'processing', 'ready'}:
        raise ValueError('This request is already being processed or has a finished lesson.')
    if not args.video.is_file():
        raise ValueError('Save the requested video on this workstation and pass its file path.')
    segments = [{'start':a, 'end':b, 'label':f'Passage {i+1}'} for i,(a,b) in enumerate(args.passage)]
    # Validate the selections before preparing the local video.
    onboarding.passages(segments, max(s['end'] for s in segments))
    with args.video.open('rb') as stream:
        lesson = onboarding.upload(stream, args.video.stat().st_size, args.video.name, now())
    lesson = onboarding.draft(lesson['id'], {'title':request['title'], 'segments':segments}, now())
    request.update(status='processing', lessonId=lesson['id'], updatedAt=now())
    student_data.save(path, request)
    lesson.update(status='queued', message='Preparing the requested video.', progress=0)
    onboarding.save(onboarding.folder(lesson['id'])/'lesson.json', lesson)
    onboarding.run_job(lesson['id'])
    lesson = onboarding.read(lesson['id'])
    request.update(status='ready' if lesson['status']=='ready' else 'requested', updatedAt=now())
    student_data.save(path, request)
    if lesson['status'] != 'ready':
        raise ValueError(lesson['message'])
    print(f"Lesson ready: /?project={lesson['id']}")


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError) as failure:
        raise SystemExit(str(failure))

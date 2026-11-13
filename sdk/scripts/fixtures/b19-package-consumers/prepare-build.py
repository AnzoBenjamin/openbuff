#!/usr/bin/env python3
"""Record a fresh source-stable SDK build for the packed B19 consumers."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import time

ROOT = Path(__file__).resolve().parents[4]
OWNED = ROOT / 'docs/execution/body-roadmap/evidence/B19'


def reference(file):
    return {'path': str(file.relative_to(ROOT)), 'sha256': hashlib.sha256(file.read_bytes()).hexdigest(),
            'bytes': file.stat().st_size}


def write_json(file, value):
    file.write_text(json.dumps(value, indent=2) + '\n')


def snapshot():
    tracked = subprocess.check_output(['git', 'ls-files', 'sdk', 'common', 'packages', 'agents', 'package.json', 'bun.lock'], cwd=ROOT, text=True).splitlines()
    fixture = Path(__file__).parent
    paths = {ROOT / name for name in tracked} | {p for p in fixture.rglob('*') if p.is_file() and '__pycache__' not in p.parts}
    return {'gitHead': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip(),
            'files': {str(p.relative_to(ROOT)): reference(p)['sha256'] for p in sorted(paths) if p.is_file()}}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('output_directory', help='New immutable directory under owned B19 evidence')
    args = parser.parse_args()
    out = (ROOT / args.output_directory).resolve()
    if not out.is_relative_to(OWNED.resolve()):
        parser.error('Build observations must stay under owned B19 evidence')
    version = subprocess.check_output(['bun', '--version'], cwd=ROOT, text=True).strip()
    if version != '1.4.4':
        parser.error('Current build requires Bun 1.4.4; observed ' + version)
    out.mkdir(parents=True, exist_ok=False)
    before = snapshot()
    write_json(out / 'source-before.json', before)
    command = ['bun', 'run', '--cwd', 'sdk', 'build']
    started_at = datetime.now(timezone.utc).isoformat()
    started = time.monotonic()
    timed_out = False
    with (out / 'sdk-build.log').open('wb') as log:
        process = subprocess.Popen(command, cwd=ROOT, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        try:
            code = process.wait(timeout=1800)
        except subprocess.TimeoutExpired:
            timed_out = True
            os.killpg(process.pid, signal.SIGKILL)
            code = process.wait()
    after = snapshot()
    write_json(out / 'source-after.json', after)
    changes = sorted(name for name in set(before['files']) | set(after['files']) if before['files'].get(name) != after['files'].get(name))
    receipt = {'command': command, 'cwd': str(ROOT), 'exitCode': code, 'startedAt': started_at,
               'elapsedSeconds': time.monotonic() - started, 'timedOut': timed_out, 'log': 'sdk-build.log',
               'generatedOutput': 'sdk/dist', 'sourceChangesDuringCommand': changes}
    write_json(out / 'sdk-build-receipt.json', receipt)
    if code != 0 or timed_out or changes:
        print(json.dumps({'status': 'failed', **receipt}))
        return 1
    ready = {'schemaVersion': 1, 'type': 'body-package-build-ready-observation', 'card': 'B19', 'bunVersion': version,
             'executionReceipt': reference(out / 'sdk-build-receipt.json'), 'sourceBefore': reference(out / 'source-before.json'),
             'sourceAfter': reference(out / 'source-after.json'), 'log': reference(out / 'sdk-build.log'),
             'scope': 'Measured current source-stable build; dist independently inventoried by consumer runner'}
    write_json(out / 'build-ready.json', ready)
    print(json.dumps({'status': 'source-stable-build-passed', 'buildReady': reference(out / 'build-ready.json'),
                      'sourceBefore': ready['sourceBefore'], 'elapsedSeconds': receipt['elapsedSeconds']}))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())

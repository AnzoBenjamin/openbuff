#!/usr/bin/env python3
"""Settle only a recorded probe daemon using a verified Linux process handle."""

import hashlib
import json
import os
from pathlib import Path
import signal
import time

BASE = Path(__file__).resolve().parent
ATTEMPT = BASE / 'attempts/20261106T222909Z-d64a10cb'
observation = json.loads((ATTEMPT / 'result.json').read_text())
toolchain = json.loads((BASE / 'toolchain.json').read_text())
native = Path(toolchain['native']['path'])
assert len(observation['remainingOwnedProcesses']) == 1
pid = observation['remainingOwnedProcesses'][0]['pid']
proc = Path('/proc') / str(pid)
handle = os.pidfd_open(pid, 0)
try:
    assert (proc / 'exe').resolve() == native
    environment = dict(item.split(b'=', 1) for item in (proc / 'environ').read_bytes().split(b'\0') if b'=' in item)
    assert environment[b'HOME'].decode() == str(Path(toolchain['workspace']) / 'home')
    assert environment[b'AGENT_BROWSER_SOCKET_DIR'].decode() == observation['socketDirectory']
    digest = hashlib.sha256(native.read_bytes()).hexdigest()
    assert digest == toolchain['native']['sha256']
    signal.pidfd_send_signal(handle, signal.SIGTERM)
    deadline = time.monotonic() + 5
    while proc.exists() and time.monotonic() < deadline:
        state = (proc / 'stat').read_text().rsplit(') ', 1)[1].split()[0]
        if state == 'Z':
            break
        time.sleep(0.05)
    alive = proc.exists() and (proc / 'stat').read_text().rsplit(') ', 1)[1].split()[0] != 'Z'
    assert not alive
    receipt = {'type': 'recorded-owned-probe-daemon-settlement', 'pid': pid,
               'nativeSha256': digest, 'socketDirectory': observation['socketDirectory'],
               'signal': 'SIGTERM via pidfd', 'stillAlive': alive,
               'scope': 'Only the verified native daemon from the recorded rejected-profile probe; no Chrome or sibling process was signaled.'}
    with (ATTEMPT / 'post-failure-cleanup.json').open('x') as output:
        json.dump(receipt, output, indent=2)
        output.write('\n')
    print(json.dumps(receipt))
finally:
    os.close(handle)

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runTerminalCommand } from '../../sdk/src/tools/run-terminal-command'
import { createTerminalExecutionFixture, createRealExecutionProcessRecorder } from '../../sdk/src/__tests__/fixtures/b19-terminal-execution'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'b20-terminal-probe-'))
const abort = new AbortController()
const recorder = createRealExecutionProcessRecorder()
const host = createTerminalExecutionFixture({ projectRoot: dir, signal: abort.signal, spawn: recorder.spawn })
const marker = path.join(dir, 'late')
const ready = path.join(dir, 'ready')
const command = `python3 -c 'import signal,time,pathlib; signal.signal(signal.SIGTERM, signal.SIG_IGN); pathlib.Path("${ready}").touch(); time.sleep(2); pathlib.Path("${marker}").touch(); time.sleep(30)' >/dev/null 2>&1 & wait`
try {
  const pending = runTerminalCommand({ command, process_type: 'SYNC', cwd: dir, projectRoot: dir,
    timeout_seconds: -1, executionContext: host.context, terminalShell: { executable: '/bin/bash', args: ['-c'] },
    getTerminalLaunchMetadata: host.getTerminalLaunchMetadata })
  for (let i = 0; i < 200 && !fs.existsSync(ready); i++) await Bun.sleep(20)
  if (!fs.existsSync(ready)) throw new Error('child did not start')
  abort.abort(new Error('probe cancellation'))
  const result = await pending
  await Bun.sleep(2500)
  console.log(JSON.stringify({ returned: true, lateMarker: fs.existsSync(marker), result: result[0]?.value }))
} finally {
  for (const call of recorder.calls) if (call.executable === '/bin/bash' && call.child.pid) {
    try { process.kill(-call.child.pid, 'SIGKILL') } catch {}
  }
  host.dispose()
  fs.rmSync(dir, { recursive: true, force: true })
}

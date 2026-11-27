import { createDirectHostExecution, runTerminalCommand } from '/home/ben/Code/CLI/openbuff/sdk/src/index'
const cwd = '/tmp/verify-runtime/proj'
const host = createDirectHostExecution({ cwd })
if (!host.ok) { console.log('HOST REFUSED', host.cause); process.exit(3) }
const t0 = Date.now()
const timeout_seconds = process.argv[2] ? Number(process.argv[2]) : -1
console.log('START timeout_seconds=', timeout_seconds)
const result = await runTerminalCommand({
  command: 'read x; echo got $x', process_type: 'SYNC', timeout_seconds, cwd,
  executionContext: host.value.executionContext,
  terminalShell: host.value.hostServices.terminalShell,
  getTerminalLaunchMetadata: host.value.hostServices.getTerminalLaunchMetadata,
})
console.log('RESULT after', Date.now() - t0, 'ms', JSON.stringify(result).slice(0, 500))
process.exit(0)

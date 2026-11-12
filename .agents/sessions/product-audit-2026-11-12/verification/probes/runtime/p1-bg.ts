import { createDirectHostExecution, runTerminalCommand } from '/home/ben/Code/CLI/openbuff/sdk/src/index'
const cwd = '/tmp/verify-runtime/proj'
const tag = process.argv[2] ?? '300'
const host = createDirectHostExecution({ cwd })
if (!host.ok) { console.log('HOST REFUSED', host.cause); process.exit(3) }
const result = await runTerminalCommand({
  command: `sleep ${tag}`, process_type: 'BACKGROUND', timeout_seconds: -1, cwd,
  executionContext: host.value.executionContext,
  terminalShell: host.value.hostServices.terminalShell,
  getTerminalLaunchMetadata: host.value.hostServices.getTerminalLaunchMetadata,
})
console.log('RESULT', JSON.stringify(result).slice(0, 600))
console.log('PARENT_PID', process.pid)
if (process.argv[3] === 'wait') { console.log('READY'); await new Promise(() => {}) }
console.log('EXITING'); if (process.argv[3] === 'exit') process.exit(0)

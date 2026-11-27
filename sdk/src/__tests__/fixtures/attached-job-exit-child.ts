/**
 * Real-process SDK host for attached-job-exit.test.ts (ported from the
 * product-audit probes verification/probes/runtime/p1-bg.ts and p2-stdin.ts).
 *
 * argv: <mode> <cwd> <command> [exitMode]
 *   mode=bg       start `command` as an attached BACKGROUND job
 *   mode=detach   start `command` as a transferred (detach: true) job
 *   mode=sync     run `command` as SYNC with the default timeout and print the result
 *   exitMode      natural (fall off the end) | exit (process.exit(0)) | wait (block until signalled)
 *                 | host-handler (wait, with a host SIGTERM handler that exits 7, like the CLI)
 */
import { createDirectHostExecution } from '../../host-execution'
import { runTerminalCommand } from '../../tools/run-terminal-command'

const [mode = 'bg', cwd = process.cwd(), command = 'sleep 300', exitMode = 'natural'] = process.argv.slice(2)
const host = createDirectHostExecution({ cwd })
if (!host.ok) {
  console.log('HOST_REFUSED', host.cause)
  process.exit(3)
}
const { executionContext, hostServices } = host.value
const receiver = mode === 'detach' ? hostServices.createBackgroundReceiver('attached-job-exit-test') : undefined
if (receiver && !receiver.ok) {
  console.log('RECEIVER_REFUSED', receiver.cause)
  process.exit(3)
}
const t0 = Date.now()
const result = await runTerminalCommand({
  command,
  process_type: mode === 'sync' ? 'SYNC' : 'BACKGROUND',
  ...(mode === 'detach' ? { detach: true } : {}),
  ...(mode === 'sync' ? {} : { timeout_seconds: -1 }),
  cwd,
  executionContext,
  terminalShell: hostServices.terminalShell,
  getTerminalLaunchMetadata: hostServices.getTerminalLaunchMetadata,
  ...(receiver?.ok ? { prepareTransferredLaunch: target => receiver.value.prepareLaunch(executionContext, target) } : {}),
})
console.log(`RESULT ${JSON.stringify({ elapsedMs: Date.now() - t0, value: result[0]?.value })}`)
if (exitMode === 'host-handler') {
  process.on('SIGTERM', () => { console.log('HOST_HANDLER'); process.exit(7) })
}
if (exitMode === 'wait' || exitMode === 'host-handler') {
  console.log('READY')
  // The attached job no longer holds the loop open, so the host keeps itself alive.
  setInterval(() => {}, 1_000)
  await new Promise(() => {})
}
console.log('EXITING')
if (exitMode === 'exit') process.exit(0)

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createRequire } = require('node:module')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'"

async function run(sdk, format, outputFile) {
  let fetchCalls = 0
  globalThis.fetch = () => { fetchCalls++; throw new Error('Network is forbidden in this package fixture') }
  const entry = createRequire(path.join(process.cwd(), 'host.cjs')).resolve('@openbuff/sdk')
  assert.ok(fs.realpathSync(entry).startsWith(path.join(process.cwd(), 'node_modules/@openbuff/sdk/dist/')))
  const receipts = []
  for (const mode of ['owner-cancel', 'deadline']) {
    const root = path.join(process.cwd(), `${format}-${mode}`)
    fs.mkdirSync(root)
    const controller = new AbortController()
    const config = path.join(root, 'openbuff.json')
    fs.writeFileSync(config, JSON.stringify({ autoFileChangeHooks: false }))
    const events = []
    const host = sdk.createDirectHostExecution({ cwd: root, signal: controller.signal, approvalMode: 'allow-all',
      hostConfiguration: { environment: { PATH: '/usr/bin:/bin', OPENBUFF_TELEMETRY: '0', OPENBUFF_PROCESS_SUPERVISION: '0' },
        platform: 'linux', invocationCwd: root, projectRoot: root, home: { kind: 'none' }, globals: { kind: 'disabled' },
        selection: { kind: 'explicit', path: config, required: true }, trust: { ancestorConfig: false, projectReadableRoots: false } },
      configReadFs: sdk.nodeConfigReadFs, record: event => events.push(event),
    })
    assert.equal(host.ok, true, JSON.stringify(host))
    const before = performance.now()
    const pending = sdk.runTerminalCommand({
      command: `exec ${quote(process.execPath)} ${quote(path.join(process.cwd(), 'tree.mjs'))} ${quote(root)} ${quote(mode)}`,
      process_type: 'SYNC', cwd: root, projectRoot: root, timeout_seconds: mode === 'deadline' ? 0.25 : -1,
      executionContext: host.value.executionContext, terminalShell: host.value.hostServices.terminalShell,
      getTerminalLaunchMetadata: host.value.hostServices.getTerminalLaunchMetadata,
    })
    if (mode === 'owner-cancel') {
      const until = performance.now() + 1_500
      while (!fs.existsSync(path.join(root, 'descendant.json')) && performance.now() < until) await delay(5)
      assert.ok(fs.existsSync(path.join(root, 'descendant.json')), 'Real descendant must be ready before cancellation')
      controller.abort(new Error('Installed SDK fixture cancellation'))
    }
    const output = (await pending)[0].value
    const settledMs = performance.now() - before
    await delay(700)
    const lateMarker = fs.existsSync(path.join(root, 'late-marker'))
    const receipt = { mode, format, output, settledMs, lateMarker, events,
      leader: JSON.parse(fs.readFileSync(path.join(root, 'leader.json'), 'utf8')),
      descendant: JSON.parse(fs.readFileSync(path.join(root, 'descendant.json'), 'utf8')), oracleBeforeTeardown: true }
    receipts.push(receipt)
    fs.writeFileSync(outputFile, JSON.stringify({ format, fetchCalls, receipts }, null, 2))
    assert.equal(output.processCleanup.status, 'complete')
    assert.equal(output.processCleanup.selectedTier, 'posix-owned-group')
    assert.equal(output.processCleanup.finalObservation.leader, 'exited-reaped')
    assert.equal(output.processCleanup.finalObservation.membershipComplete, true)
    assert.equal(output.processCleanup.finalObservation.members.some(member => member.disposition === 'living'), false)
    assert.equal(output.processCleanup.cleanupAuthorityRetained, false)
    assert.equal(output.processCleanup.selectedLimitSatisfied, true)
    assert.equal(output.executionRefusal.reason, mode === 'deadline' ? 'deadline-exhausted' : 'cancelled')
    assert.equal(lateMarker, false)
    if (mode === 'deadline') assert.ok(settledMs < 1_650)
    controller.abort(new Error('Fixture owner finished'))
  }
  assert.equal(fetchCalls, 0)
}
module.exports = { run }

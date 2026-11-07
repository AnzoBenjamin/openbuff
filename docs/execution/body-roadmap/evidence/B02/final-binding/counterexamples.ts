import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { PassThrough, Readable, Writable } from 'node:stream'
import path from 'node:path'
import { AgentSideConnection, ndJsonStream, RequestError } from '@agentclientprotocol/sdk'
import { AcpRemoteBackend } from '../../../../../../sdk/src/client/acp-client'
import { runHeadlessCommand } from '../../../../../../cli/src/commands/run-command'
import { classifyActionOutput } from '../../../../../../common/src/util/action-outcomes'
const observations: unknown[] = []
const startedAt = new Date().toISOString()
const started = performance.now()
for (const name of ['max_tokens', 'max_turn_requests', 'rejected-task', 'failed-json', 'conflicting-action']) {
  const toAgent = new PassThrough(), toClient = new PassThrough()
  const agentStream = ndJsonStream(Writable.toWeb(toClient) as any, Readable.toWeb(toAgent) as any)
  const clientStream = ndJsonStream(Writable.toWeb(toAgent) as any, Readable.toWeb(toClient) as any)
  const succeeded = { actionId: 'a', attemptId: 'attempt', runId: 'r', toolName: 'custom', basis: { inputHash: 'sha256:fixture' }, outcome: 'succeeded', effect: { status: 'confirmed', receiptIds: ['fixture'], confirmedPaths: ['result.txt'] } }
  new AgentSideConnection(connection => ({
    initialize: async () => ({ protocolVersion: 1, agentCapabilities: {}, authMethods: [] }),
    newSession: async () => ({ sessionId: 'independent' }), authenticate: async () => ({}), cancel: async () => {},
    prompt: async () => {
      if (name === 'rejected-task') throw new RequestError(-32603, 'independent rejection', { 'openbuff.dev': { runOutcome: { termination: 'completed' }, taskAcceptance: { status: 'rejected', oracle: 'independent', basis: 'observed rejection' } } })
      if (name === 'failed-json' || name === 'conflicting-action') {
        await connection.sessionUpdate({ sessionId: 'independent', update: { sessionUpdate: 'tool_call', toolCallId: 't', title: 'custom', status: 'pending' } })
        await connection.sessionUpdate({ sessionId: 'independent', update: { sessionUpdate: 'tool_call_update', toolCallId: 't', status: 'failed', content: [{ type: 'content', content: { type: 'text', text: '{"message":"partial independent result"}' } }], ...(name === 'conflicting-action' ? { _meta: { 'openbuff.dev': { actionOutcome: succeeded } } } : {}) } })
      }
      return { stopReason: name.startsWith('max_') ? name as 'max_tokens' | 'max_turn_requests' : 'end_turn', _meta: { 'openbuff.dev': { runOutcome: { termination: 'completed' }, taskAcceptance: { status: 'accepted', oracle: 'independent-recovery' } } } }
    },
  }), agentStream)
  const backend = new AcpRemoteBackend({ kind: 'stream', stream: clientStream })
  const events: any[] = []
  try {
    const result = await backend.run({ prompt: 'independent local control', handleEvent: event => { events.push(event) } })
    if (name === 'max_tokens' || name === 'max_turn_requests') {
      assert.equal(result.runOutcome?.termination, name === 'max_tokens' ? 'budget_exhausted' : 'step_exhausted')
      assert.equal(result.output.type, 'error')
    } else if (name === 'rejected-task') {
      assert.equal(result.runOutcome?.termination, 'completed')
      assert.equal(result.taskAcceptance?.status, 'rejected')
    } else {
      const tool = events.find(event => event.type === 'tool_result')
      assert.ok(tool)
      assert.equal(classifyActionOutput('custom', tool.output).outcome, 'failed')
      if (name === 'conflicting-action') {
        assert.equal(tool.actionOutcome.outcome, 'failed')
        assert.deepEqual(tool.actionOutcome.effect, succeeded.effect)
        assert.equal(result.actionOutcomes?.[0].outcome, 'failed')
      }
      assert.equal(result.runOutcome?.termination, 'completed')
      assert.equal(result.taskAcceptance?.status, 'accepted')
    }
    observations.push({ name, result, events })
  } finally {
    toAgent.destroy(); toClient.destroy(); await backend.close()
  }
}
for (const [name, state, expected] of [
  ['empty-cause', { output: { type: 'lastMessage', value: [] }, runOutcome: { termination: 'failed', cause: { code: 'empty', message: '' } } }, 1],
  ['whitespace-error', { output: { type: 'error', message: ' \n ' } }, 1],
  ['rejected-headless', { output: { type: 'lastMessage', value: [] }, runOutcome: { termination: 'completed' }, taskAcceptance: { status: 'rejected', oracle: 'independent' } }, 1],
  ['accepted-headless', { output: { type: 'lastMessage', value: [] }, runOutcome: { termination: 'completed' }, taskAcceptance: { status: 'accepted', oracle: 'independent' } }, 0],
] as const) {
  const stdout: string[] = [], stderr: string[] = []
  const exitCode = await runHeadlessCommand({ prompt: 'independent headless control', json: true }, { projectRoot: '/tmp', journalPath: '/tmp/unused-independent-journal.sqlite', openRunJournal: () => undefined, getClient: async () => ({ run: async () => state }) as any, writeStdout: value => stdout.push(value), writeStderr: value => stderr.push(value) })
  assert.equal(exitCode, expected)
  if (expected === 1) assert.ok(JSON.parse(stdout.join('')).message.trim())
  observations.push({ name, input: state, exitCode, stdout, stderr })
}
writeFileSync(path.join(import.meta.dir, 'counterexample-observations.json'), JSON.stringify({ schemaVersion: 1, startedAt, finishedAt: new Date().toISOString(), elapsedMs: performance.now() - started, bun: Bun.version, scope: 'real in-memory ACP transport and actual headless projection with injected local results; no network or model', observations }, null, 2) + '\n')
console.log(JSON.stringify({ cases: observations.length, passed: true }))

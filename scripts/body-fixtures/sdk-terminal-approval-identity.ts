import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import type { AgentDefinition } from '../../common/src/templates/initial-agents-dir/types/agent-definition'
import type { AgentState } from '../../common/src/types/session-state'
import type { HarnessApprovalRequest } from '../../sdk/src/services/harness-enforcement'

const argument = process.argv.indexOf('--evidence-dir')
assert(argument >= 0 && process.argv[argument + 1])
assert.equal(Bun.version, '1.4.4')
const evidenceDir = path.resolve(process.argv[argument + 1])
const invocationDir = path.join(evidenceDir, randomUUID())
mkdirSync(invocationDir, { recursive: true })
const config = path.join(invocationDir, 'providers.json')
writeFileSync(
  config,
  '{"providers":{},"autoFileChangeHooks":false,"fileChangeHooks":[]}\n',
)
process.env.OPENBUFF_PROVIDER_CONFIG = config
let providerCalls = 0
globalThis.fetch = Object.assign(
  async () => {
    providerCalls++
    throw new Error('B18 SDK fixture attempted a provider/network request')
  },
  { preconnect() {} },
) as typeof fetch
const { OpenbuffClient } = await import('../../sdk/src/client')
const { hashCommand } =
  await import('../../sdk/src/services/harness-enforcement')

// Serialized and executed by the actual programmatic runtime, without closures.
const handleSteps: AgentDefinition['handleSteps'] = function* ({
  agentState,
  params,
}) {
  const result = yield {
    toolName: 'run_terminal_command',
    input: { command: params?.command, process_type: 'SYNC' },
  }
  const results = [result.toolResult]
  if (params?.repeat) {
    const repeated = yield {
      toolName: 'run_terminal_command',
      input: { command: params?.command, process_type: 'SYNC' },
    }
    results.push(repeated.toolResult)
  }
  ;(agentState as unknown as AgentState).output = { terminal: results }
}

const observations: unknown[] = []
for (const fixture of [
  {
    name: 'compound_declined',
    command: "git commit -m 'a  b'; rm -rf fixture",
    approvalMode: 'balanced',
    approve: false,
    allowed: false,
    approvalCalls: 1,
  },
  {
    name: 'compound_approved',
    command: "git commit -m 'a  b'; rm -rf fixture",
    approvalMode: 'balanced',
    approve: true,
    allowed: true,
    approvalCalls: 1,
  },
  {
    name: 'force_declined',
    command: 'git push --force origin feature',
    approvalMode: 'balanced',
    approve: false,
    allowed: false,
    approvalCalls: 1,
  },
  {
    name: 'approval_cancelled',
    command: 'git push --force origin feature',
    approvalMode: 'balanced',
    approve: true,
    cancel: true,
    allowed: false,
    approvalCalls: 1,
  },
  {
    name: 'repeat_requires_new_decision',
    command: 'git push --force origin feature',
    approvalMode: 'balanced',
    approve: true,
    repeat: true,
    allowed: true,
    approvalCalls: 2,
  },
  {
    name: 'feature_routine',
    command: 'git push origin feature',
    approvalMode: 'balanced',
    approve: false,
    allowed: true,
    approvalCalls: 0,
  },
  {
    name: 'allow_all',
    command: "git commit -m 'a  b'; rm -rf fixture",
    approvalMode: 'allow-all',
    approve: false,
    allowed: true,
    approvalCalls: 0,
  },
] as const) {
  const cwd = path.join(invocationDir, fixture.name)
  const bin = path.join(cwd, 'bin')
  const tracePath = path.join(cwd, 'trace.txt')
  const harnessStateDir = path.join(cwd, 'harness')
  mkdirSync(bin, { recursive: true })
  for (const name of ['git', 'rm'])
    writeFileSync(
      path.join(bin, name),
      '#!/bin/sh\nif [ "${0##*/}" = git ]; then case "$1" in push|commit) ;; *) exit 0;; esac; fi\nprintf "%s\\n" "${0##*/}:$*" >> "$B18_TRACE"\n',
      { mode: 0o700 },
    )
  const approvals: HarnessApprovalRequest[] = []
  const controller = new AbortController()
  const agent: AgentDefinition = {
    id: 'terminal-approval-fixture',
    displayName: 'Terminal approval fixture',
    model: 'fixture-model',
    toolNames: ['run_terminal_command'],
    spawnableAgents: [],
    outputMode: 'structured_output',
    handleSteps,
  }
  const client = new OpenbuffClient({
    cwd,
    harnessStateDir,
    agentDefinitions: [agent],
    maxAgentSteps: 4,
    approvalMode: fixture.approvalMode,
    requestApproval: async (request) => {
      approvals.push(structuredClone(request))
      if ('cancel' in fixture && fixture.cancel)
        controller.abort(new Error('fixture cancellation during approval'))
      return (
        fixture.approve &&
        (!('repeat' in fixture && fixture.repeat) || approvals.length === 1)
      )
    },
    env: {
      HOME: path.join(cwd, 'home'),
      PATH: bin + ':/usr/bin:/bin',
      B18_TRACE: tracePath,
      OPENBUFF_PROVIDER_CONFIG: config,
    },
    inheritEnv: false,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  })
  const started = performance.now()
  const result = await client.run({
    agent: agent.id,
    prompt: 'Execute the fixed local approval control.',
    params: {
      command: fixture.command,
      repeat: 'repeat' in fixture && fixture.repeat,
    },
    signal: controller.signal,
  })
  const elapsedMs = performance.now() - started
  const trace = existsSync(tracePath) ? readFileSync(tracePath, 'utf8') : ''
  const output = JSON.stringify(result.output)
  const records = existsSync(harnessStateDir)
    ? readdirSync(harnessStateDir, { recursive: true })
        .filter(
          (file): file is string =>
            typeof file === 'string' &&
            file.endsWith('.json') &&
            file.includes('approvals'),
        )
        .map((file) =>
          JSON.parse(readFileSync(path.join(harnessStateDir, file), 'utf8')),
        )
    : []
  const observation = {
    ...fixture,
    elapsedMs,
    approvals,
    trace,
    output: result.output,
    runOutcome: result.runOutcome,
    actionOutcomes: result.actionOutcomes,
    approvalRecords: records,
  }
  observations.push(observation)
  writeFileSync(
    path.join(evidenceDir, 'observations.json'),
    JSON.stringify(
      { schemaVersion: 1, invocationDir, providerCalls, observations },
      null,
      2,
    ) + '\n',
  )
  assert.equal(
    approvals.length,
    fixture.approvalCalls,
    fixture.name + ': actual host approval calls',
  )
  if ('cancel' in fixture && fixture.cancel)
    assert.equal(result.runOutcome?.termination, 'cancelled')
  else
    assert.equal(
      output.includes('permissionDenied'),
      !fixture.allowed || ('repeat' in fixture && fixture.repeat),
      fixture.name,
    )
  assert.equal(
    trace.length > 0,
    fixture.allowed,
    fixture.name + ': actual effect trace',
  )
  if (fixture.allowed)
    assert.equal(
      trace,
      fixture.command.startsWith('git push')
        ? fixture.command.replace('git ', 'git:') + '\n'
        : 'git:commit -m a  b\nrm:-rf fixture\n',
      fixture.name + ': exactly one execution',
    )
  for (const approval of approvals) {
    assert.equal(approval.commandHash, hashCommand(fixture.command))
    assert.equal(approval.rawCommand, fixture.command)
    assert.equal(approval.risk, 'high')
    assert(approval.executionContextHash && approval.effects?.length)
  }
  assert.equal(
    records.length,
    fixture.approve && fixture.allowed ? 1 : 0,
    fixture.name + ': granted receipt count',
  )
  for (const record of records) {
    assert(
      record.consumedAt &&
        record.snapshotId &&
        record.runId &&
        record.repositoryId &&
        record.workspaceId,
    )
    assert.equal(record.commandHash, hashCommand(fixture.command))
    assert.equal(record.executionContextHash, approvals[0].executionContextHash)
  }
  assert.equal(providerCalls, 0)
}
console.log(
  JSON.stringify({
    cases: observations.length,
    providerCalls,
    evidenceDir,
    fixtureSha256: createHash('sha256')
      .update(readFileSync(import.meta.path))
      .digest('hex'),
  }),
)

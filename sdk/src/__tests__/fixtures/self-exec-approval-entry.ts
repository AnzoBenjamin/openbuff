import fs from 'node:fs'
import path from 'node:path'
import { OpenbuffClient } from '../../client'
import { createNodeFileSystem } from '../../tools/node-filesystem'
import { SUPERVISED_SELF_EXEC_FLAG } from '@codebuff/agent-runtime/supervision/self-exec-flag'
import type { AgentDefinition } from '@codebuff/common/templates/initial-agents-dir/types/agent-definition'
import type { LaunchEvent } from '@codebuff/common/types/contracts/execution-context'

if (process.argv[2] === SUPERVISED_SELF_EXEC_FLAG) {
  const { runChildEntryMain } = await import('@codebuff/agent-runtime/supervision/child-entry')
  process.exit(await runChildEntryMain([process.argv[0], process.argv[1], ...process.argv.slice(3)]))
}

const [root, mode, scenario] = process.argv.slice(2)
const configFile = path.join(root, 'openbuff.json')
fs.writeFileSync(configFile, JSON.stringify({ autoFileChangeHooks: false, providers: {
  fixture: { type: 'openai-compatible', baseURL: 'https://fixture.invalid/v1', models: ['fixture-model'], apiKeyEnv: 'FIXTURE_KEY' },
} }))
globalThis.fetch = Object.assign(async () => { throw new Error('Unexpected provider request in programmatic fixture') },
  { preconnect: () => { throw new Error('Unexpected provider preconnect in programmatic fixture') } })
const approvals: string[] = [], events: LaunchEvent[] = []
const child: AgentDefinition = { id: 'approval-child', displayName: 'Approval child', model: 'fixture-model',
  outputMode: 'structured_output', includeMessageHistory: false, toolNames: ['run_terminal_command', 'set_output'],
  handleSteps: function* ({ prompt }) {
    if (prompt === 'gated-command') yield { toolName: 'run_terminal_command', input: { command: 'bun --eval "console.log(123)"' } }
    yield { toolName: 'set_output', input: { worked: true } }
  } }
const parent: AgentDefinition = { id: 'approval-parent', displayName: 'Approval parent', model: 'fixture-model',
  outputMode: 'structured_output', toolNames: ['spawn_agents', 'set_output'], spawnableAgents: [child.id],
  handleSteps: function* ({ prompt }) {
    const { toolResult } = yield { toolName: 'spawn_agents', input: { agents: [{ agent_type: 'approval-child', prompt }] } }
    yield { toolName: 'set_output', input: { child: toolResult } }
  } }
const environment = { PATH: process.env.PATH, HOME: path.join(root, 'home'), NODE_ENV: 'test', FIXTURE_KEY: 'fixture-only',
  OPENBUFF_PROCESS_SUPERVISION: '1', OPENBUFF_TELEMETRY: '0', DO_NOT_TRACK: '1' }
const client = new OpenbuffClient({ cwd: root, projectFiles: {}, knowledgeFiles: {}, harnessStateDir: path.join(root, 'harness'),
  fsSource: createNodeFileSystem(), approvalMode: mode as 'balanced' | 'strict',
  hostConfiguration: { environment, platform: process.platform, invocationCwd: root, projectRoot: root,
    home: { kind: 'none' }, globals: { kind: 'disabled' }, selection: { kind: 'explicit', path: configFile, required: true },
    trust: { ancestorConfig: false, projectReadableRoots: false } },
  requestApproval: async request => { approvals.push(request.action); return false }, recordExecution: event => events.push(event) })
const result = await client.run({ agent: parent, agentDefinitions: [child], prompt: scenario })
console.log('SELF_EXEC_RESULT ' + JSON.stringify({ approvals, output: result.output, outcome: result.runOutcome,
  childStarts: events.filter(event => event.phase === 'spawn-observed' && event.facts.family === 'supervised-child').length,
  terminalStarts: events.filter(event => event.phase === 'spawn-observed' && event.facts.branchId === 'terminal.sync').length }))

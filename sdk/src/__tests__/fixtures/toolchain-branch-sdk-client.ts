import { spyOn } from 'bun:test'
import { captureRootDeadline } from '@codebuff/common/util/execution-context'
import { OpenbuffClient } from '../../client'
import * as hostExecution from '../../host-execution'
import { nodeConfigReadFs } from '../../host-config'
import { createNodeFileSystem } from '../../tools/node-filesystem'
import { unwrap } from './toolchain-branch-authority'
import type { BranchFixture } from './toolchain-branch-authority'
import type { AgentDefinition, ToolCall } from '@codebuff/common/templates/initial-agents-dir/types/agent-definition'
import type { CodebuffSpawn } from '@codebuff/common/types/spawn'
import type { CustomToolDefinition } from '../../custom-tool'

const originalHost = hostExecution.createHostExecutionServices

/** Actual SDK run/dispatcher; host policy and monotonic time are controlled. */
export function createToolchainSdkConsumer(fixture: BranchFixture, options: { spawn?: CodebuffSpawn; customToolDefinitions?: CustomToolDefinition[] } = {}) {
  const snapshots: string[] = []
  let providerCalls = 0
  const forbidden = () => { providerCalls++; throw new Error('Network forbidden in B19 local toolchain controls') }
  const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(async () => forbidden(), { preconnect: forbidden }))
  const hostSpy = spyOn(hostExecution, 'createHostExecutionServices').mockImplementation(options => {
    if (options.snapshot.inputs.projectRoot !== fixture.root) return originalHost(options)
    snapshots.push(options.snapshot.snapshotId)
    return originalHost({ ...options, clock: fixture.clock,
      boundary: unwrap(captureRootDeadline({ clock: fixture.clock, limit: { kind: 'finite', durationMs: 60_000 } })),
      authorizeAsync: fixture.hostOptions.authorizeAsync, authorizeSync: fixture.hostOptions.authorizeSync,
      record: event => { options.record?.(event); fixture.hostOptions.record?.(event) } })
  })
  const client = new OpenbuffClient({ cwd: fixture.root, projectFiles: {}, knowledgeFiles: {},
    hostConfiguration: { environment: fixture.environment, platform: 'linux', invocationCwd: fixture.root, projectRoot: fixture.root,
      home: { kind: 'none' }, globals: { kind: 'disabled' }, selection: { kind: 'explicit', path: fixture.config, required: true },
      trust: { ancestorConfig: false, projectReadableRoots: false } },
    configReadFs: nodeConfigReadFs, spawnSource: options.spawn ?? fixture.baseContext.spawn, fsSource: createNodeFileSystem(),
    env: fixture.hostOptions.env, approvalMode: 'allow-all', executionProfile: fixture.baseContext.profile,
    customToolDefinitions: options.customToolDefinitions,
    harnessStateDir: `${fixture.root}/harness` })
  const runAgent = (agent: AgentDefinition, prompt = '') => client.run({ agent, prompt, signal: fixture.stop.signal,
    ...(fixture.zeroSelection ? { runTimeoutMs: 0 } : {}) })
  return {
    snapshots,
    runAgent,
    get providerCalls() { return providerCalls },
    async run(tool: ToolCall, extraTools: AgentDefinition['toolNames'] = []) {
      const agent: AgentDefinition = { id: 'b19-toolchain-sdk-strategy', displayName: 'Local toolchain control', model: 'fixture/fixture-model',
        toolNames: [tool.toolName, 'set_output', ...extraTools], outputMode: 'structured_output',
        handleSteps: function* ({ prompt }) {
          const tool = JSON.parse(prompt ?? '{}') as ToolCall
          const result = yield tool
          yield { toolName: 'set_output', input: { consumerOutput: result.toolResult } }
        } }
      return runAgent(agent, JSON.stringify(tool))
    },
    close() { hostSpy.mockRestore(); fetchSpy.mockRestore() },
  }
}

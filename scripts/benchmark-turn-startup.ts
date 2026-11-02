/**
 * Compare local turn preparation with and without eager symbol scoring.
 * Run from the repo root: bun scripts/benchmark-turn-startup.ts
 * Uses fresh filesystem adapters like SDK runs; makes no model requests.
 */
import fs from 'node:fs'
import { monitorEventLoopDelay, performance } from 'node:perf_hooks'

import { bundledAgents } from '../cli/src/agents/bundled-agents.generated'
import {
  initialSessionState,
  applyOverridesToSessionState,
} from '../sdk/src/run-state'
import type { CodebuffFileSystem } from '@codebuff/common/types/filesystem'
import type { AgentDefinition } from '@codebuff/common/templates/initial-agents-dir/types/agent-definition'

const cwd = process.cwd()
const agentDefinitions = Object.values(bundledAgents) as AgentDefinition[]
const logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}
const samples: object[] = []

for (const projectContextMode of ['symbols', 'paths'] as const) {
  let reads = 0
  const adapter = (): CodebuffFileSystem =>
    ({
      ...fs.promises,
      readFile: async (filePath: string, encoding: 'utf8') => {
        reads++
        return fs.promises.readFile(filePath, encoding)
      },
    }) as unknown as CodebuffFileSystem
  const lag = monitorEventLoopDelay({ resolution: 10 })
  lag.enable()
  let start = performance.now()
  let state = await initialSessionState({
    cwd,
    fs: adapter(),
    logger,
    agentDefinitions,
    projectContextMode,
    persistentMemory: false,
  })
  const record = (phase: string) => {
    samples.push({
      projectContextMode,
      phase,
      milliseconds: performance.now() - start,
      fileReads: reads,
      scoredFiles: Object.keys(state.fileContext.fileTokenScores).length,
      maxEventLoopDelayMs: lag.max / 1e6,
    })
  }
  record('initial')
  for (let turn = 1; turn <= 2; turn++) {
    reads = 0
    lag.reset()
    start = performance.now()
    state = await applyOverridesToSessionState(
      cwd,
      state,
      { agentDefinitions, projectContextMode },
      { fs: adapter(), logger },
    )
    record(`continued-${turn}`)
  }
  lag.disable()
}
console.log(
  JSON.stringify(
    {
      recordedAt: new Date().toISOString(),
      cwd,
      runtime: process.versions.bun,
      note: 'Local session preparation only; excludes provider latency, TUI rendering, and memory hydration.',
      samples,
    },
    null,
    2,
  ),
)

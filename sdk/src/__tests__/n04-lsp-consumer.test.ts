import { spawn } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, spyOn, test } from 'bun:test'

import { OpenbuffClient } from '../client'
import { nodeConfigReadFs } from '../host-config'
import { generateInitialRunState } from '../run-state'
import { createNodeFileSystem } from '../tools/node-filesystem'

import type { AgentDefinition } from '@codebuff/common/templates/initial-agents-dir/types/agent-definition'
import type { CodebuffSpawn } from '@codebuff/common/types/spawn'

const lspProbe: AgentDefinition = {
  id: 'n04-lsp-probe',
  displayName: 'N04 language intelligence probe',
  model: 'n04-offline',
  toolNames: ['workspace_symbol', 'go_to_definition', 'set_output'],
  outputMode: 'structured_output',
  handleSteps: function* ({ prompt }) {
    const { toolResult } = yield prompt === 'workspace_symbol'
      ? { toolName: 'workspace_symbol', input: { query: 'target' } }
      : { toolName: 'go_to_definition', input: { path: 'target.ts', line: 1, character: 13 } }
    yield { toolName: 'set_output', input: { lsp: toolResult } }
  },
}

const server = 'typescript-language-server'

type SpawnAttempt = {
  command: string
  executable: string
  argv: string[]
  cwd: string | URL | undefined
  searchPath: string | undefined
  started: boolean
  errorCode?: string
}

async function runLspProbe(tool: 'workspace_symbol' | 'go_to_definition') {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'openbuff-n04-lsp-')))
  const project = path.join(root, 'project')
  const installBin = path.join(root, 'install', 'bin')
  const missingExecutable = path.join(installBin, server)
  const attempts: SpawnAttempt[] = []
  const closed: Promise<void>[] = []
  const spawnSource: CodebuffSpawn = (command, argv = [], options) => {
    const attempt: SpawnAttempt = {
      command,
      executable: missingExecutable,
      argv: [...argv],
      cwd: options?.cwd,
      searchPath: options?.env?.PATH,
      started: false,
    }
    attempts.push(attempt)
    if (command !== server || existsSync(missingExecutable)) {
      throw new Error(`Unexpected process in the offline LSP fixture: ${command}`)
    }
    // Pin the install alias so even platforms that search outside PATH cannot
    // start a real server. Return Node's unmodified child and real ENOENT event.
    const child = spawn(missingExecutable, [...argv], options ?? {})
    child.once('spawn', () => {
      attempt.started = true
    })
    child.once('error', (error: NodeJS.ErrnoException) => {
      attempt.errorCode = error.code
    })
    closed.push(new Promise((resolve) => child.once('close', () => resolve())))
    return child
  }
  const forbiddenNetwork = () => {
    throw new Error('N04 offline LSP fixture must not use the network')
  }
  const fetch = spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(async () => forbiddenNetwork(), { preconnect: forbiddenNetwork }),
  )
  try {
    mkdirSync(project)
    mkdirSync(installBin, { recursive: true })
    writeFileSync(
      path.join(project, 'package.json'),
      '{"name":"n04-lsp","private":true}\n',
    )
    writeFileSync(path.join(project, 'target.ts'), 'export const target = 1\n')
    expect(existsSync(missingExecutable)).toBe(false)

    // Seed an empty session without execution authority to skip unrelated
    // initial Git probes. The LSP multiplexer is always per-run and starts cold.
    const fs = createNodeFileSystem()
    const previousRun = await generateInitialRunState({
      cwd: project,
      fs,
      homeDir: null,
      includeGlobalSkills: false,
      projectFiles: {},
      knowledgeFiles: {},
      agentDefinitions: [lspProbe],
      persistentMemory: false,
    })

    // No tool override or injected multiplexer: run() builds its own language
    // service and uses the normal host admission path for the LSP launch.
    const result = await new OpenbuffClient({
      apiKey: '',
      cwd: project,
      projectFiles: {},
      knowledgeFiles: {},
      hostConfiguration: {
        environment: {
          PATH: installBin,
          OPENBUFF_PROCESS_SUPERVISION: '0',
          OPENBUFF_TELEMETRY: '0',
        },
        platform: process.platform,
        invocationCwd: project,
        projectRoot: project,
        home: { kind: 'none' },
        globals: { kind: 'disabled' },
        selection: { kind: 'none' },
        trust: { ancestorConfig: false, projectReadableRoots: false },
      },
      configReadFs: nodeConfigReadFs,
      fsSource: fs,
      spawnSource,
      repositoryIntelligence: false,
      approvalMode: 'allow-all',
      handleEvent() {},
    }).run({ agent: lspProbe, prompt: tool, previousRun })
    expect(fetch).not.toHaveBeenCalled()
    expect(result.runOutcome?.termination).toBe('completed')
    return { output: result.output, attempts, project, installBin, missingExecutable }
  } finally {
    await Promise.all(closed)
    fetch.mockRestore()
    rmSync(root, { recursive: true, force: true })
  }
}

test('N04 SDK LSP workspace_symbol reports no warm server without spawning', async () => {
  const { output, attempts } = await runLspProbe('workspace_symbol')
  expect(output).toEqual({
    type: 'structuredOutput',
    value: {
      lsp: [
        {
          type: 'json',
          value: {
            unavailable: {
              status: 'unavailable',
              reason: 'no-warm-server',
              nextStep: expect.stringMatching(
                /Call go_to_definition.*then retry.*code_search \/ query_index/,
              ),
            },
          },
        },
      ],
    },
  })
  expect(attempts).toEqual([])
})

test('N04 SDK LSP go_to_definition reports not_installed after a real absent-executable launch attempt', async () => {
  const { output, attempts, project, installBin, missingExecutable } =
    await runLspProbe('go_to_definition')
  expect(attempts).toEqual([
    {
      command: server,
      executable: missingExecutable,
      argv: ['--stdio'],
      cwd: project,
      searchPath: installBin,
      started: false,
      errorCode: 'ENOENT',
    },
  ])
  expect(output).toEqual({
    type: 'structuredOutput',
    value: {
      lsp: [
        {
          type: 'json',
          value: {
            unavailable: {
              status: 'not_installed',
              reason: 'not-installed',
              languageId: 'typescript',
              command: server,
              install: 'npm install -g typescript-language-server typescript',
              nextStep: expect.stringMatching(
                /Ask the user to install 'typescript-language-server'.*then retry.*code_search or query_index/,
              ),
            },
          },
        },
      ],
    },
  })
})

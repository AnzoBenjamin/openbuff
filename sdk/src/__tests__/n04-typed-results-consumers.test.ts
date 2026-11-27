import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, spyOn, test } from 'bun:test'

import { getVerifiedMemoryExcerpts } from '@codebuff/agent-runtime/orchestration/discovery-coordinator'
import { handleCodeSearch } from '@codebuff/agent-runtime/tools/handlers/tool/code-search'
import { handleGlob } from '@codebuff/agent-runtime/tools/handlers/tool/glob'
import { handleListDirectory } from '@codebuff/agent-runtime/tools/handlers/tool/list-directory'
import { getInitialAgentState } from '@codebuff/common/types/session-state'

import { OpenbuffClient } from '../client'
import { nodeConfigReadFs } from '../host-config'
import { codeSearch } from '../tools/code-search'
import { glob } from '../tools/glob'
import { listDirectory } from '../tools/list-directory'
import { createNodeFileSystem } from '../tools/node-filesystem'
import { createSearchExecutionFixture } from './fixtures/search-execution'

import type { AgentDefinition } from '@codebuff/common/templates/initial-agents-dir/types/agent-definition'
import type {
  ClientToolCall,
  CodebuffToolCall,
} from '@codebuff/common/tools/list'

const docsProbe: AgentDefinition = {
  id: 'n04-docs-probe',
  displayName: 'N04 documents probe',
  model: 'n04-offline',
  toolNames: ['read_docs', 'set_output'],
  outputMode: 'structured_output',
  handleSteps: function* () {
    const { toolResult } = yield {
      toolName: 'read_docs',
      input: { libraryTitle: 'React', topic: 'Hooks' },
    }
    yield { toolName: 'set_output', input: { docs: toolResult } }
  },
}

test('N04 Context7 auth refusal survives the real SDK consumer without network', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'openbuff-n04-docs-'))
  const key = process.env.CONTEXT7_API_KEY
  delete process.env.CONTEXT7_API_KEY
  const fetch = spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(
      async () => {
        throw new Error('N04 offline fixture must not fetch')
      },
      {
        preconnect: () => {
          throw new Error('N04 offline fixture must not preconnect')
        },
      },
    ),
  )
  try {
    const client = new OpenbuffClient({
      apiKey: '',
      cwd: root,
      projectFiles: {},
      knowledgeFiles: {},
      hostConfiguration: {
        environment: {
          OPENBUFF_PROCESS_SUPERVISION: '0',
          OPENBUFF_TELEMETRY: '0',
        },
        platform: process.platform,
        invocationCwd: root,
        projectRoot: root,
        home: { kind: 'none' },
        globals: { kind: 'disabled' },
        selection: { kind: 'none' },
        trust: { ancestorConfig: false, projectReadableRoots: false },
      },
      configReadFs: nodeConfigReadFs,
      harnessStateDir: path.join(root, 'harness'),
      fsSource: createNodeFileSystem(),
      repositoryIntelligence: false,
      handleEvent() {},
    })
    const result = await client.run({
      agent: docsProbe,
      prompt: 'Return the offline documentation result.',
    })
    expect(result.runOutcome?.termination).toBe('completed')
    expect(result.output).toMatchObject({
      type: 'structuredOutput',
      value: {
        docs: [
          {
            type: 'json',
            value: {
              status: 'auth_required',
              reason: expect.stringContaining('CONTEXT7_API_KEY'),
              nextStep: expect.stringContaining('Set CONTEXT7_API_KEY'),
            },
          },
        ],
      },
    })
    expect(fetch).not.toHaveBeenCalled()
  } finally {
    fetch.mockRestore()
    if (key === undefined) delete process.env.CONTEXT7_API_KEY
    else process.env.CONTEXT7_API_KEY = key
    rmSync(root, { recursive: true, force: true })
  }
})

test.each([false, true])(
  'N04 exhaustive glob reaches the real scoped SDK filesystem (in-scope file = %s)',
  async (inside) => {
    const root = mkdtempSync(path.join(tmpdir(), 'openbuff-n04-glob-'))
    try {
      mkdirSync(path.join(root, 'src/auth'), { recursive: true })
      writeFileSync(
        path.join(root, 'src/auth/login.ts'),
        'export const login = true\n',
      )
      writeFileSync(path.join(root, 'Dockerfile'), 'FROM scratch\n')
      if (inside)
        writeFileSync(path.join(root, 'src/Dockerfile'), 'FROM scratch\n')
      const agentState = getInitialAgentState()
      // Set only the projection used by the runtime's memory excerpt reader;
      // the filesystem producer below is the real SDK glob adapter.
      Object.assign(agentState, {
        memoryV2Context: {
          result: {
            verifiedKnowledge: [
              {
                verifiedEvidence: [
                  {
                    selector: { path: 'src/auth/login.ts' },
                    excerpt: 'login',
                  },
                ],
              },
            ],
          },
        },
      })
      expect(
        getVerifiedMemoryExcerpts(agentState).map((item) => item.path),
      ).toEqual(['src/auth/login.ts'])
      let calls = 0
      const result = await handleGlob({
        previousToolCallFinished: Promise.resolve(),
        agentState,
        toolCall: {
          toolName: 'glob',
          toolCallId: 'n04-glob',
          input: { pattern: 'Dockerfile', cwd: 'src' },
        },
        requestClientToolCall: async (call) => {
          calls++
          return glob({
            ...call.input,
            projectPath: root,
            fs: createNodeFileSystem(),
          })
        },
      })
      expect(calls).toBe(1)
      expect(result.output).toMatchObject([
        {
          type: 'json',
          value: {
            files: inside ? ['src/Dockerfile'] : [],
            count: inside ? 1 : 0,
          },
        },
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  },
)

function withVerifiedLoginExcerpt(excerpt: string) {
  // Seed only the runtime's verified-memory projection, never the adapter result.
  const agentState = Object.assign(getInitialAgentState(), {
    memoryV2Context: {
      result: {
        verifiedKnowledge: [
          {
            verifiedEvidence: [{ selector: { path: 'src/auth/login.ts' }, excerpt }],
          },
        ],
      },
    },
  })
  expect(getVerifiedMemoryExcerpts(agentState)).toEqual([
    { path: 'src/auth/login.ts', excerpt },
  ])
  return agentState
}

test('N04 SDK disk list_directory forwards the full page request and lists only direct disk children', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'openbuff-n04-list-'))
  try {
    mkdirSync(path.join(root, 'src/auth'), { recursive: true })
    writeFileSync(
      path.join(root, 'src/auth/login.ts'),
      'export const login = true\n',
    )
    writeFileSync(path.join(root, 'src/live.ts'), 'export const live = true\n')
    writeFileSync(path.join(root, 'outside.ts'), 'export const outside = true\n')
    const agentState = withVerifiedLoginExcerpt('export const login = true')
    const toolCall = {
      toolName: 'list_directory',
      toolCallId: 'n04-list',
      input: { path: 'src', offset: 0, limit: 2 },
    } satisfies CodebuffToolCall<'list_directory'>
    const expectedCall = structuredClone(toolCall)
    const forwarded: ClientToolCall<'list_directory'>[] = []
    const fs = createNodeFileSystem()

    const result = await handleListDirectory({
      previousToolCallFinished: Promise.resolve(),
      agentState,
      toolCall,
      requestClientToolCall: async (call) => {
        forwarded.push(structuredClone(call))
        const { path: directoryPath, ...page } = call.input
        return listDirectory({ ...page, directoryPath, projectPath: root, fs })
      },
    })

    expect(forwarded).toEqual([expectedCall])
    expect(result.output).toEqual([
      {
        type: 'json',
        value: { files: ['live.ts'], directories: ['auth'], path: 'src' },
      },
    ])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

for (const hasDiskMatches of [false, true]) {
  test(`N04 SDK disk code_search forwards the full query and excludes memory-only matches (disk matches = ${hasDiskMatches})`, async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'openbuff-n04-search-'))
    try {
      mkdirSync(path.join(root, 'src/auth'), { recursive: true })
      mkdirSync(path.join(root, 'src/other'))
      const loginSource = 'export const login = true\n'
      const loginMatch = '// todo from the covered file on disk'
      const liveMatch = '// FIXME from the uncovered file on disk'
      writeFileSync(
        path.join(root, 'src/auth/login.ts'),
        loginSource + (hasDiskMatches ? `${loginMatch}\n` : ''),
      )
      writeFileSync(
        path.join(root, 'src/other/live.ts'),
        hasDiskMatches ? `${liveMatch}\n` : 'export const live = true\n',
      )
      writeFileSync(
        path.join(root, 'src/unselected.ts'),
        '// TODO outside paths\n',
      )
      const agentState = withVerifiedLoginExcerpt('// FIXME in memory only')
      const toolCall = {
        toolName: 'code_search',
        toolCallId: 'n04-search',
        input: {
          pattern: 'TODO|FIXME',
          cwd: 'src',
          paths: ['src/auth/login.ts', 'src/other'],
          flags: ['-i'],
          maxResults: 5,
        },
      } satisfies CodebuffToolCall<'code_search'>
      const expectedCall = structuredClone(toolCall)
      const forwarded: ClientToolCall<'code_search'>[] = []
      // With no spawn override, the SDK's configured host executes bundled rg.
      const execution = await createSearchExecutionFixture({
        projectPath: root,
      })
      const result = await handleCodeSearch({
        previousToolCallFinished: Promise.resolve(),
        agentState,
        toolCall,
        requestClientToolCall: async (call) => {
          forwarded.push(structuredClone(call))
          return codeSearch({
            ...call.input,
            projectPath: root,
            executionContext: execution.context(),
          })
        },
      }).finally(() => execution.close())

      expect(forwarded).toEqual([expectedCall])
      const exitCode = hasDiskMatches ? 0 : 1
      expect(result.output).toMatchObject([
        { type: 'json', value: { exitCode, message: `Exit code: ${exitCode}` } },
      ])
      const value = result.output[0]?.value
      expect(value?.errorMessage).toBeUndefined()
      expect(value?.executionRefusal).toBeUndefined()
      if (!value || !('stdout' in value) || typeof value.stdout !== 'string') {
        throw new Error('Expected stdout from the SDK code_search adapter')
      }
      const [summary, ...lines] = value.stdout.split('\n')
      expect(summary).toBe(`Found ${hasDiskMatches ? 2 : 0} matches`)
      // Ripgrep does not guarantee the order of distinct file groups.
      expect(lines.join('\n').split('\n\n').filter(Boolean).sort()).toEqual(
        hasDiskMatches
          ? [
              `${path.join('auth', 'login.ts')}:\n  Line 2: ${loginMatch}`,
              `${path.join('other', 'live.ts')}:\n  Line 1: ${liveMatch}`,
            ]
          : [],
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
}


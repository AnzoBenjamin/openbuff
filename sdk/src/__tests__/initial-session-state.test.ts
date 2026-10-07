import { createHash } from 'node:crypto'
import * as nodeFsPromises from 'node:fs/promises'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import os from 'os'
import path from 'path'

import {
  describe,
  expect,
  test,
  beforeEach,
  mock,
} from 'bun:test'
import { getFileTokenScores } from '@codebuff/code-map/parse'
import { z } from 'zod/v4'

import {
  applyOverridesToSessionState,
  generateInitialRunState,
  initialSessionState,
  SESSION_STATE_MAX_TOTAL_PARSE_BYTES,
} from '../run-state'
import { saveMergedTaskMemory } from '../services/task-memory-store'

import type { MockStatResult } from '@codebuff/common/testing/mock-types'
import type { Logger } from '@codebuff/common/types/contracts/logger'
import type { CodebuffFileSystem } from '@codebuff/common/types/filesystem'
import type { SessionState } from '@codebuff/common/types/session-state'

describe('Initial Session State', () => {
  let mockFs: CodebuffFileSystem
  let mockLogger: Logger

  beforeEach(() => {
    mockFs = {
      readFile: async (path: string) => {
        if (path.includes('src/index.ts')) {
          return 'console.log("Hello world");'
        }
        if (path.includes('src/utils.ts')) {
          return 'export function add(a: number, b: number) { return a + b; }'
        }
        if (path.includes('knowledge.md')) {
          return '# Knowledge\n\nThis is a knowledge file.'
        }
        if (path.includes('README.md')) {
          return '# Project\n\nThis is a readme.'
        }
        if (path.includes('.gitignore')) {
          return 'node_modules/\n.git/'
        }
        if (path.includes('.codebuffignore')) {
          return ''
        }
        throw new Error(`File not found: ${path}`)
      },
      readdir: async (path: string) => {
        if (path.includes('test-project')) {
          return [
            { name: 'src', isDirectory: () => true, isFile: () => false },
            { name: '.git', isDirectory: () => true, isFile: () => false },
            {
              name: 'knowledge.md',
              isDirectory: () => false,
              isFile: () => true,
            },
            { name: 'README.md', isDirectory: () => false, isFile: () => true },
            {
              name: '.gitignore',
              isDirectory: () => false,
              isFile: () => true,
            },
          ]
        }
        if (path.includes('src')) {
          return [
            { name: 'index.ts', isDirectory: () => false, isFile: () => true },
            { name: 'utils.ts', isDirectory: () => false, isFile: () => true },
          ]
        }
        return []
      },
      stat: async (path: string): Promise<MockStatResult> => ({
        isDirectory: () => path.includes('src') || path.includes('.git'),
        isFile: () => !path.includes('src') && !path.includes('.git'),
      }),
      exists: async (path: string) => {
        if (path.includes('.gitignore')) return true
        if (path.includes('.codebuffignore')) return true
        if (path.includes('src')) return true
        if (path.includes('.git')) return true
        if (path.includes('knowledge.md')) return true
        if (path.includes('README.md')) return true
        return false
      },
      mkdir: async () => {},
      writeFile: async () => {},
    } as unknown as CodebuffFileSystem

    mockLogger = {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    }
  })

  test('creates initial session state with explicit projectFiles', async () => {
    const projectFiles = {
      'src/index.ts': 'console.log("Hello world");',
      'src/utils.ts':
        'export function add(a: number, b: number) { return a + b; }',
      'knowledge.md': '# Knowledge\n\nThis is a knowledge file.',
    }

    const sessionState = await initialSessionState({
      cwd: '/test-project',
      projectFiles,
      fs: mockFs,
      logger: mockLogger,
    })

    expect(sessionState.fileContext.fileTree).toBeDefined()
    expect(sessionState.fileContext.fileTree.length).toBeGreaterThan(0)
    expect(sessionState.fileContext.fileTokenScores).toBeDefined()
    expect(sessionState.mainAgentState.agentId).toBe('main-agent')
    expect(sessionState.mainAgentState.messageHistory).toEqual([])
  })

  test('discovers project files automatically when projectFiles is undefined', async () => {
    mockFs.readdir = (async (dirPath: string) => {
      if (dirPath === '/test-project') {
        return ['src', '.git', 'knowledge.md', 'README.md', '.gitignore']
      }
      if (dirPath === '/test-project/src') {
        return ['index.ts', 'utils.ts', 'generated.ts']
      }
      return []
    }) as CodebuffFileSystem['readdir']
    mockFs.stat = (async (filePath: string) =>
      ({
        isDirectory: () =>
          filePath === '/test-project/src' || filePath === '/test-project/.git',
        isFile: () =>
          filePath !== '/test-project/src' && filePath !== '/test-project/.git',
        size: filePath.endsWith('generated.ts') ? 1_000_001 : 100,
      }) as MockStatResult & { size: number }) as CodebuffFileSystem['stat']

    const readFilePaths: string[] = []
    const originalReadFile = mockFs.readFile
    mockFs.readFile = (async (filePath: string, encoding?: BufferEncoding) => {
      readFilePaths.push(filePath)
      return originalReadFile(filePath, encoding)
    }) as CodebuffFileSystem['readFile']

    const sessionState = await initialSessionState({
      cwd: '/test-project',
      projectFiles: undefined,
      fs: mockFs,
      logger: mockLogger,
    })

    expect(sessionState.fileContext.fileTree).toBeDefined()
    expect(sessionState.mainAgentState.agentId).toBe('main-agent')
    expect(sessionState.mainAgentState.messageHistory).toEqual([])
    expect(readFilePaths.some((p) => p.endsWith('src/index.ts'))).toBe(true)
    expect(readFilePaths.some((p) => p.endsWith('src/utils.ts'))).toBe(true)
    expect(readFilePaths.some((p) => p.endsWith('src/generated.ts'))).toBe(
      false,
    )
    expect(readFilePaths.some((p) => p.endsWith('README.md'))).toBe(false)
    expect(readFilePaths.some((p) => p.endsWith('knowledge.md'))).toBe(true)
  })

  test('skips discovered files when stat omits size', async () => {
    // The size cap fails closed: an adapter whose stat carries no `size` must
    // not have every discovered file read fully into memory just because the
    // cap cannot be evaluated.
    mockFs.readdir = (async (dirPath: string) => {
      if (dirPath === '/test-project') {
        return ['src', '.git', 'knowledge.md', 'README.md', '.gitignore']
      }
      if (dirPath === '/test-project/src') {
        return ['index.ts', 'utils.ts']
      }
      return []
    }) as CodebuffFileSystem['readdir']
    mockFs.stat = (async (filePath: string) =>
      ({
        isDirectory: () =>
          filePath === '/test-project/src' || filePath === '/test-project/.git',
        isFile: () =>
          filePath !== '/test-project/src' && filePath !== '/test-project/.git',
      }) as MockStatResult) as CodebuffFileSystem['stat']

    const readFilePaths: string[] = []
    const originalReadFile = mockFs.readFile
    mockFs.readFile = (async (filePath: string, encoding?: BufferEncoding) => {
      readFilePaths.push(filePath)
      return originalReadFile(filePath, encoding)
    }) as CodebuffFileSystem['readFile']

    await initialSessionState({
      cwd: '/test-project',
      projectFiles: undefined,
      fs: mockFs,
      logger: mockLogger,
    })

    expect(readFilePaths.some((p) => p.endsWith('src/index.ts'))).toBe(false)
    expect(readFilePaths.some((p) => p.endsWith('src/utils.ts'))).toBe(false)
    // Knowledge files are loaded directly rather than through the size-capped
    // discovered-project reader, so they must still be read.
    expect(readFilePaths.some((p) => p.endsWith('knowledge.md'))).toBe(true)
  })

  test('derives knowledgeFiles from projectFiles when not provided', async () => {
    const projectFiles = {
      'src/index.ts': 'console.log("Hello world");',
      'knowledge.md': '# Knowledge\n\nThis is a knowledge file.',
      'claude.md': '# Claude context\n\nThis is claude context.',
      'README.md': '# Project\n\nThis is a readme.',
    }

    const sessionState = await initialSessionState({
      cwd: '/test-project',
      projectFiles,
      knowledgeFiles: undefined,
      fs: mockFs,
      logger: mockLogger,
    })

    expect(sessionState.fileContext.knowledgeFiles).toBeDefined()
    expect(sessionState.fileContext.knowledgeFiles['knowledge.md']).toBe(
      '# Knowledge\n\nThis is a knowledge file.',
    )
    expect(sessionState.fileContext.knowledgeFiles['claude.md']).toBeUndefined()
    expect(sessionState.fileContext.knowledgeFiles['README.md']).toBeUndefined()
  })

  test('derives reads knowledgeFiles from claude.md when knowledge.md is not present', async () => {
    const projectFiles = {
      'src/index.ts': 'console.log("Hello world");',
      'claude.md': '# Claude context\n\nThis is claude context.',
      'README.md': '# Project\n\nThis is a readme.',
    }

    const sessionState = await initialSessionState({
      cwd: '/test-project',
      projectFiles,
      knowledgeFiles: undefined,
      fs: mockFs,
      logger: mockLogger,
    })

    expect(sessionState.fileContext.knowledgeFiles).toBeDefined()
    expect(
      sessionState.fileContext.knowledgeFiles['knowledge.md'],
    ).toBeUndefined()
    expect(sessionState.fileContext.knowledgeFiles['claude.md']).toEqual(
      '# Claude context\n\nThis is claude context.',
    )
    expect(sessionState.fileContext.knowledgeFiles['README.md']).toBeUndefined()
  })

  test('respects explicit knowledgeFiles when provided', async () => {
    const projectFiles = {
      'src/index.ts': 'console.log("Hello world");',
      'knowledge.md': '# Knowledge\n\nThis is a knowledge file.',
    }

    const knowledgeFiles = {
      'custom-knowledge.md': '# Custom Knowledge\n\nThis is custom knowledge.',
    }

    const sessionState = await initialSessionState({
      cwd: '/test-project',
      projectFiles,
      knowledgeFiles,
      fs: mockFs,
      logger: mockLogger,
    })

    expect(sessionState.fileContext.knowledgeFiles).toEqual(knowledgeFiles)
    expect(
      sessionState.fileContext.knowledgeFiles['knowledge.md'],
    ).toBeUndefined()
  })

  test('sets maxAgentSteps when provided', async () => {
    const projectFiles = {
      'src/index.ts': 'console.log("Hello world");',
    }

    const sessionState = await initialSessionState({
      cwd: '/test-project',
      projectFiles,
      maxAgentSteps: 10,
      fs: mockFs,
      logger: mockLogger,
    })

    expect(sessionState.mainAgentState.stepsRemaining).toBe(10)
  })

  test('includes custom agent definitions', async () => {
    const projectFiles = {
      'src/index.ts': 'console.log("Hello world");',
    }

    const agentDefinitions = [
      {
        id: 'custom-agent',
        displayName: 'Custom Agent',
        spawnerPrompt: 'A custom agent',
        model: 'anthropic/claude-4-sonnet-20250522',
        outputMode: 'last_message' as const,
        includeMessageHistory: false,
        inheritParentSystemPrompt: false,
        mcpServers: {},
        toolNames: [],
        spawnableAgents: [],
        inputSchema: {},
        systemPrompt: 'Custom system prompt',
        instructionsPrompt: '',
        stepPrompt: '',
      },
    ]

    const sessionState = await initialSessionState({
      cwd: '/test-project',
      projectFiles,
      agentDefinitions,
      fs: mockFs,
      logger: mockLogger,
    })

    expect(sessionState.fileContext.agentTemplates).toBeDefined()
    expect(
      sessionState.fileContext.agentTemplates['custom-agent'],
    ).toBeDefined()
    expect(
      sessionState.fileContext.agentTemplates['custom-agent'].displayName,
    ).toBe('Custom Agent')
  })

  test('includes custom tool definitions', async () => {
    const projectFiles = {
      'src/index.ts': 'console.log("Hello world");',
    }

    const inputSchema = z.object({ input: z.string() })
    const customToolDefinitions = [
      {
        toolName: 'custom_tool',
        inputSchema,
        description: 'A custom tool',
        endsAgentStep: false,
        exampleInputs: [],
        execute: async (input: any) => [],
      },
    ]

    const sessionState = await initialSessionState({
      cwd: '/test-project',
      projectFiles,
      customToolDefinitions,
      fs: mockFs,
      logger: mockLogger,
    })

    expect(sessionState.fileContext.customToolDefinitions).toBeDefined()
    expect(
      sessionState.fileContext.customToolDefinitions?.['custom_tool'],
    ).toBeDefined()
    expect(
      sessionState.fileContext.customToolDefinitions?.['custom_tool']
        ?.description,
    ).toBe('A custom tool')
  })

  test('populates system info correctly', async () => {
    const projectFiles = {
      'src/index.ts': 'console.log("Hello world");',
    }

    const sessionState = await initialSessionState({
      cwd: '/test-project',
      projectFiles,
      fs: mockFs,
      logger: mockLogger,
    })

    expect(sessionState.fileContext.systemInfo).toBeDefined()
    expect(sessionState.fileContext.systemInfo.platform).toBe(process.platform)
    expect(sessionState.fileContext.systemInfo.shell).toBeDefined()
    expect(sessionState.fileContext.systemInfo.nodeVersion).toBe(
      process.version,
    )
    expect(sessionState.fileContext.systemInfo.cpus).toBeGreaterThan(0)
  })

  test('loads skills from skillsDir when provided', async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'sdk-skills-test-'))
    try {
      const skillDir = path.join(tmpDir, 'my-skill')
      mkdirSync(skillDir, { recursive: true })
      writeFileSync(
        path.join(skillDir, 'SKILL.md'),
        [
          '---',
          'name: my-skill',
          'description: A test skill',
          '---',
          '',
          '# My Skill',
          '',
          'Some instructions here.',
        ].join('\n'),
      )

      const sessionState = await initialSessionState({
        cwd: '/test-project',
        skillsDir: tmpDir,
        projectFiles: { 'src/index.ts': 'console.log("hello");' },
        fs: mockFs,
        logger: mockLogger,
      })

      expect(sessionState.fileContext.skills).toBeDefined()
      expect(sessionState.fileContext.skills!['my-skill']).toBeDefined()
      expect(sessionState.fileContext.skills!['my-skill'].name).toBe('my-skill')
      expect(sessionState.fileContext.skills!['my-skill'].description).toBe(
        'A test skill',
      )
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  test('skillsDir with no valid skills results in empty skills map', async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'sdk-skills-test-'))
    try {
      const sessionState = await initialSessionState({
        cwd: '/test-project',
        skillsDir: tmpDir,
        projectFiles: { 'src/index.ts': 'console.log("hello");' },
        fs: mockFs,
        logger: mockLogger,
      })

      expect(sessionState.fileContext.skills).toBeDefined()
      expect(Object.keys(sessionState.fileContext.skills!)).toHaveLength(0)
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  test('initializes empty agent state correctly', async () => {
    const projectFiles = {
      'src/index.ts': 'console.log("Hello world");',
    }

    const sessionState = await initialSessionState({
      cwd: '/test-project',
      projectFiles,
      fs: mockFs,
      logger: mockLogger,
    })

    expect(sessionState.mainAgentState.agentId).toBe('main-agent')
    expect(sessionState.mainAgentState.agentType).toBeNull()
    expect(sessionState.mainAgentState.agentContext).toEqual({})
    expect(sessionState.mainAgentState.ancestorRunIds).toEqual([])
    expect(sessionState.mainAgentState.subagents).toEqual([])
    expect(sessionState.mainAgentState.childRunIds).toEqual([])
    expect(sessionState.mainAgentState.messageHistory).toEqual([])
    expect(sessionState.mainAgentState.creditsUsed).toBe(0)
    expect(sessionState.mainAgentState.directCreditsUsed).toBe(0)
    expect(sessionState.mainAgentState.output).toBeUndefined()
    expect(sessionState.mainAgentState.parentId).toBeUndefined()
  })

  test('refreshes live file context when continuing a session', async () => {
    const projectRoot = mkdtempSync(path.join(os.tmpdir(), 'openbuff-resume-'))
    try {
      mkdirSync(path.join(projectRoot, 'src'))
      writeFileSync(
        path.join(projectRoot, 'src', 'index.ts'),
        'export const current = true',
      )
      writeFileSync(
        path.join(projectRoot, 'knowledge.md'),
        '# Current knowledge',
      )
      const sessionState = await initialSessionState({
        cwd: projectRoot,
        projectFiles: {
          'src/deleted.ts': 'export const deleted = true',
          'knowledge.md': '# Old knowledge',
        },
        logger: mockLogger,
      })

      const continued = await applyOverridesToSessionState(
        projectRoot,
        sessionState,
        {},
        { logger: mockLogger },
      )
      const renderedTree = JSON.stringify(continued.fileContext.fileTree)

      expect(renderedTree).toContain('index.ts')
      expect(renderedTree).not.toContain('deleted.ts')
      expect(continued.fileContext.knowledgeFiles['knowledge.md']).toContain(
        'Current knowledge',
      )
    } finally {
      rmSync(projectRoot, { recursive: true, force: true })
    }
  })

  test('hydrates persisted task memory and rebinds evidence via workspaceMoves', async () => {
    const projectRoot = mkdtempSync(path.join(os.tmpdir(), 'hydrate-memory-'))
    try {
      // Seed a checksum-consistent persisted record whose evidence points at
      // a file that has since been renamed on disk.
      await saveMergedTaskMemory({
        rootDir: projectRoot,
        runMemory: {
          schemaVersion: 1,
          goal: 'Cross-session work',
          requirements: [],
          decisions: ['Prefer content hashes'],
          filesInspected: [],
          editsMade: [],
          validationResults: [],
          reviewReceipts: [],
          blockers: [],
          nextActions: [],
          historicalSummary: '',
          evidence: [
            {
              id: 'ev-move',
              kind: 'read',
              summary: 'Read old-name.ts',
              path: 'old-name.ts',
              freshnessHash: createHash('sha256')
                .update('moved body')
                .digest('hex'),
            },
          ],
          revision: 0,
          updatedAt: 1_000,
          checksum: 'replaced-by-save',
        },
      })
      mkdirSync(path.join(projectRoot, 'lib'), { recursive: true })
      writeFileSync(path.join(projectRoot, 'lib', 'new-name.ts'), 'moved body')
      rmSync(path.join(projectRoot, 'old-name.ts'), { force: true })

      const sessionState = await initialSessionState({
        cwd: projectRoot,
        workspaceMoves: [{ from: 'old-name.ts', to: 'lib/new-name.ts' }],
        logger: mockLogger,
      })

      expect(sessionState.mainAgentState.taskMemory?.decisions).toEqual([
        'Prefer content hashes',
      ])
      expect(sessionState.mainAgentState.taskMemory?.evidence[0]?.path).toBe(
        'lib/new-name.ts',
      )
      expect(sessionState.mainAgentState.taskMemory?.evidence[0]?.stale).toBe(
        false,
      )
    } finally {
      rmSync(projectRoot, { recursive: true, force: true })
    }
  })

  test('generateInitialRunState forwards persistentMemory and workspaceMoves', async () => {
    const projectRoot = mkdtempSync(path.join(os.tmpdir(), 'gen-run-state-'))
    try {
      // Seed a checksum-consistent persisted record whose evidence points at
      // a file that has since been renamed on disk.
      await saveMergedTaskMemory({
        rootDir: projectRoot,
        runMemory: {
          schemaVersion: 1,
          goal: 'Wrapper hydration',
          requirements: [],
          decisions: ['Forward wrapper options'],
          filesInspected: [],
          editsMade: [],
          validationResults: [],
          reviewReceipts: [],
          blockers: [],
          nextActions: [],
          historicalSummary: '',
          evidence: [
            {
              id: 'ev-wrapper',
              kind: 'read',
              summary: 'Read old-name.ts',
              path: 'old-name.ts',
              freshnessHash: createHash('sha256')
                .update('moved body')
                .digest('hex'),
            },
          ],
          revision: 0,
          updatedAt: 1_000,
          checksum: 'replaced-by-save',
        },
      })
      mkdirSync(path.join(projectRoot, 'lib'), { recursive: true })
      writeFileSync(path.join(projectRoot, 'lib', 'new-name.ts'), 'moved body')
      rmSync(path.join(projectRoot, 'old-name.ts'), { force: true })

      const fs = nodeFsPromises as unknown as CodebuffFileSystem

      // persistentMemory:false must flow through the wrapper.
      const withoutMemory = await generateInitialRunState({
        cwd: projectRoot,
        persistentMemory: false,
        fs,
        logger: mockLogger,
      })
      expect(
        withoutMemory.sessionState?.mainAgentState.taskMemory,
      ).toBeUndefined()

      // workspaceMoves must flow through the wrapper and rebind evidence.
      const withMoves = await generateInitialRunState({
        cwd: projectRoot,
        workspaceMoves: [{ from: 'old-name.ts', to: 'lib/new-name.ts' }],
        fs,
        logger: mockLogger,
      })
      expect(
        withMoves.sessionState?.mainAgentState.taskMemory?.decisions,
      ).toEqual(['Forward wrapper options'])
      expect(
        withMoves.sessionState?.mainAgentState.taskMemory?.evidence[0]?.path,
      ).toBe('lib/new-name.ts')
      expect(
        withMoves.sessionState?.mainAgentState.taskMemory?.evidence[0]?.stale,
      ).toBe(false)
    } finally {
      rmSync(projectRoot, { recursive: true, force: true })
    }
  })

  test('persistentMemory:false leaves taskMemory unset even when a record exists', async () => {
    const projectRoot = mkdtempSync(path.join(os.tmpdir(), 'hydrate-off-'))
    try {
      await saveMergedTaskMemory({
        rootDir: projectRoot,
        runMemory: {
          schemaVersion: 1,
          goal: 'Should not hydrate',
          requirements: [],
          decisions: [],
          filesInspected: [],
          editsMade: [],
          validationResults: [],
          reviewReceipts: [],
          blockers: [],
          nextActions: [],
          historicalSummary: '',
          evidence: [],
          revision: 0,
          updatedAt: 1_000,
          checksum: 'replaced-by-save',
        },
      })

      const sessionState = await initialSessionState({
        cwd: projectRoot,
        persistentMemory: false,
        logger: mockLogger,
      })

      expect(sessionState.mainAgentState.taskMemory).toBeUndefined()
    } finally {
      rmSync(projectRoot, { recursive: true, force: true })
    }
  })

  test('applyOverridesToSessionState preserves compactionArchive and contextConsolidations', async () => {
    // P2-T2 slice 1: the wholesale JSON clone in applyOverridesToSessionState
    // is the existing restore contract — it must PRESERVE unknown/optional
    // AgentState fields so a resumed run can recall archived pre-compaction
    // facts (recall_context) from a previous session's archive, including a
    // D26 `tool_result_eviction` snapshot and background consolidations.
    // Tool content legitimately contains token-like keys; inside the
    // archived json STRING body `refreshTokenCount` is ordinary data.
    const compactionArchive = [
      {
        archivedAt: 4_000,
        action: 'tool_result_eviction',
        keepRecentSteps: 0,
        steps: [9],
        reason: 'deterministic tool-result eviction (stale recency)',
        messages: [
          {
            role: 'tool',
            toolCallId: 'call-3',
            toolName: 'read_files',
            content: [
              {
                type: 'json',
                value:
                  JSON.stringify({
                    note: 'evicted body',
                    refreshTokenCount: 3,
                  }) + '='.repeat(1_500),
              },
            ],
          },
        ],
      },
    ]
    const contextConsolidations = [
      {
        consolidatedAt: 4_100,
        sourceArchivedAts: [4_000],
        action: 'semantic_compaction',
        summary: 'Compacted read of src/auth.ts; refreshTokenCount=3 verbatim.',
        coveredMessages: 1,
      },
    ]
    const baseSessionState = {
      mainAgentState: {
        agentId: 'main',
        agentType: null,
        agentContext: {},
        subagents: [],
        messageHistory: [],
        stepsRemaining: 5,
        compactionArchive,
        contextConsolidations,
      },
      fileContext: {
        fileTreeSource: 'live',
        fileTree: [],
        fileTokenScores: {},
        tokenCallers: {},
        knowledgeFiles: {},
        userKnowledgeFiles: {},
        agentTemplates: {},
        customToolDefinitions: {},
        skills: [],
        systemInfo: {},
      },
    } as unknown as SessionState

    const restored = await applyOverridesToSessionState(
      undefined,
      baseSessionState,
      {},
      { logger: mockLogger },
    )
    const restoredMainAgentState = restored.mainAgentState as unknown as {
      compactionArchive?: unknown[]
      contextConsolidations?: unknown[]
    }

    // Both optional fields survive the restore clone deep-equal.
    expect(restoredMainAgentState.compactionArchive).toEqual(compactionArchive)
    expect(restoredMainAgentState.contextConsolidations).toEqual(
      contextConsolidations,
    )

    // No sanitizer corruption markers in the restored archive subtree.
    const serialized = JSON.stringify(restoredMainAgentState.compactionArchive)
    expect(serialized).not.toContain('[Openbuff truncated')
    expect(serialized).not.toContain('[REDACTED]')
    expect(serialized).toContain('refreshTokenCount')
  })

  test('bounds session-boot parse with a maxTotalBytes budget override', async () => {
    // The session-boot budget is a hard constant, not an indexer-grade
    // default: it must stay small enough that cold start cannot spend
    // unbounded wall-clock time in the tree-sitter pass.
    expect(SESSION_STATE_MAX_TOTAL_PARSE_BYTES).toBe(64_000_000)

    const realGetFileTokenScores = getFileTokenScores
    const calls: unknown[][] = []
    mock.module('@codebuff/code-map/parse', () => ({
      getFileTokenScores: async (...callArgs: unknown[]) => {
        calls.push(callArgs)
        return {
          tokenScores: {},
          tokenCallers: {},
          coverage: {
            truncated: false,
            fileBudgetExceeded: false,
            byteBudgetExceeded: false,
            parsedFiles: 1,
            skippedFiles: 0,
          },
        }
      },
    }))
    try {
      const sessionState = await initialSessionState({
        cwd: '/test-project',
        projectFiles: { 'src/index.ts': 'console.log("Hello world");' },
        fs: mockFs,
        logger: mockLogger,
      })

      // The budget override must reach getFileTokenScores as its 5th
      // positional argument, after the unused reuseParsed slot.
      expect(calls.length).toBeGreaterThan(0)
      expect(calls[0]?.[3]).toBeUndefined()
      expect(calls[0]?.[4]).toEqual({
        maxTotalBytes: SESSION_STATE_MAX_TOTAL_PARSE_BYTES,
      })
      expect(sessionState.fileContext.fileTokenScores).toBeDefined()
    } finally {
      mock.module('@codebuff/code-map/parse', () => ({
        getFileTokenScores: realGetFileTokenScores,
      }))
    }
  })

  test('logs debug when session-state parse budget truncates token scoring', async () => {
    const realGetFileTokenScores = getFileTokenScores
    const debugCalls: Array<{ payload: unknown; message?: string }> = []
    const capturingLogger: Logger = {
      ...mockLogger,
      debug: (payload: unknown, message?: string) => {
        debugCalls.push({ payload, message })
      },
    }
    mock.module('@codebuff/code-map/parse', () => ({
      getFileTokenScores: async () => ({
        tokenScores: {},
        tokenCallers: {},
        coverage: {
          truncated: true,
          fileBudgetExceeded: false,
          byteBudgetExceeded: true,
          parsedFiles: 3,
          skippedFiles: 2,
        },
      }),
    }))
    try {
      await initialSessionState({
        cwd: '/test-project',
        projectFiles: { 'src/index.ts': 'console.log("Hello world");' },
        fs: mockFs,
        logger: capturingLogger,
      })

      // Truncation is surfaced at debug level only, with coverage counts and
      // the budget that triggered it.
      const truncationLog = debugCalls.find(
        (call) =>
          call.message ===
          'Session-state parse budget truncated token scoring',
      )
      expect(truncationLog).toBeDefined()
      expect(truncationLog?.payload).toEqual({
        parsedFiles: 3,
        skippedFiles: 2,
        maxTotalBytes: SESSION_STATE_MAX_TOTAL_PARSE_BYTES,
      })
    } finally {
      mock.module('@codebuff/code-map/parse', () => ({
        getFileTokenScores: realGetFileTokenScores,
      }))
    }
  })
})

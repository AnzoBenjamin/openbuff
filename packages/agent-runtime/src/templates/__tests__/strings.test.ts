import { TEST_AGENT_RUNTIME_IMPL } from '@codebuff/common/testing/impl/agent-runtime'
import {
  frontendSection,
  gitDisciplineSection,
} from '@codebuff/common/constants/prompt-sections'
import {
  BROAD_AUDIT_FALLBACK_SECTIONS,
  FALLBACK_GUIDES,
  GUIDE_FALLBACK_SECTIONS,
} from '@codebuff/common/util/guides'
import { describe, test, expect, mock } from 'bun:test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { z } from 'zod/v4'

import { PLACEHOLDER } from '../types'
import { formatCurrentDate, getAgentPrompt } from '../strings'
import {
  formatCompactAgentCatalogLine,
  getRequiredAgentParamKeys,
} from '../prompts'
import { createBudgetLedger } from '../../util/context-budget'
import gitCommitter from '../../../../../agents/git-committer/git-committer'
import librarian from '../../../../../agents/librarian/librarian'
import dependencyManager from '../../../../../agents/dependency-manager/dependency-manager'
import securityReviewer from '../../../../../agents/security-reviewer/security-reviewer'
import codeSearcher from '../../../../../agents/file-explorer/code-searcher'
import globMatcher from '../../../../../agents/file-explorer/glob-matcher'
import directoryLister from '../../../../../agents/file-explorer/directory-lister'
import basher from '../../../../../agents/basher'
import repairEditor from '../../../../../agents/editor/repair-editor'
import compatibilityReviewer from '../../../../../agents/specialists/compatibility-reviewer'
import { createBase2, GUIDE_POINTERS } from '../../../../../agents/base2/base2'

import type { AgentTemplate } from '../types'
import type { ContextBudgetLedger } from '../../util/context-budget'
import type { AgentState } from '@codebuff/common/types/session-state'
import type { ProjectFileContext } from '@codebuff/common/util/file'

/** Create a mock logger using bun:test mock() for better test consistency */
const createMockLogger = () => ({
  debug: mock(() => {}),
  info: mock(() => {}),
  warn: mock(() => {}),
  error: mock(() => {}),
})

const createMockFileContext = (
  overrides: Partial<ProjectFileContext> = {},
): ProjectFileContext => ({
  projectRoot: '/test',
  cwd: '/test',
  fileTree: [],
  fileTokenScores: {},
  knowledgeFiles: {},
  gitChanges: {
    status: '',
    diff: '',
    diffCached: '',
    lastCommitMessages: '',
  },
  changesSinceLastChat: {},
  shellConfigFiles: {},
  agentTemplates: {},
  customToolDefinitions: {},
  systemInfo: {
    platform: 'test',
    shell: 'test',
    nodeVersion: 'test',
    arch: 'test',
    homedir: '/home/test',
    cpus: 1,
    chromeAvailable: false,
  },
  ...overrides,
})

const createMockAgentState = (agentType: string): AgentState => ({
  agentId: 'test-agent-id',
  agentType,
  runId: 'test-run-id',
  parentId: undefined,
  messageHistory: [],
  output: undefined,
  stepsRemaining: 10,
  creditsUsed: 0,
  directCreditsUsed: 0,
  cacheInputTokens: 0,
  cacheTotalInputTokens: 0,
  childRunIds: [],
  ancestorRunIds: [],
  contextTokenCount: 0,
  agentContext: {},
  subagents: [],
  systemPrompt: '',
  toolDefinitions: {},
})

const createMockAgentTemplate = (
  overrides: Partial<AgentTemplate> = {},
): AgentTemplate => ({
  id: 'test-agent',
  displayName: 'Test Agent',
  model: 'gpt-4o-mini',
  inputSchema: {},
  outputMode: 'last_message',
  includeMessageHistory: false,
  inheritParentSystemPrompt: false,
  mcpServers: {},
  toolNames: [],
  spawnableAgents: [],
  systemPrompt: '',
  instructionsPrompt: 'Test instructions',
  stepPrompt: '',
  ...overrides,
})

describe('getAgentPrompt', () => {
  test('replaces CURRENT_DATE when formatting prompts', async () => {
    const agentTemplate = createMockAgentTemplate({
      id: 'date-agent',
      systemPrompt: `Today is ${PLACEHOLDER.CURRENT_DATE}.`,
    })
    const agentTemplates: Record<string, AgentTemplate> = {
      'date-agent': agentTemplate,
    }

    const result = await getAgentPrompt({
      agentTemplate,
      promptType: { type: 'systemPrompt' },
      fileContext: createMockFileContext(),
      agentState: createMockAgentState('date-agent'),
      agentTemplates,
      additionalToolDefinitions: async () => ({}),
      logger: createMockLogger(),
      apiKey: TEST_AGENT_RUNTIME_IMPL.apiKey,
      databaseAgentCache: TEST_AGENT_RUNTIME_IMPL.databaseAgentCache,
      fetchAgentFromDatabase: TEST_AGENT_RUNTIME_IMPL.fetchAgentFromDatabase,
    })

    expect(result).toBe(`Today is ${formatCurrentDate(new Date())}.`)
    expect(result).not.toContain(PLACEHOLDER.CURRENT_DATE)
  })

  test('formats current date for prompts', () => {
    expect(formatCurrentDate(new Date(2026, 4, 22, 12))).toBe('May 22, 2026')
  })

  test('omits frontend section when file tree has no frontend files', async () => {
    const agentTemplate = createMockAgentTemplate({
      id: 'frontend-agent',
      systemPrompt: `Before${PLACEHOLDER.FRONTEND_SECTION}After`,
    })
    const agentTemplates: Record<string, AgentTemplate> = {
      'frontend-agent': agentTemplate,
    }

    const result = await getAgentPrompt({
      agentTemplate,
      promptType: { type: 'systemPrompt' },
      fileContext: createMockFileContext({
        fileTree: [
          {
            name: 'main.py',
            type: 'file',
            filePath: 'main.py',
            lastReadTime: 0,
          },
        ],
      }),
      agentState: createMockAgentState('frontend-agent'),
      agentTemplates,
      additionalToolDefinitions: async () => ({}),
      logger: createMockLogger(),
      apiKey: TEST_AGENT_RUNTIME_IMPL.apiKey,
      databaseAgentCache: TEST_AGENT_RUNTIME_IMPL.databaseAgentCache,
      fetchAgentFromDatabase: TEST_AGENT_RUNTIME_IMPL.fetchAgentFromDatabase,
    })

    expect(result).toBe('BeforeAfter')
    expect(result).not.toContain(frontendSection)
    expect(result).not.toContain(PLACEHOLDER.FRONTEND_SECTION)
  })

  test('includes frontend section when file tree has tsx or jsx files', async () => {
    const agentTemplate = createMockAgentTemplate({
      id: 'frontend-agent',
      systemPrompt: `Before\n${PLACEHOLDER.FRONTEND_SECTION}\nAfter`,
    })
    const agentTemplates: Record<string, AgentTemplate> = {
      'frontend-agent': agentTemplate,
    }

    const result = await getAgentPrompt({
      agentTemplate,
      promptType: { type: 'systemPrompt' },
      fileContext: createMockFileContext({
        fileTree: [
          {
            name: 'src',
            type: 'directory',
            filePath: 'src',
            children: [
              {
                name: 'App.tsx',
                type: 'file',
                filePath: 'src/App.tsx',
                lastReadTime: 0,
              },
            ],
          },
        ],
      }),
      agentState: createMockAgentState('frontend-agent'),
      agentTemplates,
      additionalToolDefinitions: async () => ({}),
      logger: createMockLogger(),
      apiKey: TEST_AGENT_RUNTIME_IMPL.apiKey,
      databaseAgentCache: TEST_AGENT_RUNTIME_IMPL.databaseAgentCache,
      fetchAgentFromDatabase: TEST_AGENT_RUNTIME_IMPL.fetchAgentFromDatabase,
    })

    expect(result).toContain(frontendSection)
    expect(result).not.toContain(PLACEHOLDER.FRONTEND_SECTION)
  })

  test('includes language profile section for detected supported languages', async () => {
    const agentTemplate = createMockAgentTemplate({
      id: 'language-agent',
      systemPrompt: `Before\n${PLACEHOLDER.LANGUAGE_PROFILE}\nAfter`,
    })
    const agentTemplates: Record<string, AgentTemplate> = {
      'language-agent': agentTemplate,
    }

    const result = await getAgentPrompt({
      agentTemplate,
      promptType: { type: 'systemPrompt' },
      fileContext: createMockFileContext({
        fileTree: [
          {
            name: 'package.json',
            type: 'file',
            filePath: 'package.json',
            lastReadTime: 0,
          },
          {
            name: 'src',
            type: 'directory',
            filePath: 'src',
            children: [
              {
                name: 'main.py',
                type: 'file',
                filePath: 'src/main.py',
                lastReadTime: 0,
              },
            ],
          },
        ],
      }),
      agentState: createMockAgentState('language-agent'),
      intitialAgentPrompt: 'Update src/main.py without changing package.json.',
      agentTemplates,
      additionalToolDefinitions: async () => ({}),
      logger: createMockLogger(),
      apiKey: TEST_AGENT_RUNTIME_IMPL.apiKey,
      databaseAgentCache: TEST_AGENT_RUNTIME_IMPL.databaseAgentCache,
      fetchAgentFromDatabase: TEST_AGENT_RUNTIME_IMPL.fetchAgentFromDatabase,
    })

    expect(result).toContain('## Language profile')
    expect(result).toContain('Detected: Python')
    expect(result).not.toContain('TypeScript/JavaScript')
    expect(result).toContain('Keep resource lifetimes in context managers')
    expect(result).not.toContain('agents/idioms/')
    expect(result).not.toContain(
      'Prefer precise TypeScript types over broad casts',
    )
    expect(result).not.toContain(PLACEHOLDER.LANGUAGE_PROFILE)
  })

  test('omits language profile section when no supported language is detected', async () => {
    const agentTemplate = createMockAgentTemplate({
      id: 'language-agent',
      systemPrompt: `Before${PLACEHOLDER.LANGUAGE_PROFILE}After`,
    })
    const agentTemplates: Record<string, AgentTemplate> = {
      'language-agent': agentTemplate,
    }

    const result = await getAgentPrompt({
      agentTemplate,
      promptType: { type: 'systemPrompt' },
      fileContext: createMockFileContext({
        fileTree: [
          {
            name: 'README.md',
            type: 'file',
            filePath: 'README.md',
            lastReadTime: 0,
          },
        ],
      }),
      agentState: createMockAgentState('language-agent'),
      agentTemplates,
      additionalToolDefinitions: async () => ({}),
      logger: createMockLogger(),
      apiKey: TEST_AGENT_RUNTIME_IMPL.apiKey,
      databaseAgentCache: TEST_AGENT_RUNTIME_IMPL.databaseAgentCache,
      fetchAgentFromDatabase: TEST_AGENT_RUNTIME_IMPL.fetchAgentFromDatabase,
    })

    expect(result).toBe('BeforeAfter')
    expect(result).not.toContain('## Language profile')
    expect(result).not.toContain(PLACEHOLDER.LANGUAGE_PROFILE)
  })

  test('includes engine profile section for a Unity game-dev project', async () => {
    const agentTemplate = createMockAgentTemplate({
      id: 'game-engine-agent',
      systemPrompt: `Before\n${PLACEHOLDER.LANGUAGE_PROFILE}\nAfter`,
    })
    const agentTemplates: Record<string, AgentTemplate> = {
      'game-engine-agent': agentTemplate,
    }

    const result = await getAgentPrompt({
      agentTemplate,
      promptType: { type: 'systemPrompt' },
      fileContext: createMockFileContext({
        fileTree: [
          {
            name: 'ProjectSettings',
            type: 'directory',
            filePath: 'ProjectSettings',
            children: [
              {
                name: 'ProjectVersion.txt',
                type: 'file',
                filePath: 'ProjectSettings/ProjectVersion.txt',
                lastReadTime: 0,
              },
            ],
          },
          {
            name: 'Assets',
            type: 'directory',
            filePath: 'Assets',
            children: [
              {
                name: 'Main.unity',
                type: 'file',
                filePath: 'Assets/Scenes/Main.unity',
                lastReadTime: 0,
              },
            ],
          },
        ],
      }),
      agentState: createMockAgentState('game-engine-agent'),
      agentTemplates,
      additionalToolDefinitions: async () => ({}),
      logger: createMockLogger(),
      apiKey: TEST_AGENT_RUNTIME_IMPL.apiKey,
      databaseAgentCache: TEST_AGENT_RUNTIME_IMPL.databaseAgentCache,
      fetchAgentFromDatabase: TEST_AGENT_RUNTIME_IMPL.fetchAgentFromDatabase,
    })

    // Should contain the engine profile section
    expect(result).toContain('## Engine profile')
    expect(result).toContain('Detected: Unity')
    expect(result).toContain('game-engine project')
    // The placeholder should be fully replaced
    expect(result).not.toContain(PLACEHOLDER.LANGUAGE_PROFILE)
  })

  test('omits engine profile section for non-game projects', async () => {
    const agentTemplate = createMockAgentTemplate({
      id: 'non-game-agent',
      systemPrompt: `Before\n${PLACEHOLDER.LANGUAGE_PROFILE}\nAfter`,
    })
    const agentTemplates: Record<string, AgentTemplate> = {
      'non-game-agent': agentTemplate,
    }

    const result = await getAgentPrompt({
      agentTemplate,
      promptType: { type: 'systemPrompt' },
      fileContext: createMockFileContext({
        fileTree: [
          {
            name: 'package.json',
            type: 'file',
            filePath: 'package.json',
            lastReadTime: 0,
          },
          {
            name: 'src',
            type: 'directory',
            filePath: 'src',
            children: [
              {
                name: 'index.ts',
                type: 'file',
                filePath: 'src/index.ts',
                lastReadTime: 0,
              },
            ],
          },
        ],
      }),
      agentState: createMockAgentState('non-game-agent'),
      agentTemplates,
      additionalToolDefinitions: async () => ({}),
      logger: createMockLogger(),
      apiKey: TEST_AGENT_RUNTIME_IMPL.apiKey,
      databaseAgentCache: TEST_AGENT_RUNTIME_IMPL.databaseAgentCache,
      fetchAgentFromDatabase: TEST_AGENT_RUNTIME_IMPL.fetchAgentFromDatabase,
    })

    // Should contain language profile but NOT engine profile
    expect(result).toContain('## Language profile')
    expect(result).not.toContain('## Engine profile')
    expect(result).not.toContain('game-engine project')
    expect(result).not.toContain(PLACEHOLDER.LANGUAGE_PROFILE)
  })

  describe('spawnerPrompt inclusion in instructionsPrompt', () => {
    test('includes spawnerPrompt for each spawnable agent with spawnerPrompt defined', async () => {
      const filePickerTemplate = createMockAgentTemplate({
        id: 'file-picker',
        displayName: 'File Picker',
        spawnerPrompt: 'Spawn to find relevant files in a codebase',
      })

      const codeSearcherTemplate = createMockAgentTemplate({
        id: 'code-searcher',
        displayName: 'Code Searcher',
        spawnerPrompt: 'Mechanically runs multiple code search queries',
      })

      const mainAgentTemplate = createMockAgentTemplate({
        id: 'main-agent',
        displayName: 'Main Agent',
        spawnableAgents: ['file-picker', 'code-searcher'],
        instructionsPrompt: 'Main agent instructions.',
      })

      const agentTemplates: Record<string, AgentTemplate> = {
        'main-agent': mainAgentTemplate,
        'file-picker': filePickerTemplate,
        'code-searcher': codeSearcherTemplate,
      }

      const result = await getAgentPrompt({
        agentTemplate: mainAgentTemplate,
        promptType: { type: 'instructionsPrompt' },
        fileContext: createMockFileContext(),
        agentState: createMockAgentState('main-agent'),
        agentTemplates,
        additionalToolDefinitions: async () => ({}),
        logger: createMockLogger(),
        apiKey: TEST_AGENT_RUNTIME_IMPL.apiKey,
        databaseAgentCache: TEST_AGENT_RUNTIME_IMPL.databaseAgentCache,
        fetchAgentFromDatabase: TEST_AGENT_RUNTIME_IMPL.fetchAgentFromDatabase,
      })

      expect(result).toBeDefined()
      expect(result).toContain('You can spawn the following agents:')
      expect(result).toContain(
        '- file-picker: Spawn to find relevant files in a codebase',
      )
      expect(result).toContain(
        '- code-searcher: Mechanically runs multiple code search queries',
      )
    })

    test('includes only agent name when spawnerPrompt is not defined', async () => {
      const agentWithoutSpawnerPrompt = createMockAgentTemplate({
        id: 'no-prompt-agent',
        displayName: 'No Prompt Agent',
        // spawnerPrompt is not defined
      })

      const mainAgentTemplate = createMockAgentTemplate({
        id: 'main-agent',
        displayName: 'Main Agent',
        spawnableAgents: ['no-prompt-agent'],
        instructionsPrompt: 'Main agent instructions.',
      })

      const agentTemplates: Record<string, AgentTemplate> = {
        'main-agent': mainAgentTemplate,
        'no-prompt-agent': agentWithoutSpawnerPrompt,
      }

      const result = await getAgentPrompt({
        agentTemplate: mainAgentTemplate,
        promptType: { type: 'instructionsPrompt' },
        fileContext: createMockFileContext(),
        agentState: createMockAgentState('main-agent'),
        agentTemplates,
        additionalToolDefinitions: async () => ({}),
        logger: createMockLogger(),
        apiKey: TEST_AGENT_RUNTIME_IMPL.apiKey,
        databaseAgentCache: TEST_AGENT_RUNTIME_IMPL.databaseAgentCache,
        fetchAgentFromDatabase: TEST_AGENT_RUNTIME_IMPL.fetchAgentFromDatabase,
      })

      expect(result).toBeDefined()
      expect(result).toContain('You can spawn the following agents:')
      expect(result).toContain('- no-prompt-agent')
      // Should not have a colon after the agent name when there's no spawnerPrompt
      expect(result).not.toContain('- no-prompt-agent:')
    })

    test('handles mix of agents with and without spawnerPrompt', async () => {
      const agentWithPrompt = createMockAgentTemplate({
        id: 'with-prompt',
        displayName: 'Agent With Prompt',
        spawnerPrompt: 'This agent has a description',
      })

      const agentWithoutPrompt = createMockAgentTemplate({
        id: 'without-prompt',
        displayName: 'Agent Without Prompt',
        // spawnerPrompt is not defined
      })

      const mainAgentTemplate = createMockAgentTemplate({
        id: 'main-agent',
        displayName: 'Main Agent',
        spawnableAgents: ['with-prompt', 'without-prompt'],
        instructionsPrompt: 'Main agent instructions.',
      })

      const agentTemplates: Record<string, AgentTemplate> = {
        'main-agent': mainAgentTemplate,
        'with-prompt': agentWithPrompt,
        'without-prompt': agentWithoutPrompt,
      }

      const result = await getAgentPrompt({
        agentTemplate: mainAgentTemplate,
        promptType: { type: 'instructionsPrompt' },
        fileContext: createMockFileContext(),
        agentState: createMockAgentState('main-agent'),
        agentTemplates,
        additionalToolDefinitions: async () => ({}),
        logger: createMockLogger(),
        apiKey: TEST_AGENT_RUNTIME_IMPL.apiKey,
        databaseAgentCache: TEST_AGENT_RUNTIME_IMPL.databaseAgentCache,
        fetchAgentFromDatabase: TEST_AGENT_RUNTIME_IMPL.fetchAgentFromDatabase,
      })

      expect(result).toBeDefined()
      expect(result).toContain('- with-prompt: This agent has a description')
      expect(result).toContain('- without-prompt')
      expect(result).not.toContain('- without-prompt:')
    })

    test('does not include spawnable agents section when no spawnable agents defined', async () => {
      const mainAgentTemplate = createMockAgentTemplate({
        id: 'main-agent',
        displayName: 'Main Agent',
        spawnableAgents: [],
        instructionsPrompt: 'Main agent instructions.',
      })

      const agentTemplates: Record<string, AgentTemplate> = {
        'main-agent': mainAgentTemplate,
      }

      const result = await getAgentPrompt({
        agentTemplate: mainAgentTemplate,
        promptType: { type: 'instructionsPrompt' },
        fileContext: createMockFileContext(),
        agentState: createMockAgentState('main-agent'),
        agentTemplates,
        additionalToolDefinitions: async () => ({}),
        logger: createMockLogger(),
        apiKey: TEST_AGENT_RUNTIME_IMPL.apiKey,
        databaseAgentCache: TEST_AGENT_RUNTIME_IMPL.databaseAgentCache,
        fetchAgentFromDatabase: TEST_AGENT_RUNTIME_IMPL.fetchAgentFromDatabase,
      })

      expect(result).toBeDefined()
      expect(result).not.toContain('You can spawn the following agents:')
    })

    test('does not include spawnable agents for non-instructionsPrompt types', async () => {
      const filePickerTemplate = createMockAgentTemplate({
        id: 'file-picker',
        displayName: 'File Picker',
        spawnerPrompt: 'Spawn to find relevant files in a codebase',
      })

      const mainAgentTemplate = createMockAgentTemplate({
        id: 'main-agent',
        displayName: 'Main Agent',
        spawnableAgents: ['file-picker'],
        systemPrompt: 'System prompt content.',
        stepPrompt: 'Step prompt content.',
      })

      const agentTemplates: Record<string, AgentTemplate> = {
        'main-agent': mainAgentTemplate,
        'file-picker': filePickerTemplate,
      }

      // Test systemPrompt - should not include spawnable agents
      const systemResult = await getAgentPrompt({
        agentTemplate: mainAgentTemplate,
        promptType: { type: 'systemPrompt' },
        fileContext: createMockFileContext(),
        agentState: createMockAgentState('main-agent'),
        agentTemplates,
        additionalToolDefinitions: async () => ({}),
        logger: createMockLogger(),
        apiKey: TEST_AGENT_RUNTIME_IMPL.apiKey,
        databaseAgentCache: TEST_AGENT_RUNTIME_IMPL.databaseAgentCache,
        fetchAgentFromDatabase: TEST_AGENT_RUNTIME_IMPL.fetchAgentFromDatabase,
      })

      expect(systemResult).toBeDefined()
      expect(systemResult).not.toContain('You can spawn the following agents:')

      // Test stepPrompt - should not include spawnable agents
      const stepResult = await getAgentPrompt({
        agentTemplate: mainAgentTemplate,
        promptType: { type: 'stepPrompt' },
        fileContext: createMockFileContext(),
        agentState: createMockAgentState('main-agent'),
        agentTemplates,
        additionalToolDefinitions: async () => ({}),
        logger: createMockLogger(),
        apiKey: TEST_AGENT_RUNTIME_IMPL.apiKey,
        databaseAgentCache: TEST_AGENT_RUNTIME_IMPL.databaseAgentCache,
        fetchAgentFromDatabase: TEST_AGENT_RUNTIME_IMPL.fetchAgentFromDatabase,
      })

      expect(stepResult).toBeDefined()
      expect(stepResult).not.toContain('You can spawn the following agents:')
    })

    test('appends required params from Zod inputSchema.params when spawnerPrompt omits them', async () => {
      const gitCommitterTemplate = createMockAgentTemplate({
        id: 'git-committer',
        displayName: 'Git Committer',
        spawnerPrompt: 'Safely delivers task-owned changes through git',
        inputSchema: {
          params: z.object({
            owned_paths: z.array(z.string()),
          }),
        },
      })

      const mainAgentTemplate = createMockAgentTemplate({
        id: 'main-agent',
        displayName: 'Main Agent',
        spawnableAgents: ['git-committer'],
        instructionsPrompt: 'Main agent instructions.',
      })

      const agentTemplates: Record<string, AgentTemplate> = {
        'main-agent': mainAgentTemplate,
        'git-committer': gitCommitterTemplate,
      }

      const result = await getAgentPrompt({
        agentTemplate: mainAgentTemplate,
        promptType: { type: 'instructionsPrompt' },
        fileContext: createMockFileContext(),
        agentState: createMockAgentState('main-agent'),
        agentTemplates,
        additionalToolDefinitions: async () => ({}),
        logger: createMockLogger(),
        apiKey: TEST_AGENT_RUNTIME_IMPL.apiKey,
        databaseAgentCache: TEST_AGENT_RUNTIME_IMPL.databaseAgentCache,
        fetchAgentFromDatabase: TEST_AGENT_RUNTIME_IMPL.fetchAgentFromDatabase,
      })

      expect(result).toContain(
        '- git-committer: Safely delivers task-owned changes through git Required params: `owned_paths`.',
      )
    })

    test('does not duplicate a required key already named in spawnerPrompt', async () => {
      const securityReviewerTemplate = createMockAgentTemplate({
        id: 'security-reviewer',
        displayName: 'Security Reviewer',
        spawnerPrompt:
          'Required params keys are exactly `changed_files` and `snapshot_fingerprint`; `snapshot_id` is not accepted.',
        inputSchema: {
          params: z.object({
            changed_files: z.array(z.string()),
            snapshot_fingerprint: z.string(),
          }),
        },
      })

      const mainAgentTemplate = createMockAgentTemplate({
        id: 'main-agent',
        displayName: 'Main Agent',
        spawnableAgents: ['security-reviewer'],
        instructionsPrompt: 'Main agent instructions.',
      })

      const agentTemplates: Record<string, AgentTemplate> = {
        'main-agent': mainAgentTemplate,
        'security-reviewer': securityReviewerTemplate,
      }

      const result = await getAgentPrompt({
        agentTemplate: mainAgentTemplate,
        promptType: { type: 'instructionsPrompt' },
        fileContext: createMockFileContext(),
        agentState: createMockAgentState('main-agent'),
        agentTemplates,
        additionalToolDefinitions: async () => ({}),
        logger: createMockLogger(),
        apiKey: TEST_AGENT_RUNTIME_IMPL.apiKey,
        databaseAgentCache: TEST_AGENT_RUNTIME_IMPL.databaseAgentCache,
        fetchAgentFromDatabase: TEST_AGENT_RUNTIME_IMPL.fetchAgentFromDatabase,
      })

      expect(result).toContain(
        '- security-reviewer: Required params keys are exactly `changed_files` and `snapshot_fingerprint`; `snapshot_id` is not accepted.',
      )
      expect(result).not.toContain('Required params: `changed_files`')
    })

    test('repair-editor catalog mentions versioned handoff and findings', async () => {
      const repairEditorTemplate = createMockAgentTemplate({
        id: 'repair-editor',
        displayName: 'Repair Editor',
        spawnerPrompt:
          'Repairs exact validation diagnostics or stable reviewer finding IDs.',
      })

      const mainAgentTemplate = createMockAgentTemplate({
        id: 'main-agent',
        displayName: 'Main Agent',
        spawnableAgents: ['repair-editor'],
        instructionsPrompt: 'Main agent instructions.',
      })

      const agentTemplates: Record<string, AgentTemplate> = {
        'main-agent': mainAgentTemplate,
        'repair-editor': repairEditorTemplate,
      }

      const result = await getAgentPrompt({
        agentTemplate: mainAgentTemplate,
        promptType: { type: 'instructionsPrompt' },
        fileContext: createMockFileContext(),
        agentState: createMockAgentState('main-agent'),
        agentTemplates,
        additionalToolDefinitions: async () => ({}),
        logger: createMockLogger(),
        apiKey: TEST_AGENT_RUNTIME_IMPL.apiKey,
        databaseAgentCache: TEST_AGENT_RUNTIME_IMPL.databaseAgentCache,
        fetchAgentFromDatabase: TEST_AGENT_RUNTIME_IMPL.fetchAgentFromDatabase,
      })

      expect(result).toContain('handoff')
      expect(result).toContain('finding')
      expect(result).toContain('schemaVersion 1')
    })

    test('appends required keys when the prompt only uses them as loose English', async () => {
      const dependencyManagerTemplate = createMockAgentTemplate({
        id: 'dependency-manager',
        displayName: 'Dependency Manager',
        spawnerPrompt: 'Select the manager from repository manifests',
        inputSchema: {
          params: z.object({
            manager: z.string(),
            operation: z.string(),
          }),
        },
      })

      const mainAgentTemplate = createMockAgentTemplate({
        id: 'main-agent',
        displayName: 'Main Agent',
        spawnableAgents: ['dependency-manager'],
        instructionsPrompt: 'Main agent instructions.',
      })

      const agentTemplates: Record<string, AgentTemplate> = {
        'main-agent': mainAgentTemplate,
        'dependency-manager': dependencyManagerTemplate,
      }

      const result = await getAgentPrompt({
        agentTemplate: mainAgentTemplate,
        promptType: { type: 'instructionsPrompt' },
        fileContext: createMockFileContext(),
        agentState: createMockAgentState('main-agent'),
        agentTemplates,
        additionalToolDefinitions: async () => ({}),
        logger: createMockLogger(),
        apiKey: TEST_AGENT_RUNTIME_IMPL.apiKey,
        databaseAgentCache: TEST_AGENT_RUNTIME_IMPL.databaseAgentCache,
        fetchAgentFromDatabase: TEST_AGENT_RUNTIME_IMPL.fetchAgentFromDatabase,
      })

      expect(result).toContain(
        '- dependency-manager: Select the manager from repository manifests Required params: `manager`, `operation`.',
      )
    })

    test('does not duplicate a required key already named as an object key', async () => {
      const basherTemplate = createMockAgentTemplate({
        id: 'basher',
        displayName: 'Basher',
        spawnerPrompt: 'params: { command: "<shell>" }',
        inputSchema: {
          params: z.object({
            command: z.string(),
          }),
        },
      })

      const mainAgentTemplate = createMockAgentTemplate({
        id: 'main-agent',
        displayName: 'Main Agent',
        spawnableAgents: ['basher'],
        instructionsPrompt: 'Main agent instructions.',
      })

      const agentTemplates: Record<string, AgentTemplate> = {
        'main-agent': mainAgentTemplate,
        basher: basherTemplate,
      }

      const result = await getAgentPrompt({
        agentTemplate: mainAgentTemplate,
        promptType: { type: 'instructionsPrompt' },
        fileContext: createMockFileContext(),
        agentState: createMockAgentState('main-agent'),
        agentTemplates,
        additionalToolDefinitions: async () => ({}),
        logger: createMockLogger(),
        apiKey: TEST_AGENT_RUNTIME_IMPL.apiKey,
        databaseAgentCache: TEST_AGENT_RUNTIME_IMPL.databaseAgentCache,
        fetchAgentFromDatabase: TEST_AGENT_RUNTIME_IMPL.fetchAgentFromDatabase,
      })

      expect(result).toContain('- basher: params: { command: "<shell>" }')
      expect(result).not.toContain('Required params: `command`')
    })

    test('compact catalog names required params for live roster agents', () => {
      const roster = [
        gitCommitter,
        librarian,
        dependencyManager,
        securityReviewer,
        codeSearcher,
        globMatcher,
        directoryLister,
        basher,
        repairEditor,
        compatibilityReviewer,
      ] as const

      for (const definition of roster) {
        const line = formatCompactAgentCatalogLine(
          definition.id,
          createMockAgentTemplate({
            id: definition.id,
            displayName: definition.displayName,
            spawnerPrompt: definition.spawnerPrompt,
            inputSchema: definition.inputSchema as AgentTemplate['inputSchema'],
          }),
        )
        const required = getRequiredAgentParamKeys(
          definition.inputSchema?.params,
        )
        for (const key of required) {
          expect(line).toContain(key)
        }
        if (definition.id === 'repair-editor') {
          expect(line).toContain('handoff')
        }
      }
    })
  })

  test('uses harvested-text addendum when set_output is programmatic-only', async () => {
    const agentTemplate = createMockAgentTemplate({
      id: 'structured-programmatic-output',
      outputMode: 'structured_output',
      outputSchema: z.object({
        message: z.string(),
      }),
      programmaticToolNames: ['set_output'],
      toolNames: ['read_files'],
      instructionsPrompt: 'Structured output instructions.',
    })
    const agentTemplates: Record<string, AgentTemplate> = {
      'structured-programmatic-output': agentTemplate,
    }

    const result = await getAgentPrompt({
      agentTemplate,
      promptType: { type: 'instructionsPrompt' },
      fileContext: createMockFileContext(),
      agentState: createMockAgentState('structured-programmatic-output'),
      agentTemplates,
      additionalToolDefinitions: async () => ({}),
      logger: createMockLogger(),
      apiKey: TEST_AGENT_RUNTIME_IMPL.apiKey,
      databaseAgentCache: TEST_AGENT_RUNTIME_IMPL.databaseAgentCache,
      fetchAgentFromDatabase: TEST_AGENT_RUNTIME_IMPL.fetchAgentFromDatabase,
    })

    expect(result).toBeDefined()
    expect(result).toContain('Do not call set_output just to publish')
    expect(result).not.toContain('When using the set_output tool')
  })
})

describe('ON_DEMAND_GUIDE_FALLBACK placeholders (T1.4d)', () => {
  // packages/agent-runtime/src/templates/__tests__ -> repo root.
  const REPO_ROOT = path.join(__dirname, '..', '..', '..', '..', '..')

  /** Shared prefix of every per-guide recovery placeholder. */
  const FALLBACK_PLACEHOLDER_PREFIX = '{CODEBUFF_ON_DEMAND_GUIDE_FALLBACK'

  async function resolveBase2SystemPrompt(
    projectRoot: string,
    options?: Parameters<typeof createBase2>[1],
    ledger?: ContextBudgetLedger,
  ): Promise<string> {
    const base2 = createBase2('default', options)
    const agentTemplate = createMockAgentTemplate({
      id: 'base2',
      displayName: base2.displayName,
      systemPrompt: (base2.systemPrompt as string | undefined) ?? '',
    })
    const resolved = await getAgentPrompt({
      agentTemplate,
      promptType: { type: 'systemPrompt' },
      fileContext: createMockFileContext({ projectRoot }),
      agentState: createMockAgentState('base2'),
      agentTemplates: { base2: agentTemplate },
      additionalToolDefinitions: async () => ({}),
      logger: createMockLogger(),
      ledger,
      apiKey: TEST_AGENT_RUNTIME_IMPL.apiKey,
      databaseAgentCache: TEST_AGENT_RUNTIME_IMPL.databaseAgentCache,
      fetchAgentFromDatabase: TEST_AGENT_RUNTIME_IMPL.fetchAgentFromDatabase,
    })
    expect(
      typeof resolved === 'string'
        ? 'resolved'
        : 'base2 system prompt did not resolve',
    ).toBe('resolved')
    return resolved ?? ''
  }

  function makeGuidelessRoot(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'guide-fallback-'))
  }

  test('re-inlines every relocated body when the workspace has no agents/guides/', async () => {
    // Falsifying test for the background defect: without the placeholders the
    // embedder's resolved prompt carries only pointers to files it does not
    // have, so all six relocated sections are lost.
    expect(GUIDE_POINTERS.length).toBeGreaterThan(0)
    const tmpDir = makeGuidelessRoot()
    try {
      const resolved = await resolveBase2SystemPrompt(tmpDir)
      for (const { guide, sectionName, section } of GUIDE_POINTERS) {
        expect(
          resolved.includes(section)
            ? 'recovered'
            : `${sectionName} (${guide}) body was not recovered for a guide-less workspace`,
        ).toBe('recovered')
      }
      expect(resolved).not.toContain(FALLBACK_PLACEHOLDER_PREFIX)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  test('collapses to nothing in this repo, where every guide exists', async () => {
    expect(GUIDE_POINTERS.length).toBeGreaterThan(0)
    const resolved = await resolveBase2SystemPrompt(REPO_ROOT)
    for (const { guide, sectionName, section } of GUIDE_POINTERS) {
      expect(
        resolved.includes(section)
          ? `${sectionName} (${guide}) body was inlined even though the guide exists`
          : 'collapsed',
      ).toBe('collapsed')
    }
    expect(resolved).not.toContain(FALLBACK_PLACEHOLDER_PREFIX)
  })

  test('guide-less plan mode recovers neither the git-discipline body nor the implementation broad-audit body', async () => {
    // RF-1/RF-2/RF-7: plan mode is read-only, so base2 emits neither the
    // git-discipline pointer nor its section, and its broad-audit pointer tail
    // says "do not implement". Recovery must mirror both exclusions: a single
    // all-six placeholder handed a guide-less plan-mode prompt commit/push
    // guidance back plus the contradictory implementation finalize clause.
    const implBroadAudit =
      BROAD_AUDIT_FALLBACK_SECTIONS['proceed to implementation or the answer']
    const planBroadAudit =
      BROAD_AUDIT_FALLBACK_SECTIONS[
        'translate the findings into the durable plan packet below'
      ]
    // Vacuity guard: the two clause bodies must differ, or the assertions below
    // could not distinguish them.
    expect(implBroadAudit).not.toBe(planBroadAudit)

    const tmpDir = makeGuidelessRoot()
    try {
      const resolved = await resolveBase2SystemPrompt(tmpDir, {
        planOnly: true,
      })
      expect(resolved).not.toContain(gitDisciplineSection)
      expect(resolved).not.toContain(FALLBACK_GUIDES.gitDiscipline)
      expect(resolved).not.toContain(implBroadAudit)
      // ...and the plan-clause body IS recovered, so the exclusions above are
      // not passing merely because recovery stopped working in plan mode.
      expect(resolved).toContain(planBroadAudit)
      for (const { guide, sectionName, section } of GUIDE_POINTERS) {
        if (
          guide === FALLBACK_GUIDES.gitDiscipline ||
          guide === FALLBACK_GUIDES.broadAudit
        ) {
          continue
        }
        expect(
          resolved.includes(section)
            ? 'recovered'
            : `${sectionName} (${guide}) body was not recovered for a guide-less plan-mode workspace`,
        ).toBe('recovered')
      }
      expect(resolved).not.toContain(FALLBACK_PLACEHOLDER_PREFIX)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  test('guide-less execute-plan mode recovers every body including git-discipline and the implementation broad-audit body', async () => {
    // Counterpart to the plan-mode case: EXECUTE_PLAN does edit source, so it
    // keeps the git-discipline pointer and the implementation finalize clause.
    // Without this, dropping those recoveries everywhere would still pass the
    // plan-mode exclusions above.
    const tmpDir = makeGuidelessRoot()
    try {
      const resolved = await resolveBase2SystemPrompt(tmpDir, {
        executePlan: true,
      })
      expect(resolved).toContain(gitDisciplineSection)
      expect(resolved).toContain(
        BROAD_AUDIT_FALLBACK_SECTIONS[
          'proceed to implementation or the answer'
        ],
      )
      expect(resolved).not.toContain(
        BROAD_AUDIT_FALLBACK_SECTIONS[
          'translate the findings into the durable plan packet below'
        ],
      )
      expect(resolved).not.toContain(FALLBACK_PLACEHOLDER_PREFIX)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  test('records every recovered body in the shared context-budget ledger', async () => {
    // RF-5: the recovered bodies are the largest block this path adds, so an
    // embedder's context accounting must see them the way it sees the file tree
    // and git-changes blocks.
    const tmpDir = makeGuidelessRoot()
    try {
      const ledger = createBudgetLedger({ windowTokens: 200_000 })
      const resolved = await resolveBase2SystemPrompt(tmpDir, undefined, ledger)
      const guideLines = ledger.lines.filter(({ label }) =>
        label.startsWith('guide-fallback:'),
      )
      expect(guideLines.length).toBe(GUIDE_POINTERS.length)
      for (const { guide } of GUIDE_POINTERS) {
        const line = guideLines.find(
          ({ label }) => label === `guide-fallback:${guide}`,
        )
        expect(
          line
            ? 'recorded'
            : `${guide} recovery was not recorded in the ledger`,
        ).toBe('recorded')
        expect(line ? line.tokens > 0 : false).toBe(true)
      }
      expect(ledger.totalTokens).toBeGreaterThan(0)
      // Sanity: the recorded lines describe text that really is in the prompt.
      expect(resolved).toContain(
        GUIDE_FALLBACK_SECTIONS[FALLBACK_GUIDES.gitDiscipline],
      )
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  test('records nothing in the ledger when every guide exists', async () => {
    const ledger = createBudgetLedger({ windowTokens: 200_000 })
    await resolveBase2SystemPrompt(REPO_ROOT, undefined, ledger)
    expect(
      ledger.lines.filter(({ label }) => label.startsWith('guide-fallback:'))
        .length,
    ).toBe(0)
  })

  test('recovered guide-less surface regrows by at most the pointer/instructions overhead', async () => {
    // The >=25% authored-reduction metric in
    // agents/__tests__/base2-progressive-disclosure.test.ts measures the
    // PRE-injection surface, so it is structurally blind to resolved-surface
    // regrowth in an embedder workspace. This is the added guard for that, not
    // a replacement.
    //
    // DEVIATION from a plain "no longer than explicit-off" bound: the fallback
    // is ADDITIVE (it follows the pointers rather than replacing them) and
    // broad-audit's explicit-off body lives in the INSTRUCTIONS prompt while its
    // recovered body arrives in the system prompt. So the guide-less system
    // prompt is necessarily longer than the explicit-off system prompt by
    // exactly that overhead. The bound below is derived from GUIDE_POINTERS
    // instead of a magic number, so the assertion still fails the moment a body
    // is recovered twice or the blocks regrow beyond the pointers they follow.
    const tmpDir = makeGuidelessRoot()
    try {
      const disclosed = await resolveBase2SystemPrompt(tmpDir)
      const explicitOff = await resolveBase2SystemPrompt(tmpDir, {
        progressivePromptDisclosure: false,
      })
      const pointerOverhead = GUIDE_POINTERS.reduce(
        (total, { pointer }) => total + pointer.length,
        0,
      )
      // Bodies whose explicit-off home is the instructions prompt, so the
      // system-prompt comparison has to allow for them.
      const instructionsBodyOverhead = GUIDE_POINTERS.filter(
        ({ surface }) => surface === 'instructions',
      ).reduce((total, { section }) => total + section.length, 0)
      // Per-block heading + intro sentence + blank-line seams, once per
      // recovered guide now that recovery is per pointer.
      const BLOCK_CHROME_BUDGET = 400 * GUIDE_POINTERS.length
      expect(disclosed.length).toBeLessThanOrEqual(
        explicitOff.length +
          pointerOverhead +
          instructionsBodyOverhead +
          BLOCK_CHROME_BUDGET,
      )
      // No body may be recovered twice: a duplicated section is the regrowth
      // failure mode the bound above is guarding against.
      for (const { guide, sectionName, section } of GUIDE_POINTERS) {
        const occurrences = disclosed.split(section).length - 1
        expect(
          occurrences === 1
            ? 'once'
            : `${sectionName} (${guide}) body appears ${occurrences} times in the recovered surface`,
        ).toBe('once')
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  test('in this repo the disclosed resolved surface stays smaller than explicit-off', async () => {
    // Every provider collapses to '' here, so the disclosure saving must survive
    // injection rather than being cancelled out by an eagerly-run fallback.
    const disclosed = await resolveBase2SystemPrompt(REPO_ROOT)
    const explicitOff = await resolveBase2SystemPrompt(REPO_ROOT, {
      progressivePromptDisclosure: false,
    })
    expect(disclosed.length).toBeLessThan(explicitOff.length)
  })

  test('the fallback table covers exactly the relocated guides', () => {
    expect(GUIDE_POINTERS.length).toBeGreaterThan(0)
    // Widened to string[]: GUIDE_FALLBACK_SECTIONS is keyed by plain string
    // (common/ cannot import base2's GuidePath union), so comparing the
    // narrower pointer paths directly has no matching toEqual overload.
    expect(GUIDE_POINTERS.map(({ guide }) => String(guide)).sort()).toEqual(
      Object.keys(GUIDE_FALLBACK_SECTIONS).sort(),
    )
  })

  test('every relocated guide has its own recovery placeholder', () => {
    // The per-pointer contract: two pointers sharing one placeholder would make
    // a mode-specific exclusion impossible to express again.
    const placeholders = GUIDE_POINTERS.map(
      ({ fallbackPlaceholder }) => fallbackPlaceholder,
    )
    expect(new Set(placeholders).size).toBe(GUIDE_POINTERS.length)
    for (const placeholder of placeholders) {
      expect(placeholder.startsWith(FALLBACK_PLACEHOLDER_PREFIX)).toBe(true)
    }
    // The plan-clause broad-audit placeholder is additional: it recovers the
    // same guide with the plan finalize clause.
    expect(placeholders).not.toContain(
      PLACEHOLDER.ON_DEMAND_GUIDE_FALLBACK_BROAD_AUDIT_PLAN,
    )
  })
})

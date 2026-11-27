import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { OpenbuffClient } from '../client'
import { ProjectIdSchema } from '@codebuff/common/types/memory-v2'
import { commitTaskMemory } from '@codebuff/agent-runtime/util/task-memory'
import { BunSQLiteMemoryRepository } from '../../../cli/src/services/memory-v2/bun-sqlite-memory-repository'
import { startFakeLlmServer, silentLogger } from './fixtures/fake-llm-server'
import type { FakeLlmServer } from './fixtures/fake-llm-server'
import type {
  MemoryRepositoryV2,
  MemoryV2ClientConfig,
} from '../services/memory-v2/types'
import type { AgentDefinition } from '@codebuff/common/templates/initial-agents-dir/types/agent-definition'

let root: string,
  config: string,
  repository: BunSQLiteMemoryRepository,
  server: FakeLlmServer
const projectId = ProjectIdSchema.parse('project:b12-authority')
const sentinel = 'V1_SHADOW_AUTHORITY_CANARY'
const seed: AgentDefinition = {
  id: 'authority-seed',
  displayName: 'Authority seed',
  toolNames: [],
  handleSteps: function* () {
    yield { type: 'STEP_TEXT', text: 'Seed state.' }
  },
}
const reader: AgentDefinition = {
  id: 'authority-reader',
  displayName: 'Authority reader',
  toolNames: [],
  systemPrompt: 'Answer the current task from available context.',
}
beforeEach(async () => {
  root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'b12-authority-')),
  )
  server = startFakeLlmServer()
  config = path.join(root, 'config.json')
  fs.writeFileSync(
    config,
    JSON.stringify({
      defaultModel: 'fixture/model',
      indexing: { enabled: false },
      providers: {
        fixture: {
          type: 'openai-compatible',
          baseURL: `${server.baseURL}/v1`,
          models: ['model'],
        },
      },
    }),
  )
  const opened = await BunSQLiteMemoryRepository.open({ repositoryRoot: root })
  if (opened.status === 'error') throw new Error(opened.error.message)
  repository = opened.repository
})
afterEach(async () => {
  await repository.close()
  server.stop()
  fs.rmSync(root, { recursive: true, force: true })
})
function client(memoryV2?: MemoryV2ClientConfig) {
  return new OpenbuffClient({
    cwd: root,
    projectFiles: {},
    knowledgeFiles: {},
    userKnowledgeFiles: {},
    agentDefinitions: [seed, reader],
    repositoryIntelligence: false,
    harnessStateDir: path.join(root, 'harness'),
    runTimeoutMs: 10_000,
    logger: silentLogger,
    handleEvent() {},
    memoryV2,
    hostConfiguration: {
      environment: {
        PATH: '/usr/bin:/bin',
        OPENBUFF_PROCESS_SUPERVISION: '0',
        OPENBUFF_TELEMETRY: '0',
      },
      platform: process.platform,
      invocationCwd: root,
      projectRoot: root,
      home: { kind: 'none' },
      globals: { kind: 'disabled' },
      selection: { kind: 'explicit', path: config, required: true },
      trust: { ancestorConfig: false, projectReadableRoots: false },
    },
  })
}
function port(query: MemoryRepositoryV2['query']): MemoryRepositoryV2 {
  return {
    append: (request) => repository.append(request),
    query,
    export: (request) => repository.export(request),
    health: (request) => repository.health(request),
    verify: (request) => repository.verify(request),
    rebuild: (request) => repository.rebuild(request),
    getClaimDedup: (request) => repository.getClaimDedup(request),
    getObservationStatus: (request) => repository.getObservationStatus(request),
  }
}

describe('B12 actual provider memory source and authority matrix', () => {
  for (const mode of [
    'v2-unavailable',
    'v2-throws',
    'v2-invalid',
    'v2-empty',
    'v1-present',
    'v1-empty',
  ] as const)
    test(`${mode} metadata agrees with the actual first model messages`, async () => {
      const previousRun = await client().run({
        agent: seed.id,
        prompt: 'Prepare state.',
      })
      if (mode !== 'v2-empty' && mode !== 'v1-empty')
        previousRun.sessionState!.mainAgentState.taskMemory = commitTaskMemory({
          draft: {
            schemaVersion: 1,
            goal: 'Prepare the current task context.',
            requirements: [],
            decisions: [sentinel],
            filesInspected: [],
            editsMade: [],
            validationResults: [],
            reviewReceipts: [],
            blockers: [],
            nextActions: [],
            historicalSummary: '',
            evidence: [],
          },
          expectedRevision: -1,
        })
      const selected =
        mode === 'v2-unavailable'
          ? undefined
          : mode === 'v2-throws'
            ? port(async () => {
                throw new Error('Owned unavailable repository')
              })
            : mode === 'v2-invalid'
              ? port(async () => ({ malformed: true }) as never)
              : repository
      const v2 = mode.startsWith('v2')
      const result = await client({
        repository: selected,
        projectId,
        authority: v2 ? 'sqlite-v2-opt-in' : 'json-v1',
        capture: 'safe',
      }).run({
        agent: reader.id,
        prompt: 'A new unrelated task.',
        previousRun,
      })
      expect(
        result.runOutcome?.termination,
        JSON.stringify(result.output),
      ).toBe('completed')
      expect(server.requests).toHaveLength(1)
      const text = JSON.stringify(server.requests[0].body.messages)
      const authority = result.sessionState!.mainAgentState.memoryAuthority!
      expect(authority.requested).toBe(v2 ? 'sqlite-v2-opt-in' : 'json-v1')
      expect(authority.active).toBe(v2 ? 'sqlite-v2-opt-in' : 'json-v1')
      expect(authority.fallbackOccurred).toBe(false)
      if (v2) {
        expect(text).not.toContain('TASK_MEMORY_CONTEXT')
        expect(text).not.toContain(sentinel)
        if (mode === 'v2-empty') {
          expect(text).toContain('Memory V2 retrieval context')
          expect(
            result.sessionState!.mainAgentState.memoryV2Context!.result
              .verifiedKnowledge,
          ).toEqual([])
          expect(
            result.sessionState!.mainAgentState.memoryV2Context!.result
              .reusableDiscovery,
          ).toEqual([])
        } else {
          expect(text).not.toContain('Memory V2 retrieval context')
          expect(authority.reason).toBe(
            mode === 'v2-unavailable'
              ? 'backend-unavailable'
              : mode === 'v2-throws'
                ? 'query-threw'
                : 'query-invalid-result',
          )
        }
      } else {
        expect(text).not.toContain('Memory V2 retrieval context')
        expect(text.includes(sentinel)).toBe(mode === 'v1-present')
      }
    }, 20_000)
})

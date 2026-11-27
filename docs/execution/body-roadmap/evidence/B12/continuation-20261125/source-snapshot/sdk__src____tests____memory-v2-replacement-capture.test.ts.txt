import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { getInitialAgentState } from '@codebuff/common/types/session-state'
import {
  ProjectIdSchema,
  MemoryRetrievalRequestSchema,
  type MemoryObservation,
} from '@codebuff/common/types/memory-v2'
import { MemoryV2Coordinator } from '../services/memory-v2/coordinator'
import type { MemoryRepositoryV2 } from '../services/memory-v2/types'
import { BunSQLiteMemoryRepository } from '../../../cli/src/services/memory-v2/bun-sqlite-memory-repository'

let root: string, repository: BunSQLiteMemoryRepository
const projectId = ProjectIdSchema.parse('project:b12-replacement')
beforeEach(async () => {
  root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'b12-replacement-')),
  )
  const opened = await BunSQLiteMemoryRepository.open({ repositoryRoot: root })
  if (opened.status === 'error') throw new Error(opened.error.message)
  repository = opened.repository
})
afterEach(async () => {
  await repository.close()
  fs.rmSync(root, { recursive: true, force: true })
})
const existing =
  'Preserve the audit log because recovery needs its complete event history.'
const replacement =
  'Replace audit log strategy because the new implementation changes recovery requirements.'

for (const failure of ['precommit', 'lost-ack'] as const)
  test(`${failure} replacement observation does not retract a prior claim without confirmation`, async () => {
    let failReplacement = false
    const original = repository.append.bind(repository)
    const port: MemoryRepositoryV2 = {
      append: async (request) => {
        if (
          failReplacement &&
          request.events.some(
            (event) =>
              event.eventType === 'observation.recorded' &&
              JSON.stringify(event.payload).includes(replacement),
          )
        ) {
          if (failure === 'lost-ack') await original(request)
          return {
            outcome: 'failed',
            error: {
              code: 'unavailable',
              message: 'Owned replacement append failure',
              retryable: true,
            },
          }
        }
        return original(request)
      },
      query: (request) => repository.query(request),
      verify: (request) => repository.verify(request),
      health: (request) => repository.health(request),
      export: (request) => repository.export(request),
      rebuild: (request) => repository.rebuild(request),
      getClaimDedup: (request) => repository.getClaimDedup(request),
      getObservationStatus: (request) =>
        repository.getObservationStatus(request),
    }
    const coordinator = new MemoryV2Coordinator({
      repository: port,
      projectId,
      authority: 'sqlite-v2-opt-in',
      capture: 'safe',
    })
    const state = getInitialAgentState()
    await coordinator.prepareTurn({
      agentState: state,
      trustedUserInputId: 'input:replace',
      query: 'audit recovery',
    })
    const capture = (text: string, id: string, supersedes?: string[]) =>
      coordinator.recordToolObservation({
        toolName: 'record_decision',
        callId: id,
        userInputId: 'input:replace',
        input: {
          text,
          kind: 'decision',
          evidenceSelectors: ['src/ledger.ts'],
          supersedes,
        },
        output: [
          {
            type: 'json',
            value: {
              text,
              kind: 'decision',
              evidenceSelectors: ['src/ledger.ts'],
              ...(supersedes ? { supersedes } : {}),
            },
          },
        ],
        native: true,
        completed: true,
      })
    await capture(existing, 'original')
    const first = await repository.listEvents({ limit: 1000 })
    if (first.status === 'error') throw new Error(first.error.message)
    const old = first.events
      .filter((event) => event.eventType === 'observation.recorded')
      .map(
        (event) =>
          (event.payload as { observation: MemoryObservation }).observation,
      )
      .find((item) => item.summary === existing)!
    expect(old).toBeDefined()
    failReplacement = true
    await capture(replacement, 'replacement', [old.observationId])
    const after = await repository.listEvents({ limit: 1000 })
    if (after.status === 'error') throw new Error(after.error.message)
    expect(
      after.events.filter((event) => event.eventType === 'claim.superseded'),
    ).toEqual([])
    expect(
      after.events.filter((event) => event.eventType === 'observation.reused'),
    ).toEqual([])
    const query = await repository.query(
      MemoryRetrievalRequestSchema.parse({
        schemaVersion: 2,
        queryId: 'query:after-failure',
        projectId,
        sessionId: state.memoryV2!.sessionId,
        query: 'audit recovery',
        selectors: [],
        artifactKinds: [],
        includeHistorical: false,
        maxResultsPerCategory: 20,
      }),
    )
    expect(query.outcome).toBe('result')
    if (query.outcome !== 'result') throw new Error('Query failed')
    expect(
      query.result.reusableDiscovery.some(
        (item) => item.observation.observationId === old.observationId,
      ),
    ).toBe(true)
  })

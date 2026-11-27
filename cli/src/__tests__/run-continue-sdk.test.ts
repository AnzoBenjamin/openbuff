import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createRunJournal } from '@codebuff/agent-runtime/util/run-journal'
import { OpenbuffClient as SourceClient } from '../../../sdk/src/client'
import { runHeadlessCommand } from '../commands/run-command'
import type { AgentDefinition } from '@codebuff/common/templates/initial-agents-dir/types/agent-definition'
import type { OpenbuffClient } from '@openbuff/sdk'

// A real SDK loop, no provider/model calls and no repeated fake copy of its
// journal-resume logic. New conversational turns must not consult an old
// interrupted effect prefix, even when the client has a default reader.
test('persisted headless conversation starts a new SDK turn without old journal replay admission', async () => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'headless-sdk-continuation-')),
  )
  const config = path.join(root, 'config.json')
  fs.writeFileSync(
    config,
    JSON.stringify({ defaultModel: 'fixture/model', providers: {} }),
  )
  const actual = createRunJournal({ path: ':memory:' })
  let oldRunId: string | undefined,
    oldReads = 0
  const journal = {
    ...actual,
    lastEvent(runId: string) {
      if (runId === oldRunId) oldReads++
      return actual.lastEvent(runId)
    },
    events(runId: string) {
      if (runId === oldRunId) oldReads++
      return actual.events(runId)
    },
  }
  const agent: AgentDefinition = {
    id: 'continuation-program',
    displayName: 'Continuation program',
    toolNames: [],
    handleSteps: function* () {
      yield { type: 'STEP_TEXT', text: 'A fresh conversational turn.' }
    },
  }
  const client = new SourceClient({
    cwd: root,
    projectFiles: {},
    knowledgeFiles: {},
    userKnowledgeFiles: {},
    agentDefinitions: [agent],
    repositoryIntelligence: false,
    harnessStateDir: path.join(root, 'harness'),
    runTimeoutMs: 5_000,
    handleEvent() {},
    journalWriter: journal,
    journalReader: journal,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    hostConfiguration: {
      environment: {
        PATH: '/usr/bin:/bin',
        OPENBUFF_PROCESS_SUPERVISION: '0',
        OPENBUFF_TELEMETRY: '0',
        DO_NOT_TRACK: '1',
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
  try {
    const previous = await client.run({
      agent: agent.id,
      prompt: 'Retain the original constraint.',
      journalReader: undefined,
    })
    expect(previous.runOutcome?.termination).toBe('completed')
    oldRunId = previous.sessionState?.mainAgentState.runId
    expect(oldRunId).toBeDefined()
    const original = actual.events(oldRunId!)
    // Simulate retained interrupted work. Its recovery belongs to B15, not
    // to a new user prompt passed through --continue.
    const restored = structuredClone(previous)
    restored.sessionState!.mainAgentState.backgroundAgentJobs = [
      {
        jobId: 'retained-interrupted-job',
        agentType: agent.id,
        status: 'running',
        startedAt: 1,
      },
    ]
    const stdout: string[] = [],
      stderr: string[] = []
    let saved = false
    expect(
      await runHeadlessCommand(
        { prompt: 'Do a new task.', json: true, continue: true },
        {
          projectRoot: root,
          getClient: async () => client as unknown as OpenbuffClient,
          getProviderReadiness: () => ({ ok: true }),
          openRunJournal: () => journal,
          writeStdout: (chunk) => stdout.push(chunk),
          writeStderr: (line) => stderr.push(line),
          sessionStore: {
            directory: root,
            async acquire() {
              return {
                sessionId: 'prior-session',
                agentId: agent.id,
                previousRun: restored,
                async save(result) {
                  saved = true
                  expect(result.sessionState?.mainAgentState.runId).not.toBe(
                    oldRunId,
                  )
                  expect(
                    JSON.stringify(
                      result.sessionState?.mainAgentState.messageHistory,
                    ),
                  ).toContain('Retain the original constraint.')
                  expect(actual.events(oldRunId!)).toEqual(original)
                },
                async close() {},
              }
            },
          },
        },
      ),
      stderr.join('\n'),
    ).toBe(0)
    expect(saved).toBe(true)
    expect(oldReads).toBe(0)
    expect(stdout.join('')).not.toContain('retained-interrupted-job')
  } finally {
    await actual.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
}, 15_000)

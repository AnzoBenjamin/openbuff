import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, test } from 'bun:test'
import {
  artifactId,
  createArtifactSink,
  createRunArtifactSink,
} from '../evaluation-artifacts'
import { runTask, summarizeAgentRuns } from '../run-buffbench'
import type { OpenbuffClient } from '@openbuff/sdk'
import { recordEvaluatorModelAttempts } from '../evaluation-model-attempts'

describe('isolated evaluator sinks (pre-suite sentinel gate)', () => {
  test.each([
    ['undefined', undefined],
    ['null', null],
    ['false', false],
    ['zero', 0],
    ['empty string', ''],
  ])('retains a thrown %s cause in settled evidence', async (_, thrown) => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'buffbench-falsy-cause-'),
    )
    try {
      const recorder = recordEvaluatorModelAttempts(
        {
          run: async () => {
            throw thrown
          },
        } as unknown as OpenbuffClient,
        createArtifactSink(root),
        [],
      )
      let rejected = false
      try {
        await recorder.client.run({ agent: 'fixture', prompt: 'fixture' })
      } catch (observed) {
        rejected = true
        expect(observed).toBe(thrown)
      }
      expect(rejected).toBe(true)
      const attempt = recorder.attempts[0]!
      expect(attempt.error).toBe(String(thrown))
      expect(attempt.phase).toBe('settled')
      const started = JSON.parse(
        fs.readFileSync(
          path.join(root, `${attempt.attemptId}-started.json`),
          'utf8',
        ),
      )
      const settled = JSON.parse(
        fs.readFileSync(
          path.join(root, `${attempt.attemptId}-settled.json`),
          'utf8',
        ),
      )
      expect(settled.error).toBe(String(thrown))
      expect(settled.attemptId).toBe(started.attemptId)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
  test('keeps paid evidence visible while cancellation is still settling', async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'buffbench-pending-paid-'),
    )
    try {
      const controller = new AbortController()
      const recorder = recordEvaluatorModelAttempts(
        {
          run: async (input: any) => {
            input.handleEvent({ type: 'finish', totalCost: 75 })
            return new Promise((_, reject) =>
              input.signal.addEventListener(
                'abort',
                () => reject(new Error('cancelled fixture')),
                { once: true },
              ),
            )
          },
        } as any,
        createArtifactSink(root),
        ['fixture'],
      )
      const pending = recorder.client.run({
        agent: 'fixture',
        prompt: 'fixture',
        signal: controller.signal,
      } as any)
      expect(recorder.attempts[0]?.phase).toBe('running')
      expect(recorder.attempts[0]?.costUsd).toBe(0.75)
      expect(recorder.attempts[0]?.costComplete).toBe(false)
      expect(fs.readdirSync(root)).toHaveLength(2)
      controller.abort()
      await expect(pending).rejects.toThrow('cancelled fixture')
      expect(recorder.attempts[0]?.phase).toBe('settled')
      expect(recorder.attempts[0]?.costUsd).toBe(0.75)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
  test('retains paid auxiliary SDK throws as raw attempt evidence', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'buffbench-auxiliary-'))
    try {
      const recorder = recordEvaluatorModelAttempts(
        {
          run: async (input: any) => {
            input.handleEvent({ type: 'finish', totalCost: 75 })
            throw new Error('paid auxiliary failure')
          },
        } as any,
        createArtifactSink(root),
        [],
      )
      await expect(
        recorder.client.run({ agent: 'fixture', prompt: 'fixture' } as any),
      ).rejects.toThrow('paid auxiliary failure')
      expect(recorder.attempts).toHaveLength(1)
      expect(recorder.attempts[0]?.costUsd).toBe(0.75)
      expect(recorder.attempts[0]?.error).toBe('paid auxiliary failure')
      expect(recorder.attempts[0]?.role).toBe('auxiliary')
      expect(recorder.attempts[0]?.costComplete).toBe(false)
      expect(fs.readdirSync(root)).toHaveLength(3)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
  test('lesson extraction only touches the injected sink, including concurrent attempts', async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'buffbench-lesson-sentinel-'),
    )
    try {
      const sentinel = path.join(root, 'unrelated.md')
      fs.writeFileSync(sentinel, 'unrelated lesson')
      const sink = createArtifactSink(path.join(root, 'owned'))
      const client = {
        run: async (input: { agent: string }) => ({
          output: {
            type: 'structuredOutput',
            value:
              input.agent === 'buffbench-lessons-extractor'
                ? {
                    lessons: [
                      {
                        whatWentWrong: 'fixture',
                        whatShouldHaveBeenDone: 'preserve state',
                      },
                    ],
                    proposals: [],
                  }
                : {
                    analysis: 'fixture',
                    strengths: [],
                    weaknesses: [],
                    completionScore: 10,
                    codeQualityScore: 10,
                    overallScore: 10,
                  },
          },
        }),
      } as unknown as OpenbuffClient
      const options = {
        client,
        commit: {
          id: '../../fixture',
          sha: '../../sha',
          parentSha: 'parent',
          spec: 'fixture',
          prompt: 'fixture',
          supplementalFiles: [],
          fileDiffs: [],
          languages: ['typescript', 'python'],
        },
        agents: ['agent-a'],
        repoUrl: 'fixture',
        logsDir: sink.root,
        index: 0,
        totalTasks: 1,
        artifactSink: sink,
        lessonsDir: path.join(sink.root, 'lessons'),
        analyzerContext: {
          agentDefinitions: [],
          agentTypeDefinition: '',
          testedAgentIds: [],
        },
        localAgentDefinitions: [],
        extractLessons: true,
        printEvents: false,
        disableAnalysis: true,
        attempt: {
          runId: 'fixture-run',
          experimentId: 'fixture-experiment',
          repeat: 3,
          providerRoute: 'offline-fixture',
        },
        runAgentOnCommitImpl: async () => ({
          diff: '',
          contextFiles: {},
          durationMs: 10,
          cost: 2.5,
          trace: [],
          runOutcome: { termination: 'cancelled' as const },
          costEvidence: { status: 'reported' as const },
          retrievalFlow: {
            queryCallCount: 0,
            queryResultPaths: [],
            successfulReadPaths: [],
            relevantReadPaths: [],
            irrelevantReadPaths: [],
          },
        }),
      }
      const attempts = await Promise.all([runTask(options), runTask(options)])
      const runs = attempts.flatMap((attempt) =>
        attempt.agentResults.map((result) => result.evalRun),
      )
      expect(new Set(runs.map((run) => run.attemptId)).size).toBe(2)
      expect(
        runs.every(
          (run) =>
            run.judging.overallScore === 10 &&
            run.runOutcome?.termination === 'cancelled',
        ),
      ).toBe(true)
      expect(runs[0]?.languages).toEqual(['typescript', 'python'])
      expect(runs[0]?.repeat).toBe(3)
      expect(runs[0]?.providerRoute).toBe('offline-fixture')
      expect(runs.reduce((sum, run) => sum + run.cost, 0)).toBe(5)
      expect(
        summarizeAgentRuns({
          agentId: 'agent-a',
          runs,
          averageScore: 0,
          averageScoreExcludingFailures: 0,
          averageCost: 2.5,
          averageDuration: 10,
        }).measuredRuns,
      ).toHaveLength(0)
      expect(
        fs.readdirSync(sink.root).filter((name) => name.includes('ANALYSIS')),
      ).toHaveLength(2)
      fs.rmSync(sink.root, { recursive: true })
      expect(fs.readFileSync(sentinel, 'utf8')).toBe('unrelated lesson')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
  test('preserves unrelated lessons and simultaneous fixtures with a fixed clock', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'buffbench-sentinel-'))
    try {
      const lessons = path.join(root, 'agent-lessons')
      fs.mkdirSync(lessons)
      const sentinel = path.join(lessons, 'sentinel.md')
      fs.writeFileSync(sentinel, 'unrelated lesson')
      const first = createRunArtifactSink(root, new Date(0))
      const second = createRunArtifactSink(root, new Date(0))
      expect(first.root).not.toBe(second.root)
      first.writeJson('manifest.json', { run: 1 })
      second.writeJson('manifest.json', { run: 2 })
      expect(() => first.writeJson('manifest.json', { run: 3 })).toThrow()
      fs.rmSync(first.root, { recursive: true })
      expect(fs.readFileSync(sentinel, 'utf8')).toBe('unrelated lesson')
      expect(
        JSON.parse(
          fs.readFileSync(path.join(second.root, 'manifest.json'), 'utf8'),
        ).run,
      ).toBe(2)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
  test('rejects traversal and keeps bounded identifiers collision resistant', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'buffbench-paths-'))
    try {
      const sink = createArtifactSink(root)
      for (const name of ['../escape.json', '/tmp/escape.json', '.', '..']) {
        expect(() => sink.writeJson(name, {})).toThrow()
      }
      expect(artifactId('../x')).not.toBe(artifactId('___x'))
      expect(artifactId('x'.repeat(1000)).length).toBeLessThan(120)
      sink.writeJson(`${artifactId('../x')}.json`, {})
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

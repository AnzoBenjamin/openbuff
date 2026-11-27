import { execSync, spawn } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'

import {
  runAgentOnCommit,
  readContextFiles,
  runFinalCheckCommands,
  runWithTimeoutSignal,
} from '../agent-runner'
import { executeInitCommand } from '../setup-test-repo'
import { ClaudeRunner } from '../runners/claude'
import { CodebuffRunner } from '../runners/codebuff'
import { createArtifactSink } from '../evaluation-artifacts'
import { isAbortError } from '../runners/runner'
import { executionFixture } from '../../../common/src/mcp/__tests__/execution-fixture'

import type { OpenbuffClient } from '@openbuff/sdk'

test('context file read propagates resource-only cancellation', async () => {
  const fixture = executionFixture()
  const context = fixture.context()
  try {
    const pending = readContextFiles(
      process.cwd(),
      'HEAD',
      ['any-file'],
      undefined,
      undefined,
      {
        ...context,
        spawn: (_command, _args, options) => {
          const child = spawn(
            process.execPath,
            ['--no-env-file', '-e', 'setTimeout(() => {}, 30000)'],
            options ?? {},
          )
          child.once('spawn', () => fixture.close())
          return child
        },
      },
    )
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  } finally {
    fixture.close()
  }
})

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 2000
  while (!existsSync(path)) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${path}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe('runWithTimeoutSignal', () => {
  test('normalizes synchronous operation failures into promise rejections', async () => {
    await expect(
      runWithTimeoutSignal(
        () => {
          throw new Error('runner setup failed')
        },
        1000,
        'runner timed out',
      ),
    ).rejects.toThrow('runner setup failed')
  })

  test('aborts the signal passed to the runner task on timeout', async () => {
    let observedSignal: AbortSignal | undefined
    let abortReason: unknown

    await expect(
      runWithTimeoutSignal(
        async (signal) => {
          observedSignal = signal
          return new Promise<never>((resolve) => {
            signal.addEventListener(
              'abort',
              () => {
                abortReason = signal.reason
              },
              { once: true },
            )
          })
        },
        1,
        'runner timed out',
      ),
    ).rejects.toThrow('runner timed out')

    expect(observedSignal).toBeDefined()
    expect(observedSignal!.aborted).toBe(true)
    expect(abortReason).toBeInstanceOf(Error)
    expect((abortReason as Error).message).toContain('runner timed out')
  })
})

describe('external runner abort handling', () => {
  test('classifies abort errors without treating startup messages as aborts', () => {
    expect(
      isAbortError(
        Object.assign(new Error('aborted by shell setup'), {
          code: 'ENOENT',
        }),
      ),
    ).toBe(false)
    expect(
      isAbortError(
        Object.assign(new Error('The operation was aborted'), {
          code: 'ABORT_ERR',
        }),
      ),
    ).toBe(true)
    expect(
      isAbortError({
        name: 'AbortError',
        message: 'The operation was aborted',
      }),
    ).toBe(true)
  })

  test('ClaudeRunner reports signal abort distinctly from startup failure', async () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), 'buffbench-claude-abort-'))
    try {
      const binDir = join(tmpRoot, 'bin')
      const markerPath = join(tmpRoot, 'git-cleanup-marker')
      const startedPath = join(tmpRoot, 'claude-started')
      writeFileSync(join(tmpRoot, 'package.json'), '{}\n')
      writeFileSync(join(tmpRoot, 'README.md'), 'test repo\n')
      writeFileSync(markerPath, 'unchanged\n')
      await Bun.$`git init`.cwd(tmpRoot).quiet()
      await Bun.$`git config user.email test@example.com`.cwd(tmpRoot).quiet()
      await Bun.$`git config user.name Test`.cwd(tmpRoot).quiet()
      await Bun.$`git add .`.cwd(tmpRoot).quiet()
      await Bun.$`git commit -m initial`.cwd(tmpRoot).quiet()
      writeFileSync(markerPath, 'dirty after commit\n')

      await Bun.$`mkdir -p ${binDir}`.quiet()
      const fakeClaudePath = join(binDir, 'claude')
      writeFileSync(
        fakeClaudePath,
        `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(startedPath)}, 'started\\n')\nsetInterval(() => {}, 1000)\n`,
      )
      chmodSync(fakeClaudePath, 0o755)

      const controller = new AbortController()
      const runner = new ClaudeRunner(tmpRoot, {
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
      })
      const runPromise = runner.run('abort me', { signal: controller.signal })

      await waitForFile(startedPath)
      controller.abort()

      await expect(runPromise).rejects.toThrow('Claude CLI run aborted')
      await expect(runPromise).rejects.not.toThrow('failed to start')
      const stagedMarker = await Bun.$`git diff --cached --name-only`
        .cwd(tmpRoot)
        .text()
      expect(stagedMarker).not.toContain('git-cleanup-marker')
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true })
    }
  })
})

describe('runAgentOnCommit', () => {
  test.each([
    [
      'thrown empty string',
      async () => {
        throw ''
      },
      'failed',
    ],
    [
      'thrown empty Error',
      async () => {
        throw new Error('')
      },
      'failed',
    ],
    [
      'resolved empty error',
      async () => ({ output: { type: 'error', message: '' } }),
      'failed',
    ],
    ...(['completed', 'cancelled', 'budget_exhausted', 'failed'] as const).map(
      (termination) =>
        [
          `resolved empty error with ${termination}`,
          async () => ({
            output: { type: 'error', message: '' },
            runOutcome: { termination },
          }),
          termination === 'completed' ? 'failed' : termination,
        ] as const,
    ),
  ] as const)(
    'preserves execution failure for %s',
    async (_, run, termination) => {
      const root = mkdtempSync(join(tmpdir(), 'buffbench-empty-error-'))
      try {
        const runner = new CodebuffRunner({
          cwd: root,
          agentId: 'fixture',
          commitId: 'fixture',
          parentSha: 'HEAD',
          localAgentDefinitions: [],
          printEvents: false,
          client: { run } as unknown as OpenbuffClient,
        })
        const result = await runner.run('offline fixture')
        expect(result.error).toBe('')
        expect(result.runOutcome?.termination).toBe(termination)
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    },
  )

  test('retains SDK error, cancelled and incomplete outcomes and their paid evidence', async () => {
    const root = mkdtempSync(join(tmpdir(), 'buffbench-outcomes-'))
    try {
      const artifactSink = createArtifactSink(join(root, 'artifacts'))
      for (const termination of [
        'failed',
        'cancelled',
        'budget_exhausted',
        'step_exhausted',
        'deadline_exhausted',
        'resource_failure',
        'cleanup_failure',
      ]) {
        const runner = new CodebuffRunner({
          cwd: root,
          agentId: '../../agent',
          commitId: '../../task',
          parentSha: 'HEAD',
          localAgentDefinitions: [],
          printEvents: false,
          artifactSink,
          client: {
            run: async () => ({
              output: { type: 'text', value: 'looks successful' },
              runOutcome: { termination },
              sessionState: { mainAgentState: { creditsUsed: 250 } },
            }),
          } as any,
        })
        const result = await runner.run('fixture')
        expect(result.error).toContain(termination)
        expect(result.runOutcome?.termination).toBe(termination as any)
        expect(result.totalCostUsd).toBe(2.5)
        expect(result.costEvidence?.status).toBe('reported')
      }
      const errorRunner = new CodebuffRunner({
        cwd: root,
        agentId: '../../agent',
        commitId: '../../task',
        parentSha: 'HEAD',
        localAgentDefinitions: [],
        printEvents: false,
        artifactSink,
        client: {
          run: async () => ({
            output: { type: 'error', message: 'SDK resolved error' },
            sessionState: { mainAgentState: { creditsUsed: 100 } },
          }),
        } as any,
      })
      const resolvedError = await errorRunner.run('fixture')
      expect(resolvedError.error).toBe('SDK resolved error')
      expect(resolvedError.runOutcome?.termination).toBe('failed')
      expect(resolvedError.totalCostUsd).toBe(1)
      const partialRunner = new CodebuffRunner({
        cwd: root,
        agentId: 'agent',
        commitId: 'task',
        parentSha: 'HEAD',
        localAgentDefinitions: [],
        printEvents: false,
        artifactSink,
        client: {
          run: async (input: any) => {
            input.handleEvent({ type: 'finish', totalCost: 75 })
            throw new Error('paid then failed')
          },
        } as any,
      })
      const partial = await partialRunner.run('fixture')
      expect(partial.totalCostUsd).toBe(0.75)
      expect(partial.steps).toHaveLength(1)
      expect(partial.error).toBe('paid then failed')
      expect(partial.costEvidence?.status).toBe('reported')
      expect(existsSync(join(root, 'artifacts'))).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('key-free evaluation refuses injected in-process SDK clients', async () => {
    await expect(
      runAgentOnCommit({
        client: { run: async () => ({}) } as any,
        agentId: 'fixture',
        commit: {
          id: 'fixture',
          sha: 'sha',
          parentSha: 'parent',
          spec: 'fixture',
          prompt: 'fixture',
          supplementalFiles: [],
          fileDiffs: [],
        },
        repoUrl: 'offline',
        localAgentDefinitions: [],
        printEvents: false,
        executionScope: 'key_free_environment',
      }),
    ).rejects.toThrow('isolated SDK adapter')
  })

  test('computes cache recall eval and appends deterministic final-check output', async () => {
    const tmpRoot = mkdtempSync(
      join(tmpdir(), 'buffbench-cache-recall-runner-'),
    )

    try {
      writeFileSync(join(tmpRoot, 'README.md'), 'initial\n')
      await Bun.$`git init`.cwd(tmpRoot).quiet()
      await Bun.$`git config user.email test@example.com`.cwd(tmpRoot).quiet()
      await Bun.$`git config user.name Test`.cwd(tmpRoot).quiet()
      await Bun.$`git add .`.cwd(tmpRoot).quiet()
      await Bun.$`git commit -m initial`.cwd(tmpRoot).quiet()
      const parentSha = execSync('git rev-parse HEAD', {
        cwd: tmpRoot,
        encoding: 'utf-8',
      }).trim()

      const client = {
        run: async (input: { cwd: string }) => {
          writeFileSync(join(input.cwd, 'cache-result.txt'), 'changed\n')
          return {
            output: { type: 'text' as const, value: 'done' },
            sessionState: {
              mainAgentState: {
                creditsUsed: 25,
                cacheInputTokens: 750,
                cacheTotalInputTokens: 1000,
                messageHistory: [
                  {
                    role: 'assistant',
                    content:
                      '<knowledge_memory>Validated: typecheck clean</knowledge_memory>',
                  },
                ],
              },
            },
          }
        },
      }

      const result = await runAgentOnCommit({
        client: client as any,
        agentId: 'test-agent',
        commit: {
          id: 'cache-recall-task',
          sha: parentSha,
          parentSha,
          spec: 'Verify cache recall metrics.',
          prompt: 'write a file',
          supplementalFiles: [],
          fileDiffs: [],
        },
        repoUrl: tmpRoot,
        localAgentDefinitions: [],
        printEvents: false,
        cacheRecallEval: {
          minCacheHitRatio: 0.7,
          requiredRecallSubstrings: ['<knowledge_memory>', 'typecheck clean'],
        },
      })

      expect(result.error).toBeUndefined()
      expect(result.cacheRecallEval).toMatchObject({
        passed: true,
        cachedInputTokens: 750,
        inputTokens: 1000,
        cacheHitRatio: 0.75,
        cacheHitRatioPassed: true,
        recallPassed: true,
      })
      expect(result.finalCheckOutputs).toHaveLength(1)
      expect(result.finalCheckOutputs![0]).toMatchObject({
        command: 'buffbench cache-recall eval',
        exitCode: 0,
        stderr: '',
      })
      expect(JSON.parse(result.finalCheckOutputs![0]!.stdout)).toMatchObject({
        passed: true,
        cacheHitRatio: 0.75,
      })
      expect(result.diff).toContain('cache-result.txt')
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true })
    }
  })
})

describe('executeInitCommand', () => {
  test('runs initCommand with shell semantics from the repo root', async () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), 'buffbench-init-command-'))
    const outputPath = join(tmpRoot, 'init-output')

    try {
      executeInitCommand(
        `printf '%s' "hello quoted world" > ${JSON.stringify(outputPath)}`,
        tmpRoot,
      )

      await expect(Bun.file(outputPath).text()).resolves.toBe(
        'hello quoted world',
      )
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true })
    }
  })
})

describe('runFinalCheckCommands', () => {
  test.skipIf(process.platform === 'win32')(
    'reports truncated captured output alongside cancellation',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'buffbench-check-output-'))
      const ready = join(dir, 'ready')
      const controller = new AbortController()
      // A single fs.writeSync to a pipe can write only part of the buffer.
      // stdout.write queues the remaining bytes so capture sees the full flood.
      const script = `process.on('SIGTERM', () => process.stdout.write(Buffer.alloc(11 * 1024 * 1024, 120))); require('fs').writeFileSync(${JSON.stringify(ready)}, 'ready'); setTimeout(() => {}, 30000)`
      try {
        const pending = runFinalCheckCommands(
          [`exec node -e ${JSON.stringify(script)}`],
          dir,
          undefined,
          controller.signal,
        )
        await waitForFile(ready)
        controller.abort()
        const [result] = await pending
        expect(result?.outcome).toBe('cancelled')
        expect(result?.stdout.length).toBe(10 * 1024 * 1024)
        expect(result?.stderr.toLowerCase()).toContain('abort')
        expect(result?.stderr).toContain('Command output truncated')
        expect(result?.processCleanup?.status).toBe('complete')
        expect(result?.outputCapture?.droppedBytes).toBeGreaterThan(0)
      } finally {
        controller.abort()
        rmSync(dir, { recursive: true, force: true })
      }
    },
    10000,
  )

  test('aborts an in-flight final check command and preserves output shape', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'buffbench-check-after-ready-'))
    const ready = join(dir, 'ready')
    const controller = new AbortController()
    try {
      const script = `require('fs').writeFileSync(${JSON.stringify(ready)}, 'ready'); setTimeout(() => {}, 10000)`
      const runPromise = runFinalCheckCommands(
        [`exec node -e ${JSON.stringify(script)}`],
        dir,
        undefined,
        controller.signal,
      )
      await waitForFile(ready)
      controller.abort()
      const [result] = await runPromise
      expect(result).toBeDefined()
      expect(result!.command).toContain('setTimeout')
      expect(result!.exitCode).toBe(130)
      expect(result!.outcome).toBe('cancelled')
      expect(typeof result!.stdout).toBe('string')
      expect(result!.stderr.toLowerCase()).toContain('abort')
      expect(result!.processCleanup?.status).toBe('complete')
    } finally {
      controller.abort()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a successful check remains complete when its signal aborts later', async () => {
    const controller = new AbortController()
    const [result] = await runFinalCheckCommands(
      ['node -e "process.stdout.write(\u0027complete\u0027)"'],
      process.cwd(),
      undefined,
      controller.signal,
    )
    controller.abort()
    expect(result?.outcome).toBe('passed')
    expect(result?.stdout).toBe('complete')
  })

  test('runs independent object checks concurrently and preserves input order', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'buffbench-check-concurrency-'))
    const controller = new AbortController()
    // The first check cannot finish until the second has run. A serial
    // scheduler times out instead of passing on a sufficiently fast machine.
    const firstReady = JSON.stringify(join(dir, 'first-ready'))
    const secondDone = JSON.stringify(join(dir, 'second-done'))
    const first = `const fs = require('fs'); fs.writeFileSync(${firstReady}, 'ready'); const timer = setInterval(() => { if (fs.existsSync(${secondDone})) { clearInterval(timer); process.stdout.write('first'); } }, 5)`
    const second = `const fs = require('fs'); const timer = setInterval(() => { if (fs.existsSync(${firstReady})) { clearInterval(timer); fs.writeFileSync(${secondDone}, 'done'); process.stdout.write('second'); } }, 5)`
    const pending = runFinalCheckCommands(
      [
        { id: 'first', command: `node -e ${JSON.stringify(first)}` },
        { id: 'second', command: `node -e ${JSON.stringify(second)}` },
      ],
      dir,
      undefined,
      controller.signal,
      { concurrency: 2, defaultTimeoutMs: 3_000 },
    )
    try {
      const results = await pending
      expect(results.map((result) => result.checkId)).toEqual([
        'first',
        'second',
      ])
      expect(results.map((result) => result.stdout)).toEqual([
        'first',
        'second',
      ])
      expect(results.every((result) => result.outcome === 'passed')).toBe(true)
    } finally {
      controller.abort()
      await pending
      rmSync(dir, { recursive: true, force: true })
    }
  }, 10_000)

  test('skips dependent checks after a failed prerequisite', async () => {
    const results = await runFinalCheckCommands(
      [
        { id: 'compile', command: 'node -e "process.exit(2)"' },
        {
          id: 'test',
          command: 'node -e "process.exit(0)"',
          dependsOn: ['compile'],
        },
      ],
      process.cwd(),
    )

    expect(results[0]).toMatchObject({ outcome: 'failed', exitCode: 2 })
    expect(results[1]).toMatchObject({ outcome: 'skipped', exitCode: 125 })
  })

  test('reports per-check timeouts distinctly', async () => {
    const [result] = await runFinalCheckCommands(
      [
        {
          id: 'slow',
          command: 'node -e "setTimeout(() => {}, 10000)"',
          timeoutMs: 20,
        },
      ],
      process.cwd(),
    )

    expect(result).toMatchObject({
      checkId: 'slow',
      outcome: 'timed_out',
      exitCode: 124,
    })
  })
})

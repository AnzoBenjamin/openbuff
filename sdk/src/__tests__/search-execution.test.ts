import { afterEach, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { codeSearchParams } from '@codebuff/common/tools/params/tool/code-search'
import { findFilesMatchingContentParams } from '@codebuff/common/tools/params/tool/find-files-matching-content'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { executionRefusalSchema } from '@codebuff/common/tools/params/execution-refusal'
import { processCleanupSchema } from '@codebuff/common/tools/params/process-cleanup'
import { codeSearch } from '../tools/code-search'
import { findFilesMatchingContent } from '../tools/find-files-matching-content'
import { OpenbuffClient } from '../client'
import { nodeConfigReadFs } from '../host-config'
import type { AgentDefinition } from '@codebuff/common/templates/initial-agents-dir/types/agent-definition'
import type { LaunchEvent } from '@codebuff/common/types/contracts/execution-context'
import {
  createExecutionProcessRecorder,
  createControlledExecutionClock,
  createRealExecutionProcessRecorder,
  createTerminalExecutionFixture,
} from './fixtures/b19-terminal-execution'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true })
})
function project() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'search-execution-'))
  roots.push(root)
  fs.writeFileSync(path.join(root, 'input.txt'), 'AUTHORITY_SEARCH_MATCH\n')
  return root
}
const searches = [
  { name: 'code_search', run: codeSearch, format: 'ranked' },
  {
    name: 'code_search files-only',
    run: (input: Parameters<typeof codeSearch>[0]) =>
      codeSearch({ ...input, flags: '-l' }),
    format: 'files-only',
  },
  {
    name: 'find_files_matching_content',
    run: findFilesMatchingContent,
    format: 'paths',
  },
] as const

for (const search of searches) {
  test(`${search.name}: independent pre-aborted caller signal refuses before ripgrep`, async () => {
    const root = project(),
      recorder = createExecutionProcessRecorder(),
      caller = new AbortController()
    const fixture = createTerminalExecutionFixture({
      projectRoot: root,
      spawn: recorder.spawn,
    })
    caller.abort(new Error('Caller already cancelled'))
    try {
      const value = (
        await search.run({
          projectPath: root,
          pattern: 'AUTHORITY_SEARCH_MATCH',
          executionContext: fixture.context,
          signal: caller.signal,
        })
      )[0].value
      expect(executionRefusalSchema.parse(value.executionRefusal).reason).toBe(
        'cancelled',
      )
      expect(recorder.calls).toHaveLength(0)
    } finally {
      fixture.dispose()
    }
  })

  test(`${search.name}: independent caller cancellation during approval prevents dispatch`, async () => {
    const root = project(),
      recorder = createExecutionProcessRecorder({
        reply: () => ({
          stdout:
            search.format === 'ranked'
              ? `${JSON.stringify({
                  type: 'match',
                  data: {
                    path: { text: 'input.txt' },
                    line_number: 1,
                    lines: { text: 'AUTHORITY_SEARCH_MATCH\n' },
                  },
                })}\n`
              : 'input.txt\n',
          exitCode: 0,
        }),
      }),
      caller = new AbortController()
    let resolveApproval!: () => void, enteredApproval!: () => void
    const entered = new Promise<void>((resolve) => {
      enteredApproval = resolve
    })
    const approval = new Promise<void>((resolve) => {
      resolveApproval = resolve
    })
    const fixture = createTerminalExecutionFixture({
      projectRoot: root,
      spawn: recorder.spawn,
      authorize: async () => {
        enteredApproval()
        await approval
        return {
          ok: true,
          basis: 'explicit-policy',
          decisionId: 'caller-cancel-search-allow',
        }
      },
    })
    try {
      const pending = search.run({
        projectPath: root,
        pattern: 'AUTHORITY_SEARCH_MATCH',
        executionContext: fixture.context,
        signal: caller.signal,
      })
      await entered
      caller.abort(new Error('Caller cancelled during approval'))
      resolveApproval()
      const value = (await pending)[0].value
      expect(executionRefusalSchema.parse(value.executionRefusal).reason).toBe(
        'cancelled',
      )
      expect(recorder.calls).toHaveLength(0)
      expect(
        fixture.events.filter(
          (event) =>
            event.phase === 'dispatched' || event.phase === 'spawn-observed',
        ),
      ).toHaveLength(0)
    } finally {
      resolveApproval()
      fixture.dispose()
    }
  })

  test(`${search.name}: independent caller cancellation stops the dispatched scope and keeps partial results`, async () => {
    const root = project(),
      recorder = createExecutionProcessRecorder({ autoClose: false }),
      caller = new AbortController()
    const fixture = createTerminalExecutionFixture({
      projectRoot: root,
      spawn: recorder.spawn,
    })
    try {
      const pending = search.run({
        projectPath: root,
        pattern: 'AUTHORITY_SEARCH_MATCH',
        executionContext: fixture.context,
        signal: caller.signal,
      })
      const deadline = performance.now() + 1_000
      while (!recorder.calls[0]?.child.stdout?.listenerCount('data')) {
        if (performance.now() >= deadline)
          throw new Error('Search did not attach its stdout consumer')
        await new Promise((resolve) => setTimeout(resolve, 1))
      }
      const partial =
        search.format === 'ranked'
          ? `${JSON.stringify({
              type: 'match',
              data: {
                path: { text: 'input.txt' },
                line_number: 1,
                lines: { text: 'AUTHORITY_SEARCH_MATCH\n' },
              },
            })}\n`
          : 'input.txt\n'
      recorder.calls[0]!.child.stdout?.emit('data', Buffer.from(partial))
      caller.abort(new Error('Caller cancelled dispatched search'))
      let timeout: ReturnType<typeof setTimeout> | undefined
      let value: Awaited<typeof pending>[number]['value']
      try {
        value = (
          await Promise.race([
            pending,
            new Promise<never>((_, reject) => {
              timeout = setTimeout(
                () => reject(new Error('Caller cancellation did not settle')),
                1_000,
              )
            }),
          ])
        )[0].value
      } finally {
        if (timeout) clearTimeout(timeout)
      }
      expect(executionRefusalSchema.parse(value.executionRefusal).reason).toBe(
        'cancelled',
      )
      if ('stdout' in value) expect(value.stdout).toContain('input.txt')
      else if ('files' in value) expect(value.files).toContain('input.txt')
      else throw new Error('Interrupted search discarded its partial results')
      expect(recorder.calls[0]?.signals).toContain('SIGTERM')
      expect(processCleanupSchema.parse(value.processCleanup).status).toBe(
        'complete',
      )
    } finally {
      fixture.dispose()
    }
  })

  test(`${search.name}: missing authority refuses before ripgrep`, async () => {
    const result = await search.run({
      projectPath: project(),
      pattern: 'AUTHORITY_SEARCH_MATCH',
    })
    expect(
      executionRefusalSchema.parse(result[0].value.executionRefusal).reason,
    ).toBe('unavailable')
  })

  test(`${search.name}: real bundled ripgrep uses captured environment and joins its owned scope`, async () => {
    const root = project(),
      recorder = createRealExecutionProcessRecorder()
    const fixture = createTerminalExecutionFixture({
      projectRoot: root,
      spawn: recorder.spawn,
      environment: { PROJECT_VALUE: 'search-captured' },
    })
    try {
      const result = await search.run({
        projectPath: root,
        pattern: 'AUTHORITY_SEARCH_MATCH',
        executionContext: fixture.context,
      })
      const value = result[0].value
      expect('errorMessage' in value).toBe(false)
      if ('stdout' in value) expect(value.stdout).toContain('input.txt')
      else if ('files' in value) expect(value.files).toEqual(['input.txt'])
      else throw new Error('Real search returned no match projection')
      expect(recorder.calls).toHaveLength(1)
      expect(recorder.calls[0].spawnObserved).toBe(true)
      expect(recorder.calls[0].argv[0]).toBe('--no-config')
      expect(recorder.calls[0].options.env?.PROJECT_VALUE).toBe(
        'search-captured',
      )
      expect(recorder.calls[0].options.env).not.toHaveProperty('OPENAI_API_KEY')
      expect(recorder.calls[0].options.env).not.toHaveProperty(
        'CUSTOM_PROVIDER_KEY',
      )
      expect(recorder.calls[0].options.cwd).toBe(root)
      expect(recorder.calls[0].options.detached).toBe(true)
      const cleanup = processCleanupSchema.parse(value.processCleanup)
      expect(cleanup.status).toBe('complete')
      expect(cleanup.cleanupAuthorityRetained).toBe(false)
      expect(cleanup.finalObservation.leader).toBe('exited-reaped')
      expect(
        fixture.events.filter((event) => event.phase === 'dispatched'),
      ).toHaveLength(1)
      expect(
        fixture.events.filter((event) => event.phase === 'spawn-observed'),
      ).toHaveLength(1)
    } finally {
      fixture.dispose()
    }
  })

  for (const state of [
    'denied',
    'unavailable',
    'preabort',
    'exhausted',
    'cancel-during-approval',
    'expire-during-approval',
  ] as const) {
    test(`${search.name}: ${state} never dispatches or falls back`, async () => {
      const root = project(),
        recorder = createRealExecutionProcessRecorder()
      const clock = createControlledExecutionClock(),
        controller = new AbortController()
      let resolveApproval!: () => void, enteredApproval!: () => void
      const entered = new Promise<void>((resolve) => {
        enteredApproval = resolve
      })
      const approval = new Promise<void>((resolve) => {
        resolveApproval = resolve
      })
      const fixture = createTerminalExecutionFixture({
        projectRoot: root,
        spawn: recorder.spawn,
        clock: clock.clock,
        scheduler: clock.scheduler,
        signal: controller.signal,
        rootLimit: { kind: 'finite', durationMs: 10 },
        ...(state === 'unavailable'
          ? {
              resolveProfile: (request) => ({
                requested: request,
                available: [],
                selected: null,
                active: null,
                enforced: [],
              }),
            }
          : {}),
        authorize: async () => {
          if (state === 'denied')
            return {
              ok: false,
              reason: 'denied',
              cause: 'Search policy denied',
            }
          enteredApproval()
          await approval
          return {
            ok: true,
            basis: 'explicit-policy',
            decisionId: 'search-allow',
          }
        },
      })
      try {
        if (state === 'preabort')
          controller.abort(new Error('Search already cancelled'))
        if (state === 'exhausted') clock.advance(10)
        const pending = search.run({
          projectPath: root,
          pattern: 'AUTHORITY_SEARCH_MATCH',
          executionContext: fixture.context,
        })
        if (
          state === 'cancel-during-approval' ||
          state === 'expire-during-approval'
        ) {
          await entered
          if (state === 'cancel-during-approval')
            controller.abort(new Error('Cancelled during search approval'))
          else clock.advance(10)
          resolveApproval()
        }
        const value = (await pending)[0].value
        const refusal = executionRefusalSchema.parse(value.executionRefusal)
        expect(refusal.reason).toBe(
          state === 'denied' || state === 'unavailable'
            ? state
            : state === 'preabort' || state === 'cancel-during-approval'
              ? 'cancelled'
              : 'deadline-exhausted',
        )
        expect(recorder.calls).toHaveLength(0)
        expect(
          fixture.events.filter(
            (event) =>
              event.phase === 'dispatched' || event.phase === 'spawn-observed',
          ),
        ).toHaveLength(0)
      } finally {
        resolveApproval()
        fixture.dispose()
      }
    })
  }

  for (const termination of ['deadline', 'cancel'] as const) {
    test.skipIf(process.platform !== 'linux')(
      `${search.name}: injected target tree ${termination} joins physical death after presentation stops`,
      async () => {
        const root = project(),
          marker = path.join(root, 'late.txt'),
          controller = new AbortController()
        let ready!: () => void
        const becameReady = new Promise<void>((resolve) => {
          ready = resolve
        })
        let child: ChildProcess | undefined
        const fixture = createTerminalExecutionFixture({
          projectRoot: root,
          signal: controller.signal,
          rootLimit:
            termination === 'deadline'
              ? { kind: 'finite', durationMs: 300 }
              : { kind: 'unbounded' },
          // The trusted spawn seam substitutes a hostile tree to test the search
          // adapter's scope join. This does not prove ripgrep's executable identity.
          spawn: (_command, _args, options = {}) => {
            const partial =
              search.format === 'ranked'
                ? JSON.stringify({
                    type: 'match',
                    data: {
                      path: { text: 'input.txt' },
                      line_number: 1,
                      lines: { text: 'AUTHORITY_SEARCH_MATCH\n' },
                    },
                  }) + '\n'
                : 'input.txt\n'
            const quote = (text: string) =>
              "'" + text.replaceAll("'", "'\\''") + "'"
            const script =
              "trap '' TERM; /usr/bin/bash -c 'trap \"\" TERM; /usr/bin/sleep 2; printf late > late.txt' & printf %s " +
              quote(partial) +
              "; printf 'TREE_READY\\n'; wait"
            const spawned = spawn('/usr/bin/bash', ['-c', script], options)
            child = spawned
            spawned.stdout?.on('data', (chunk) => {
              if (String(chunk).includes('TREE_READY')) ready()
            })
            return spawned
          },
        })
        try {
          const pending = search.run({
            projectPath: root,
            pattern: 'AUTHORITY_SEARCH_MATCH',
            timeoutSeconds: 5,
            executionContext: fixture.context,
          })
          await becameReady
          if (termination === 'cancel')
            controller.abort(new Error('Search tree cancellation'))
          const value = (await pending)[0].value
          expect(
            executionRefusalSchema.parse(value.executionRefusal).reason,
          ).toBe(
            termination === 'deadline' ? 'deadline-exhausted' : 'cancelled',
          )
          const schema =
            search.format === 'paths'
              ? findFilesMatchingContentParams.outputSchema
              : codeSearchParams.outputSchema
          const roundTrip = schema.parse([{ type: 'json', value }])[0].value
          expect(
            executionRefusalSchema.parse(roundTrip.executionRefusal).reason,
          ).toBe(
            termination === 'deadline' ? 'deadline-exhausted' : 'cancelled',
          )
          expect(roundTrip.errorMessage).toBeString()
          if ('stdout' in roundTrip)
            expect(roundTrip.stdout).toContain(
              search.format === 'ranked'
                ? 'AUTHORITY_SEARCH_MATCH'
                : 'input.txt',
            )
          else if ('files' in roundTrip)
            expect(roundTrip.files).toContain('input.txt')
          else throw new Error('Schema discarded interrupted search matches')
          expect(
            processCleanupSchema.parse(roundTrip.processCleanup).status,
          ).toBe('complete')
          const cleanup = processCleanupSchema.parse(value.processCleanup)
          expect(cleanup.status).toBe('complete')
          expect(cleanup.selectedTier).toBe('posix-owned-group')
          expect(cleanup.satisfiesSelectedTier).toBe(true)
          expect(cleanup.cleanupAuthorityRetained).toBe(false)
          expect(cleanup.finalObservation.leader).toBe('exited-reaped')
          expect(
            cleanup.finalObservation.members.filter(
              (member) => member.disposition === 'living',
            ),
          ).toHaveLength(0)
          expect(child?.exitCode !== null || child?.signalCode !== null).toBe(
            true,
          )
          await Bun.sleep(2100)
          expect(fs.existsSync(marker)).toBe(false)
        } finally {
          fixture.dispose()
        }
      },
      12_000,
    )
  }
}

for (const toolName of [
  'code_search',
  'find_files_matching_content',
] as const) {
  test(`${toolName}: SDK dispatcher overrides peer branch and execution context`, async () => {
    const root = project(),
      config = path.join(root, 'openbuff.json'),
      events: LaunchEvent[] = []
    fs.writeFileSync(
      config,
      JSON.stringify({
        providers: {},
        autoFileChangeHooks: false,
        fileChangeHooks: [],
      }),
    )
    const client = new OpenbuffClient({
      cwd: root,
      knowledgeFiles: {},
      approvalMode: 'allow-all',
      harnessStateDir: path.join(root, 'state'),
      configReadFs: nodeConfigReadFs,
      hostConfiguration: {
        invocationCwd: root,
        projectRoot: root,
        platform: process.platform,
        environment: { PATH: '/usr/bin:/bin' },
        home: { kind: 'none' },
        globals: { kind: 'disabled' },
        selection: { kind: 'explicit', path: config, required: true },
        trust: { ancestorConfig: false, projectReadableRoots: false },
      },
    })
    const agent: AgentDefinition = {
      id: 'search-dispatch-fixture',
      displayName: 'Search dispatcher fixture',
      model: 'fixture-model',
      toolNames: [toolName, 'set_output'],
      outputMode: 'structured_output',
      handleSteps: function* ({ prompt }) {
        const request = JSON.parse(prompt ?? '{}')
        const result = yield {
          toolName: request.toolName,
          input: request.input,
        }
        yield { toolName: 'set_output', input: { result: result.toolResult } }
      },
    }
    const run = await client.run({
      agent,
      runTimeoutMs: 5000,
      recordExecution: (event) => events.push(event),
      prompt: JSON.stringify({
        toolName,
        input: {
          pattern: 'AUTHORITY_SEARCH_MATCH',
          branchId: 'peer-forged-branch',
          executionContext: { execution: {}, projectRoot: '/peer-forged-root' },
          projectPath: '/peer-forged-root',
        },
      }),
    })
    expect(run.runOutcome?.termination).toBe('completed')
    const branch =
      toolName === 'code_search'
        ? 'sdk.code-search'
        : 'sdk.find-files-matching-content'
    expect(
      events.filter(
        (event) =>
          event.phase === 'dispatched' && event.facts.branchId === branch,
      ),
    ).toHaveLength(1)
    expect(
      events.some(
        (event) =>
          'facts' in event && event.facts.branchId === 'peer-forged-branch',
      ),
    ).toBe(false)
  })
}

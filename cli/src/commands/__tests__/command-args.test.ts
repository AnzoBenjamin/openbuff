import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test'
import fs from 'fs'
import os from 'os'
import path from 'path'

import { setProjectRoot } from '../../project-files'
import { useChatStore } from '../../state/chat-store'
import { useFeedbackStore } from '../../state/feedback-store'
import {
  COMMAND_REGISTRY,
  defineCommand,
  defineCommandWithArgs,
  formatPlanListReport,
  planListActiveState,
} from '../command-registry'
import {
  ACTIVE_SESSION_FILE_NAME,
  listPlanSessions,
  PLAN_ARTIFACT_NAMES,
} from '../plan-artifacts'

import type { RouterParams } from '../command-registry'
import type {
  ContentBlock,
  PlanStatusContentBlock,
  TextContentBlock,
} from '../../types/chat'

/**
 * Tests for the command factory pattern.
 *
 * The factory pattern ensures commands handle arguments correctly:
 * - defineCommand: creates commands that gracefully ignore arguments
 * - defineCommandWithArgs: creates commands that receive and handle arguments
 */
describe('command factory pattern', () => {
  const createMockParams = (
    overrides: Partial<RouterParams> = {},
  ): RouterParams =>
    ({
      abortControllerRef: { current: null },
      agentMode: 'DEFAULT',
      inputRef: { current: null },
      inputValue: '/test',
      isChainInProgressRef: { current: false },
      isStreaming: false,
      streamMessageIdRef: { current: null },
      addToQueue: mock(() => {}),
      clearMessages: mock(() => {}),
      saveToHistory: mock(() => {}),
      scrollToLatest: mock(() => {}),
      sendMessage: mock(async () => {}),
      setCanProcessQueue: mock(() => {}),
      setInputFocused: mock(() => {}),
      setInputValue: mock(() => {}),
      setMessages: mock(() => {}),
      stopStreaming: mock(() => {}),
      ...overrides,
    }) as RouterParams

  describe('defineCommand (gracefully ignores args)', () => {
    test('calls handler when no args provided', () => {
      const handler = mock(() => {})
      const cmd = defineCommand({
        name: 'test',
        handler,
      })

      const params = createMockParams()
      cmd.handler(params, '')

      expect(handler).toHaveBeenCalledWith(params)
    })

    test('calls handler even when args are provided (gracefully ignores)', () => {
      const handler = mock(() => {})
      const cmd = defineCommand({
        name: 'test',
        handler,
      })

      const params = createMockParams()
      cmd.handler(params, 'some unexpected args')

      // Handler should still be called - args are ignored
      expect(handler).toHaveBeenCalledWith(params)
    })

    test('sets aliases correctly', () => {
      const cmd = defineCommand({
        name: 'test',
        aliases: ['t', 'tst'],
        handler: () => {},
      })

      expect(cmd.aliases).toEqual(['t', 'tst'])
    })

    test('defaults to empty aliases when not provided', () => {
      const cmd = defineCommand({
        name: 'test',
        handler: () => {},
      })

      expect(cmd.aliases).toEqual([])
    })

    test('sets acceptsArgs to false', () => {
      const cmd = defineCommand({
        name: 'test',
        handler: () => {},
      })

      expect(cmd.acceptsArgs).toBe(false)
    })
  })

  describe('defineCommandWithArgs', () => {
    test('passes args to handler', () => {
      const handler = mock(() => {})
      const cmd = defineCommandWithArgs({
        name: 'test',
        handler,
      })

      const params = createMockParams()
      cmd.handler(params, 'some args')

      expect(handler).toHaveBeenCalledWith(params, 'some args')
    })

    test('passes empty args to handler', () => {
      const handler = mock(() => {})
      const cmd = defineCommandWithArgs({
        name: 'test',
        handler,
      })

      const params = createMockParams()
      cmd.handler(params, '')

      expect(handler).toHaveBeenCalledWith(params, '')
    })

    test('sets aliases correctly', () => {
      const cmd = defineCommandWithArgs({
        name: 'test',
        aliases: ['t', 'tst'],
        handler: () => {},
      })

      expect(cmd.aliases).toEqual(['t', 'tst'])
    })

    test('sets acceptsArgs to true', () => {
      const cmd = defineCommandWithArgs({
        name: 'test',
        handler: () => {},
      })

      expect(cmd.acceptsArgs).toBe(true)
    })
  })

  describe('COMMAND_REGISTRY commands', () => {
    const noArgsCommands = COMMAND_REGISTRY.filter((cmd) => !cmd.acceptsArgs)
    const withArgsCommands = COMMAND_REGISTRY.filter((cmd) => cmd.acceptsArgs)

    test('there are commands that ignore args', () => {
      expect(noArgsCommands.length).toBeGreaterThan(0)
    })

    test('there are commands that accept args', () => {
      expect(withArgsCommands.length).toBeGreaterThan(0)
    })

    test('expected commands ignore args', () => {
      const expectedNoArgs = ['exit', 'help', 'init', 'plans']
      for (const name of expectedNoArgs) {
        const cmd = COMMAND_REGISTRY.find((c) => c.name === name)
        expect(cmd, `Command ${name} should exist`).toBeDefined()
        expect(cmd?.acceptsArgs, `Command ${name} should not accept args`).toBe(
          false,
        )
      }
    })

    test('expected commands accept args', () => {
      // mode:* commands also accept args now
      const expectedWithArgs = [
        'feedback',
        'bash',
        'image',
        'publish',
        'new',
        'resume-plan',
        'update-plan',
        'plan-status',
        'plan-use',
        'lessons',
        'mode:default',
        'mode:plan',
        'mode:execute_plan',
      ]
      for (const name of expectedWithArgs) {
        const cmd = COMMAND_REGISTRY.find((c) => c.name === name)
        expect(cmd, `Command ${name} should exist`).toBeDefined()
        expect(cmd?.acceptsArgs, `Command ${name} should accept args`).toBe(
          true,
        )
      }
    })

    test('mode commands accept args to send as first message', () => {
      const modeCommands = COMMAND_REGISTRY.filter((cmd) =>
        cmd.name.startsWith('mode:'),
      )
      expect(modeCommands.length).toBeGreaterThan(0)
      for (const cmd of modeCommands) {
        expect(
          cmd.acceptsArgs,
          `Mode command ${cmd.name} should accept args`,
        ).toBe(true)
      }
    })

    test('does not register /plan (plan MODE supersedes the command)', () => {
      expect(COMMAND_REGISTRY.find((c) => c.name === 'plan')).toBeUndefined()
    })

    test('retains the durable-plan quartet plus mode:plan after /plan removal', () => {
      for (const name of [
        'resume-plan',
        'update-plan',
        'plan-status',
        'lessons',
        'mode:plan',
      ]) {
        expect(
          COMMAND_REGISTRY.find((c) => c.name === name),
          `Command ${name} should remain registered`,
        ).toBeDefined()
      }
    })

    test('registers /plans and /plan-use with their aliases', () => {
      const plansCmd = COMMAND_REGISTRY.find((c) => c.name === 'plans')
      expect(plansCmd, 'Command plans should remain registered').toBeDefined()
      expect(plansCmd?.aliases).toEqual(['plan-ls'])

      const planUseCmd = COMMAND_REGISTRY.find((c) => c.name === 'plan-use')
      expect(
        planUseCmd,
        'Command plan-use should remain registered',
      ).toBeDefined()
      expect(planUseCmd?.aliases).toEqual(['plan-active', 'use-plan'])
    })
  })

  describe('new command arg handling', () => {
    test('clears messages and sends arg as first message when args provided', () => {
      const newCmd = COMMAND_REGISTRY.find((c) => c.name === 'new')
      expect(newCmd).toBeDefined()

      const sendMessage = mock(async () => {})
      const setMessages = mock(() => {})
      const clearMessages = mock(() => {})
      const setCanProcessQueue = mock(() => {})

      const params = createMockParams({
        inputValue: '/new hello world',
        sendMessage,
        setMessages,
        clearMessages,
        setCanProcessQueue,
      })

      newCmd!.handler(params, 'hello world')

      // Should clear messages
      expect(setMessages).toHaveBeenCalled()
      expect(clearMessages).toHaveBeenCalled()

      // Should re-enable queue and send message
      expect(setCanProcessQueue).toHaveBeenCalledWith(true)
      expect(sendMessage).toHaveBeenCalledWith({
        content: 'hello world',
        agentMode: 'DEFAULT',
      })
    })

    test('clears messages without sending when no args provided', () => {
      const newCmd = COMMAND_REGISTRY.find((c) => c.name === 'new')
      expect(newCmd).toBeDefined()

      const sendMessage = mock(async () => {})
      const setMessages = mock(() => {})
      const clearMessages = mock(() => {})
      const setCanProcessQueue = mock(() => {})

      const params = createMockParams({
        inputValue: '/new',
        sendMessage,
        setMessages,
        clearMessages,
        setCanProcessQueue,
      })

      newCmd!.handler(params, '')

      // Should clear messages
      expect(setMessages).toHaveBeenCalled()
      expect(clearMessages).toHaveBeenCalled()

      // Should disable queue and NOT send message
      expect(setCanProcessQueue).toHaveBeenCalledWith(false)
      expect(sendMessage).not.toHaveBeenCalled()
    })
  })

  describe('durable plan command arg handling', () => {
    let tmpRoot: string

    const writeArtifact = (slug: string, name: string, body: string) => {
      const dir = path.join(tmpRoot, '.agents', 'sessions', slug)
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, name), body, 'utf8')
    }

    /**
     * Write a STATE.json with fixed timestamps so listPlanSessions() returns
     * deterministic summaries (the synthesized fallback stamps `new Date()`).
     */
    const writeSessionState = (
      slug: string,
      status: string,
      currentTask: string | null = null,
    ) => {
      writeArtifact(
        slug,
        'STATE.json',
        JSON.stringify({
          schemaVersion: 2,
          slug,
          status,
          currentTask,
          revision: 1,
          checkpoint: null,
          createdAt: '2024-01-01T00:00:00.000Z',
          updatedAt: '2024-01-02T00:00:00.000Z',
        }),
      )
    }

    const activeSessionPointerPath = () =>
      path.join(tmpRoot, '.agents', ACTIVE_SESSION_FILE_NAME)

    /** The stale-active-session note `/plans` emits for a pointer slug. */
    const staleNoteFor = (slug: string) =>
      `Stale active session: ${slug} (no listed plan session matches .agents/${ACTIVE_SESSION_FILE_NAME}). Use /plan-use <slug> to point at an existing session.`

    type MessagesUpdater = (
      prev: unknown[],
    ) => Array<{ content: string; blocks?: ContentBlock[] }>

    /**
     * The system message appended by a local (non-sending) command handler.
     * Local handlers append exactly once, so the single-call expectation keeps an
     * extra setMessages call from being silently ignored while the message is
     * still read from the last call.
     */
    const lastSystemMessage = (
      setMessagesCalls: unknown,
    ): { content: string; blocks?: ContentBlock[] } => {
      const calls = setMessagesCalls as Array<[MessagesUpdater]>
      expect(calls.length).toBe(1)
      const next = calls[calls.length - 1][0]([])
      return next[next.length - 1]
    }

    /** The `/plans` list block, narrowed off the emitted block list. */
    const planListBlock = (
      blocks: ContentBlock[] | undefined,
    ): PlanStatusContentBlock => {
      const block = blocks?.[0]
      expect(block?.type).toBe('plan-status-list')
      if (!block || block.type !== 'plan-status-list') {
        throw new Error('expected a plan-status-list block')
      }
      return block
    }

    /** Text blocks carried alongside the `/plans` list block. */
    const textBlockContents = (blocks: ContentBlock[] | undefined): string[] =>
      (blocks ?? [])
        .filter((block): block is TextContentBlock => block.type === 'text')
        .map((block) => block.content)

    beforeEach(() => {
      tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-cmd-'))
      setProjectRoot(tmpRoot)
    })

    afterEach(() => {
      fs.rmSync(tmpRoot, { recursive: true, force: true })
      useChatStore.getState().setAgentMode('DEFAULT')
    })

    test('resume-plan reads artifacts into the prompt', () => {
      writeArtifact('auth-refresh', 'PLAN.md', '# Plan\n- [ ] task one')
      writeArtifact('auth-refresh', 'STATUS.md', 'in progress: task one')

      const resumeCmd = COMMAND_REGISTRY.find((c) => c.name === 'resume-plan')
      expect(resumeCmd).toBeDefined()

      const sendMessage = mock(async () => {})
      const params = createMockParams({
        inputValue: '/resume-plan auth-refresh',
        sendMessage,
      })

      resumeCmd!.handler(params, 'auth-refresh')

      expect(sendMessage).toHaveBeenCalledTimes(1)
      const calls = sendMessage.mock.calls as unknown as Array<
        [{ content: string; agentMode: string }]
      >
      const call = calls[0][0]
      expect(call.agentMode).toBe('EXECUTE_PLAN')
      expect(call.content).toContain('.agents/sessions/auth-refresh')
      expect(call.content).toContain('in progress: task one')
      expect(call.content).toContain('# Plan')
      expect(call.content).toContain('initial authoritative source of truth')
      expect(call.content).toContain(
        'Use the injected STATUS.md and PLAN.md contents to find the next actionable milestone',
      )
      expect(call.content).toContain(
        'Read artifacts directly only when their injected contents are missing, truncated, stale, or have changed',
      )
      expect(call.content).not.toContain('Read STATUS.md and PLAN.md first')
      expect(call.content).toContain('update_plan_status')
    })

    test('resume-plan switches the persistent agent mode to EXECUTE_PLAN', () => {
      writeArtifact('auth-refresh', 'PLAN.md', '# Plan\n- [ ] task one')

      // Start from a non-execute mode to prove the toggle actually switches.
      useChatStore.getState().setAgentMode('PLAN')

      const resumeCmd = COMMAND_REGISTRY.find((c) => c.name === 'resume-plan')
      const params = createMockParams({
        inputValue: '/resume-plan auth-refresh',
        sendMessage: mock(async () => {}),
      })

      resumeCmd!.handler(params, 'auth-refresh')

      expect(useChatStore.getState().agentMode).toBe('EXECUTE_PLAN')
    })

    test('resume-plan with missing session does not send', () => {
      const resumeCmd = COMMAND_REGISTRY.find((c) => c.name === 'resume-plan')
      const sendMessage = mock(async () => {})
      const setMessages = mock(() => {})
      const params = createMockParams({
        inputValue: '/resume-plan missing-slug',
        sendMessage,
        setMessages,
      })

      resumeCmd!.handler(params, 'missing-slug')

      expect(sendMessage).not.toHaveBeenCalled()
      expect(setMessages).toHaveBeenCalled()
    })

    test('update-plan includes note and artifact content in prompt', () => {
      writeArtifact('foo', 'SPEC.md', 'spec body')
      writeArtifact('foo', 'PLAN.md', 'plan body')

      const updateCmd = COMMAND_REGISTRY.find((c) => c.name === 'update-plan')
      const sendMessage = mock(async () => {})
      const params = createMockParams({
        inputValue: '/update-plan .agents/sessions/foo API changed',
        sendMessage,
      })

      updateCmd!.handler(params, '.agents/sessions/foo API changed')

      const calls = sendMessage.mock.calls as unknown as Array<
        [{ content: string; agentMode: string }]
      >
      const call = calls[0][0]
      expect(call.content).toContain('User note/context: API changed')
      expect(call.content).toContain('spec body')
      expect(call.content).toContain('plan body')
      expect(call.content).toContain('update_plan_status')
      expect(call.content).toContain('create_plan')
    })

    test('lessons includes note and artifact content in prompt', () => {
      writeArtifact('foo', 'PLAN.md', 'plan body')

      const lessonsCmd = COMMAND_REGISTRY.find((c) => c.name === 'lessons')
      const sendMessage = mock(async () => {})
      const params = createMockParams({
        inputValue: '/lessons foo always run tests',
        sendMessage,
      })

      lessonsCmd!.handler(params, 'foo always run tests')

      const calls = sendMessage.mock.calls as unknown as Array<
        [{ content: string; agentMode: string }]
      >
      const call = calls[0][0]
      expect(call.content).toContain(
        'User note/context to incorporate: always run tests',
      )
      expect(call.content).toContain('plan body')
      expect(call.content).toContain('update_plan_status')
    })

    test('plan-status displays local status without sending to agent', () => {
      writeArtifact('foo', 'STATUS.md', 'currently: ready for review')
      writeArtifact('foo', 'PLAN.md', 'plan body')

      const statusCmd = COMMAND_REGISTRY.find((c) => c.name === 'plan-status')
      const sendMessage = mock(async () => {})
      const setMessages = mock(() => {})
      const params = createMockParams({
        inputValue: '/plan-status foo',
        sendMessage,
        setMessages,
      })

      statusCmd!.handler(params, 'foo')

      expect(sendMessage).not.toHaveBeenCalled()
      const systemMessage = lastSystemMessage(setMessages.mock.calls)
      expect(systemMessage.content).toContain('currently: ready for review')
      expect(systemMessage.content).toContain('.agents/sessions/foo/PLAN.md')
      expect(systemMessage.content).toContain('Missing: SPEC.md, LESSONS.md')
    })

    test('plan-status reports a session directory that does not exist', () => {
      const statusCmd = COMMAND_REGISTRY.find((c) => c.name === 'plan-status')
      const sendMessage = mock(async () => {})
      const setMessages = mock(() => {})
      const params = createMockParams({
        inputValue: '/plan-status ghost',
        sendMessage,
        setMessages,
      })

      statusCmd!.handler(params, 'ghost')

      // readPlanArtifacts returns null for a missing directory, which is
      // formatPlanStatusReport's `!artifacts` branch.
      expect(sendMessage).not.toHaveBeenCalled()
      expect(lastSystemMessage(setMessages.mock.calls).content).toBe(
        '/plan-status: session directory .agents/sessions/ghost not found.',
      )
    })

    test('durable plan commands with missing args open plan session picker', () => {
      const commandNames = [
        'resume-plan',
        'update-plan',
        'plan-status',
        'lessons',
        'plan-use',
      ]

      for (const name of commandNames) {
        const cmd = COMMAND_REGISTRY.find((c) => c.name === name)
        expect(cmd).toBeDefined()

        const sendMessage = mock(async () => {})
        const setMessages = mock(() => {})
        const saveToHistory = mock(() => {})
        const setInputValue = mock(() => {})
        const params = createMockParams({
          inputValue: `/${name}`,
          sendMessage,
          setMessages,
          saveToHistory,
          setInputValue,
        })

        const result = cmd!.handler(params, '')

        expect(result).toEqual({ openPlanSessionPicker: name })
        expect(sendMessage).not.toHaveBeenCalled()
        expect(setMessages).not.toHaveBeenCalled()
        expect(saveToHistory).toHaveBeenCalledTimes(1)
        expect(saveToHistory).toHaveBeenCalledWith(`/${name}`)
        expect(setInputValue).toHaveBeenCalledWith({
          text: '',
          cursorPosition: 0,
          lastEditDueToNav: false,
        })
      }
    })

    test('plans emits a plan-status-list block without sending to the agent', () => {
      writeArtifact(
        'alpha',
        'PLAN.md',
        '- [x] done one\n- [ ] task two\n<!-- current-task: task two -->',
      )
      writeSessionState('alpha', 'active', 'task two')
      writeArtifact('beta', 'SPEC.md', 'spec body')
      writeSessionState('beta', 'paused')

      const plansCmd = COMMAND_REGISTRY.find((c) => c.name === 'plans')
      expect(plansCmd).toBeDefined()

      const sendMessage = mock(async () => {})
      const setMessages = mock(() => {})
      const params = createMockParams({
        inputValue: '/plans',
        sendMessage,
        setMessages,
      })

      plansCmd!.handler(params, '')

      // /plans is a local inspector: it must never reach the agent.
      expect(sendMessage).not.toHaveBeenCalled()

      const message = lastSystemMessage(setMessages.mock.calls)
      const block = planListBlock(message.blocks)
      expect(block.mode).toBe('list')
      expect(block.isStatusReport).toBe(false)
      // No pointer file exists, so no stale-pointer note block is carried.
      expect(textBlockContents(message.blocks)).toEqual([])
      // Explicit expectations on the carried rows: the slug set plus each row's
      // scan-derived fields. Asserting equality against a second
      // listPlanSessions() call would only add a redundant filesystem scan and a
      // dependency on directory-mtime ordering.
      const carried = block.sessions ?? []
      expect(carried.map((session) => session.slug).sort()).toEqual([
        'alpha',
        'beta',
      ])
      const bySlug = new Map(carried.map((session) => [session.slug, session]))
      expect(bySlug.get('alpha')).toEqual(
        expect.objectContaining({
          status: 'active',
          isActive: false,
          currentTask: 'task two',
          progress: { done: 1, total: 2 },
        }),
      )
      expect(bySlug.get('beta')).toEqual(
        expect.objectContaining({
          status: 'paused',
          isActive: false,
          currentTask: null,
          progress: { done: 0, total: 0 },
        }),
      )
      // The text fallback is formatted from the very rows the block carries.
      expect(block.reportText).toBe(
        formatPlanListReport(carried, planListActiveState(carried)),
      )
      expect(block.reportText).toBe(message.content)
      // `kind` duplicated `mode` and is no longer emitted.
      expect('kind' in block).toBe(false)
    })

    test('plans carries the stale-pointer note as a rendered text block', () => {
      writeArtifact('alpha', 'PLAN.md', 'plan body')
      writeSessionState('alpha', 'active')
      // 'ghost' has no known artifacts, so listPlanSessions filters it out and
      // no scanned row is marked active: the pointer is stale.
      fs.mkdirSync(path.join(tmpRoot, '.agents', 'sessions', 'ghost'), {
        recursive: true,
      })
      fs.writeFileSync(activeSessionPointerPath(), 'ghost\n', 'utf8')

      const plansCmd = COMMAND_REGISTRY.find((c) => c.name === 'plans')
      const setMessages = mock(() => {})
      const params = createMockParams({ inputValue: '/plans', setMessages })

      plansCmd!.handler(params, '')

      const staleNote = staleNoteFor('ghost')
      const message = lastSystemMessage(setMessages.mock.calls)
      const block = planListBlock(message.blocks)
      // PlanStatusBox renders the rows and ignores reportText whenever any
      // session exists, so the note has to travel on its own block to stay
      // visible in the rendered UI.
      expect(block.sessions?.map((session) => session.slug)).toEqual(['alpha'])
      expect(textBlockContents(message.blocks)).toEqual([staleNote])
      // The text fallback still carries the same note exactly once, from the
      // same single pointer read.
      expect(block.reportText.split('\n')).toContain(staleNote)
      expect(message.content).toBe(block.reportText)
    })

    test('plans carries the stale-pointer note only in reportText when no sessions are listed', () => {
      // Only the pointer file exists, so listPlanSessions finds no rows and
      // PlanStatusBox falls back to rendering reportText — which
      // formatPlanListReport already ends with the note. A second text block
      // here would show the same note twice.
      fs.mkdirSync(path.join(tmpRoot, '.agents'), { recursive: true })
      fs.writeFileSync(activeSessionPointerPath(), 'ghost\n', 'utf8')

      const plansCmd = COMMAND_REGISTRY.find((c) => c.name === 'plans')
      const setMessages = mock(() => {})
      const params = createMockParams({ inputValue: '/plans', setMessages })

      plansCmd!.handler(params, '')

      const staleNote = staleNoteFor('ghost')
      const message = lastSystemMessage(setMessages.mock.calls)
      const block = planListBlock(message.blocks)
      expect(block.sessions).toEqual([])
      expect(textBlockContents(message.blocks)).toEqual([])
      // Exactly one occurrence in the rendered fallback text.
      expect(
        block.reportText.split('\n').filter((line) => line === staleNote),
      ).toEqual([staleNote])
      expect(message.content).toBe(block.reportText)
    })

    test('formatPlanListReport flags an active-session pointer with no listed session', () => {
      writeArtifact('alpha', 'PLAN.md', 'plan body')
      writeSessionState('alpha', 'active')
      // 'ghost' exists on disk but has zero known artifacts, so
      // listPlanSessions filters it out and no scanned row is marked active.
      fs.mkdirSync(path.join(tmpRoot, '.agents', 'sessions', 'ghost'), {
        recursive: true,
      })
      fs.writeFileSync(activeSessionPointerPath(), 'ghost\n', 'utf8')

      const sessions = listPlanSessions()
      expect(sessions.map((session) => session.slug)).toEqual(['alpha'])
      expect(sessions.some((session) => session.isActive)).toBe(false)

      const report = formatPlanListReport(
        sessions,
        planListActiveState(sessions),
      )
      const lines = report.split('\n')

      expect(lines).toContain(staleNoteFor('ghost'))
      // The rows themselves never claimed an active session, so the normal
      // 'Active session: <slug>' line must stay absent.
      expect(lines.some((line) => line.startsWith('Active session:'))).toBe(
        false,
      )
    })

    test('formatPlanListReport flags a stale pointer when no sessions exist at all', () => {
      fs.mkdirSync(path.join(tmpRoot, '.agents'), { recursive: true })
      fs.writeFileSync(activeSessionPointerPath(), 'ghost\n', 'utf8')

      const sessions = listPlanSessions()
      const report = formatPlanListReport(
        sessions,
        planListActiveState(sessions),
      )
      const lines = report.split('\n')

      expect(lines[0]).toBe('No plan sessions found under .agents/sessions/.')
      expect(lines).toContain(staleNoteFor('ghost'))
    })

    test('formatPlanListReport renders the empty-sessions text', () => {
      // No pointer file exists, so the empty-sessions text stands alone.
      expect(
        formatPlanListReport([], { activeSlug: null, staleNote: null }),
      ).toBe(
        [
          'No plan sessions found under .agents/sessions/.',
          'Use /mode:plan to start one.',
        ].join('\n'),
      )
    })

    test('formatPlanListReport formats badge, progress, current task and active marker', () => {
      writeArtifact(
        'alpha',
        'PLAN.md',
        '- [x] done one\n- [ ] task two\n<!-- current-task: task two -->',
      )
      writeSessionState('alpha', 'active', 'task two')
      writeArtifact('beta', 'SPEC.md', 'spec body')
      writeSessionState('beta', 'paused')
      fs.writeFileSync(activeSessionPointerPath(), 'alpha\n', 'utf8')

      const sessions = listPlanSessions()
      const report = formatPlanListReport(
        sessions,
        planListActiveState(sessions),
      )
      const lines = report.split('\n')

      expect(lines[0]).toBe(`Plan sessions (${sessions.length}):`)
      // ' * ' active marker + padded badge + progress + current task.
      expect(lines).toContain(
        ' * [active]    alpha 1/2 done  current: "task two"',
      )
      // Non-active row: blank marker, no progress (total 0), no current task.
      expect(lines).toContain('   [paused]    beta')
      expect(lines[lines.length - 1]).toBe('Active session: alpha')
    })

    test('plan-use without a slug opens the picker and writes no pointer', () => {
      const planUseCmd = COMMAND_REGISTRY.find((c) => c.name === 'plan-use')
      expect(planUseCmd).toBeDefined()

      const setMessages = mock(() => {})
      const params = createMockParams({
        inputValue: '/plan-use',
        setMessages,
      })

      const result = planUseCmd!.handler(params, '')

      // Consistent with every other plan command: a missing target routes
      // through the shared session picker instead of printing usage text.
      expect(result).toEqual({ openPlanSessionPicker: 'plan-use' })
      expect(setMessages).not.toHaveBeenCalled()
      expect(fs.existsSync(activeSessionPointerPath())).toBe(false)
    })

    test('plan-use rejects an invalid slug', () => {
      const planUseCmd = COMMAND_REGISTRY.find((c) => c.name === 'plan-use')
      const setMessages = mock(() => {})
      const params = createMockParams({
        inputValue: '/plan-use bad slug!',
        setMessages,
      })

      planUseCmd!.handler(params, 'bad slug!')

      expect(lastSystemMessage(setMessages.mock.calls).content).toBe(
        '/plan-use: invalid slug "bad slug!". Slugs may contain letters, digits, dots, underscores, and dashes.',
      )
      expect(fs.existsSync(activeSessionPointerPath())).toBe(false)
    })

    test('plan-use accepts the .agents/sessions/<slug> path form', () => {
      writeArtifact('alpha', 'PLAN.md', 'plan body')

      const planUseCmd = COMMAND_REGISTRY.find((c) => c.name === 'plan-use')
      const setMessages = mock(() => {})
      const params = createMockParams({
        inputValue: '/plan-use .agents/sessions/alpha',
        setMessages,
      })

      planUseCmd!.handler(params, '.agents/sessions/alpha')

      // The path form every other plan command accepts resolves to the same
      // session, and the pointer file stores the resolved bare slug.
      expect(lastSystemMessage(setMessages.mock.calls).content).toBe(
        'Active session set to alpha (.agents/sessions/alpha).',
      )
      expect(fs.readFileSync(activeSessionPointerPath(), 'utf8')).toBe(
        'alpha\n',
      )
    })

    test('plan-use fails closed when the session directory does not exist', () => {
      const planUseCmd = COMMAND_REGISTRY.find((c) => c.name === 'plan-use')
      const setMessages = mock(() => {})
      const params = createMockParams({
        inputValue: '/plan-use ghost',
        setMessages,
      })

      planUseCmd!.handler(params, 'ghost')

      expect(lastSystemMessage(setMessages.mock.calls).content).toBe(
        '/plan-use: no plan session found at .agents/sessions/ghost. Use /plans to list existing sessions, or /mode:plan to start one.',
      )
      expect(fs.existsSync(activeSessionPointerPath())).toBe(false)
    })

    test('plan-use fails closed for a session directory without artifacts', () => {
      fs.mkdirSync(path.join(tmpRoot, '.agents', 'sessions', 'empty'), {
        recursive: true,
      })

      const planUseCmd = COMMAND_REGISTRY.find((c) => c.name === 'plan-use')
      const setMessages = mock(() => {})
      const params = createMockParams({
        inputValue: '/plan-use empty',
        setMessages,
      })

      planUseCmd!.handler(params, 'empty')

      // /plans would not list this session, so the pointer must not name it.
      expect(lastSystemMessage(setMessages.mock.calls).content).toBe(
        `/plan-use: no plan artifacts found under .agents/sessions/empty. Expected one of: ${PLAN_ARTIFACT_NAMES.join(', ')}. Use /plans to list existing sessions, or /mode:plan to start one.`,
      )
      expect(fs.existsSync(activeSessionPointerPath())).toBe(false)
    })

    test('plan-use rejects a path that escapes the project root', () => {
      const planUseCmd = COMMAND_REGISTRY.find((c) => c.name === 'plan-use')
      const setMessages = mock(() => {})
      const params = createMockParams({
        inputValue: '/plan-use ../outside',
        setMessages,
      })

      planUseCmd!.handler(params, '../outside')

      // resolvePlanSessionDir fails before any slug or containment check runs,
      // so the pointer file is never created.
      expect(lastSystemMessage(setMessages.mock.calls).content).toBe(
        '/plan-use: Resolved session path escapes the project root.',
      )
      expect(fs.existsSync(activeSessionPointerPath())).toBe(false)
    })

    test('plan-use rejects a path outside .agents/sessions', () => {
      // A real directory with a real plan artifact, so the existsSync and
      // artifact checks would both pass: only the sessions-dir check can reject
      // it. Without that check the pointer would be written as bare 'foo',
      // resolving to the nonexistent .agents/sessions/foo.
      const outsideDir = path.join(tmpRoot, 'src', 'foo')
      fs.mkdirSync(outsideDir, { recursive: true })
      fs.writeFileSync(path.join(outsideDir, 'PLAN.md'), 'plan body', 'utf8')

      const planUseCmd = COMMAND_REGISTRY.find((c) => c.name === 'plan-use')
      const setMessages = mock(() => {})
      const params = createMockParams({
        inputValue: '/plan-use src/foo',
        setMessages,
      })

      planUseCmd!.handler(params, 'src/foo')

      expect(lastSystemMessage(setMessages.mock.calls).content).toBe(
        '/plan-use: src/foo is not a plan session directory. Use a bare slug or .agents/sessions/<slug>.',
      )
      expect(fs.existsSync(activeSessionPointerPath())).toBe(false)
    })

    test('plan-use rejects traversal out of .agents/sessions', () => {
      const outsideDir = path.join(tmpRoot, 'src', 'foo')
      fs.mkdirSync(outsideDir, { recursive: true })
      fs.writeFileSync(path.join(outsideDir, 'PLAN.md'), 'plan body', 'utf8')

      const planUseCmd = COMMAND_REGISTRY.find((c) => c.name === 'plan-use')
      const setMessages = mock(() => {})
      const params = createMockParams({
        inputValue: '/plan-use .agents/sessions/../src/foo',
        setMessages,
      })

      planUseCmd!.handler(params, '.agents/sessions/../src/foo')

      // Traversal that stays inside the project root still resolves outside
      // .agents/sessions/ (here `.agents/src/foo`), so it is rejected on the
      // same branch.
      expect(lastSystemMessage(setMessages.mock.calls).content).toBe(
        '/plan-use: .agents/src/foo is not a plan session directory. Use a bare slug or .agents/sessions/<slug>.',
      )
      expect(fs.existsSync(activeSessionPointerPath())).toBe(false)
    })

    test('plan-use rejects a nested path under a session directory', () => {
      writeArtifact('alpha', 'PLAN.md', 'plan body')
      const nested = path.join(tmpRoot, '.agents', 'sessions', 'alpha', 'sub')
      fs.mkdirSync(nested, { recursive: true })
      fs.writeFileSync(path.join(nested, 'PLAN.md'), 'plan body', 'utf8')

      const planUseCmd = COMMAND_REGISTRY.find((c) => c.name === 'plan-use')
      const setMessages = mock(() => {})
      const params = createMockParams({
        inputValue: '/plan-use .agents/sessions/alpha/sub',
        setMessages,
      })

      planUseCmd!.handler(params, '.agents/sessions/alpha/sub')

      // The pointer stores bare slugs, so a multi-segment session path could
      // never be represented by it.
      expect(lastSystemMessage(setMessages.mock.calls).content).toBe(
        '/plan-use: .agents/sessions/alpha/sub is not a plan session directory. Use a bare slug or .agents/sessions/<slug>.',
      )
      expect(fs.existsSync(activeSessionPointerPath())).toBe(false)
    })

    test('plan-use writes .agents/ACTIVE_SESSION for an existing session', () => {
      writeArtifact('alpha', 'PLAN.md', 'plan body')

      const planUseCmd = COMMAND_REGISTRY.find((c) => c.name === 'plan-use')
      const sendMessage = mock(async () => {})
      const setMessages = mock(() => {})
      const params = createMockParams({
        inputValue: '/plan-use alpha',
        sendMessage,
        setMessages,
      })

      planUseCmd!.handler(params, 'alpha')

      expect(sendMessage).not.toHaveBeenCalled()
      expect(lastSystemMessage(setMessages.mock.calls).content).toBe(
        'Active session set to alpha (.agents/sessions/alpha).',
      )
      expect(fs.readFileSync(activeSessionPointerPath(), 'utf8')).toBe(
        'alpha\n',
      )
    })

    test('plan-use reports a failed pointer write and leaves no pointer file', () => {
      writeArtifact('alpha', 'PLAN.md', 'plan body')

      // Both the validation steps and the pointer write resolve the project root
      // through the CLI resolver, so the write is made to fail on its own terms:
      // a directory sitting at the pointer path makes writeFileSync throw.
      fs.mkdirSync(activeSessionPointerPath(), { recursive: true })

      const planUseCmd = COMMAND_REGISTRY.find((c) => c.name === 'plan-use')
      const sendMessage = mock(async () => {})
      const setMessages = mock(() => {})
      const params = createMockParams({
        inputValue: '/plan-use alpha',
        sendMessage,
        setMessages,
      })

      planUseCmd!.handler(params, 'alpha')

      expect(sendMessage).not.toHaveBeenCalled()
      expect(lastSystemMessage(setMessages.mock.calls).content).toBe(
        '/plan-use: failed to write .agents/ACTIVE_SESSION (project root not set?).',
      )
      // Nothing was written: the path is still the blocking directory.
      expect(fs.statSync(activeSessionPointerPath()).isDirectory()).toBe(true)
    })

    test('listPlanSessions returns sessions with plan artifacts only', () => {
      writeArtifact('with-plan', 'PLAN.md', 'plan body')
      writeArtifact('with-status', 'STATUS.md', 'status body')
      fs.mkdirSync(path.join(tmpRoot, '.agents', 'sessions', 'empty'), {
        recursive: true,
      })

      const sessions = listPlanSessions()

      expect(sessions.map((session) => session.slug).sort()).toEqual([
        'with-plan',
        'with-status',
      ])
      expect(sessions).toContainEqual(
        expect.objectContaining({
          slug: 'with-plan',
          sessionDir: '.agents/sessions/with-plan',
          artifacts: ['PLAN.md'],
        }),
      )
    })
  })

  describe('feedback command arg handling', () => {
    test('pre-populates feedback text when args are provided', () => {
      const feedbackCmd = COMMAND_REGISTRY.find((c) => c.name === 'feedback')
      expect(feedbackCmd).toBeDefined()

      // Reset the feedback store
      useFeedbackStore.getState().reset()

      const params = createMockParams({ inputValue: '/feedback my bug report' })
      feedbackCmd!.handler(params, 'my bug report')

      // Check that feedback text was pre-populated
      const state = useFeedbackStore.getState()
      expect(state.feedbackText).toBe('my bug report')
      expect(state.feedbackCursor).toBe('my bug report'.length)
    })

    test('opens feedback mode without pre-populating when no args', () => {
      const feedbackCmd = COMMAND_REGISTRY.find((c) => c.name === 'feedback')
      expect(feedbackCmd).toBeDefined()

      // Reset the feedback store
      useFeedbackStore.getState().reset()

      const params = createMockParams({ inputValue: '/feedback' })
      const result = feedbackCmd!.handler(params, '')

      // Should return openFeedbackMode
      expect(result).toEqual({ openFeedbackMode: true })

      // Feedback text should remain empty
      const state = useFeedbackStore.getState()
      expect(state.feedbackText).toBe('')
    })

    test('returns openFeedbackMode even with args', () => {
      const feedbackCmd = COMMAND_REGISTRY.find((c) => c.name === 'feedback')
      expect(feedbackCmd).toBeDefined()

      // Reset the feedback store
      useFeedbackStore.getState().reset()

      const params = createMockParams({ inputValue: '/feedback test' })
      const result = feedbackCmd!.handler(params, 'test')

      // Should still return openFeedbackMode
      expect(result).toEqual({ openFeedbackMode: true })
    })
  })
})

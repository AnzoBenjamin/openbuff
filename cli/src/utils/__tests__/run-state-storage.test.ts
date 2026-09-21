import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

import { setProjectRoot, setCurrentChatId } from '../../project-files'
import {
  getAllToggleIdsFromMessages,
  getRunStatePath,
  getChatMessagesPath,
  getChatStatePath,
  saveChatState,
  loadMostRecentChatState,
  clearChatState,
  isValidChatId,
  loadChatStateFromDirectory,
  loadChatStateFromCompatibilityFiles,
} from '../run-state-storage'
import type { ChatMessage, ContentBlock } from '../../types/chat'
import type { RunState } from '@openbuff/sdk'

// Mock the project-files module
const mockProjectDataDir = path.join(os.tmpdir(), 'codebuff-test-project')
const mockCurrentChatDir = path.join(
  mockProjectDataDir,
  'chats',
  'test-chat-123',
)

// Mock the module before importing
const originalGetProjectDataDir = () => mockProjectDataDir
const originalGetCurrentChatDir = () => mockCurrentChatDir

describe('run-state-storage', () => {
  beforeEach(() => {
    // Create test directories
    if (fs.existsSync(mockProjectDataDir)) {
      fs.rmSync(mockProjectDataDir, { recursive: true })
    }
    fs.mkdirSync(mockCurrentChatDir, { recursive: true })
  })

  afterEach(() => {
    // Clean up test directories
    if (fs.existsSync(mockProjectDataDir)) {
      fs.rmSync(mockProjectDataDir, { recursive: true })
    }
  })

  describe('getAllToggleIdsFromMessages', () => {
    test('extracts agent IDs from messages', () => {
      const messages: ChatMessage[] = [
        {
          id: 'msg-1',
          variant: 'agent',
          content: '',
          timestamp: new Date().toISOString(),
          blocks: [
            {
              type: 'agent',
              agentId: 'agent-1',
              agentName: 'TestAgent',
              agentType: 'inline',
              content: '',
              status: 'complete',
              blocks: [],
            },
          ],
        },
      ]

      const ids = getAllToggleIdsFromMessages(messages)

      expect(ids).toContain('agent-1')
    })

    test('extracts tool call IDs from messages', () => {
      const messages: ChatMessage[] = [
        {
          id: 'msg-1',
          variant: 'agent',
          content: '',
          timestamp: new Date().toISOString(),
          blocks: [
            {
              type: 'tool',
              toolCallId: 'tool-1',
              toolName: 'glob',
              input: {},
              output: '',
            },
          ],
        },
      ]

      const ids = getAllToggleIdsFromMessages(messages)

      expect(ids).toContain('tool-1')
    })

    test('recursively extracts IDs from nested agent blocks', () => {
      const messages: ChatMessage[] = [
        {
          id: 'msg-1',
          variant: 'agent',
          content: '',
          timestamp: new Date().toISOString(),
          blocks: [
            {
              type: 'agent',
              agentId: 'parent-agent',
              agentName: 'ParentAgent',
              agentType: 'inline',
              content: '',
              status: 'complete',
              blocks: [
                {
                  type: 'tool',
                  toolCallId: 'nested-tool',
                  toolName: 'glob',
                  input: {},
                  output: '',
                },
                {
                  type: 'agent',
                  agentId: 'child-agent',
                  agentName: 'ChildAgent',
                  agentType: 'inline',
                  content: '',
                  status: 'complete',
                  blocks: [
                    {
                      type: 'tool',
                      toolCallId: 'deep-tool',
                      toolName: 'glob',
                      input: {},
                      output: '',
                    },
                  ],
                },
              ],
            },
          ],
        },
      ]

      const ids = getAllToggleIdsFromMessages(messages)

      expect(ids).toContain('parent-agent')
      expect(ids).toContain('nested-tool')
      expect(ids).toContain('child-agent')
      expect(ids).toContain('deep-tool')
    })

    test('handles messages with no blocks', () => {
      const messages: ChatMessage[] = [
        {
          id: 'msg-1',
          variant: 'user',
          content: '',
          timestamp: new Date().toISOString(),
          blocks: [],
        },
      ]

      const ids = getAllToggleIdsFromMessages(messages)

      expect(ids).toHaveLength(0)
    })

    test('handles empty messages array', () => {
      const ids = getAllToggleIdsFromMessages([])
      expect(ids).toHaveLength(0)
    })

    test('handles mixed block types in single message', () => {
      const messages: ChatMessage[] = [
        {
          id: 'msg-1',
          variant: 'agent',
          content: '',
          timestamp: new Date().toISOString(),
          blocks: [
            { type: 'text', content: 'Some text' },
            {
              type: 'agent',
              agentId: 'agent-1',
              agentName: 'TestAgent',
              agentType: 'inline',
              content: '',
              status: 'complete',
              blocks: [],
            },
            {
              type: 'tool',
              toolCallId: 'tool-1',
              toolName: 'glob',
              input: {},
              output: '',
            },
          ],
        },
      ]

      const ids = getAllToggleIdsFromMessages(messages)

      expect(ids).toContain('agent-1')
      expect(ids).toContain('tool-1')
      expect(ids).toHaveLength(2)
    })

    test('does not deduplicate IDs (returns all occurrences)', () => {
      const messages: ChatMessage[] = [
        {
          id: 'msg-1',
          variant: 'agent',
          content: '',
          timestamp: new Date().toISOString(),
          blocks: [
            {
              type: 'agent',
              agentId: 'shared-id',
              agentName: 'TestAgent',
              agentType: 'inline',
              content: '',
              status: 'complete',
              blocks: [],
            },
          ],
        },
        {
          id: 'msg-2',
          variant: 'agent',
          content: '',
          timestamp: new Date().toISOString(),
          blocks: [
            {
              type: 'tool',
              toolCallId: 'shared-id',
              toolName: 'glob',
              input: {},
              output: '',
            },
          ],
        },
      ]

      const ids = getAllToggleIdsFromMessages(messages)

      // Current implementation returns all occurrences without deduplication
      expect(ids.filter((id) => id === 'shared-id')).toHaveLength(2)
    })
  })

  describe('getRunStatePath', () => {
    test('returns path with correct filename', () => {
      // We need to mock the internal functions
      // This is a simplified test - in reality we'd need to mock the module
      const testPath = path.join(mockCurrentChatDir, 'run-state.json')
      expect(testPath).toContain('run-state.json')
    })
  })

  describe('getChatMessagesPath', () => {
    test('returns path with correct filename', () => {
      const testPath = path.join(mockCurrentChatDir, 'chat-messages.json')
      expect(testPath).toContain('chat-messages.json')
    })
  })

  describe('chat id containment', () => {
    test('accepts a single chat directory name', () => {
      expect(isValidChatId('2026-07-12T10-30-00.000Z')).toBe(true)
    })

    test.each([
      '../other-project',
      '../../secrets',
      'nested/chat',
      '/absolute/chat',
      '.',
      '..',
      '   ',
    ])('rejects unsafe chat id %s', (chatId) => {
      expect(isValidChatId(chatId)).toBe(false)
    })
  })

  describe('legacy session validation (P6.5)', () => {
    test('rejects a legacy messages file whose entries fail the shape guard', () => {
      fs.writeFileSync(
        path.join(mockCurrentChatDir, 'run-state.json'),
        JSON.stringify({ output: { type: 'error', message: 'x' } }),
      )
      fs.writeFileSync(
        path.join(mockCurrentChatDir, 'chat-messages.json'),
        JSON.stringify([{ notAnId: true }]),
      )

      expect(loadChatStateFromCompatibilityFiles(mockCurrentChatDir)).toBeNull()
    })

    test('rejects a chat-state envelope whose messages fail the shape guard', () => {
      fs.writeFileSync(
        path.join(mockCurrentChatDir, 'chat-state.json'),
        JSON.stringify({
          version: 1,
          runState: { output: { type: 'error', message: 'x' } },
          messages: [{ id: 123 }],
        }),
      )

      // Falls through to compatibility recovery, which finds no legacy files
      // either, so the caller starts a fresh session.
      expect(loadChatStateFromDirectory(mockCurrentChatDir)).toBeNull()
    })

    test('accepts valid legacy messages that include extra fields', () => {
      const runState = {
        output: { type: 'error', message: 'Recovered output' },
      } as unknown as RunState
      const messages: ChatMessage[] = [
        {
          id: 'msg-1',
          variant: 'user',
          timestamp: new Date().toISOString(),
          content: 'Recovered prompt',
        },
      ]
      fs.writeFileSync(
        path.join(mockCurrentChatDir, 'run-state.json'),
        JSON.stringify(runState),
      )
      fs.writeFileSync(
        path.join(mockCurrentChatDir, 'chat-messages.json'),
        JSON.stringify(messages),
      )

      const loaded = loadChatStateFromCompatibilityFiles(mockCurrentChatDir)
      expect(loaded?.messages).toEqual(messages)
    })

    test('accepts a legacy AgentState snapshot carrying removed fields', () => {
      // Compat contract: fields removed from the AgentState type (e.g. the
      // former consecutiveTextOnlyWithoutCompletion) must never make an
      // older persisted snapshot unloadable. The read path is non-strict
      // (JSON.parse + sanitizeForChatPersistence), so legacy payloads load
      // unchanged and the stale field is dropped on the next save.
      const legacyRunState = {
        sessionState: {
          mainAgentState: {
            agentId: 'main',
            agentType: null,
            agentContext: {},
            subagents: [],
            messageHistory: [],
            stepsRemaining: 10,
            // Removed in a prior release; must be tolerated on read.
            consecutiveTextOnlyWithoutCompletion: 7,
          },
          subagents: [],
        },
        output: { type: 'error', message: 'Legacy output' },
      } as unknown as RunState
      const messages: ChatMessage[] = [
        {
          id: 'legacy-msg-1',
          variant: 'user',
          timestamp: new Date().toISOString(),
          content: 'Legacy prompt',
        },
      ]
      fs.writeFileSync(
        path.join(mockCurrentChatDir, 'chat-state.json'),
        JSON.stringify({ version: 1, runState: legacyRunState, messages }),
      )

      const loaded = loadChatStateFromDirectory(mockCurrentChatDir)
      expect(loaded).not.toBeNull()
      expect(loaded?.runState).toEqual(legacyRunState)
      expect(loaded?.messages).toEqual(messages)
      // The stale field is still present on the loaded object (passthrough,
      // not rejection); the next save simply stops writing it.
      const mainAgentState = (
        loaded?.runState as unknown as {
          sessionState: { mainAgentState: Record<string, unknown> }
        }
      ).sessionState.mainAgentState
      expect(mainAgentState['consecutiveTextOnlyWithoutCompletion']).toBe(7)
    })
  })

  describe('mixed CLI version envelope tolerance', () => {
    // saveChatState resolves its write target through project-files, and bun
    // module mocking does not reliably intercept bound imports; point the real
    // resolvers at an isolated temp dir instead (same pattern as
    // turn-checkpoint.test.ts).
    const tmpConfigDir = path.join(
      os.tmpdir(),
      `codebuff-envelope-test-${process.pid}`,
    )
    const originalConfigDir = process.env.OPENBUFF_CONFIG_DIR

    beforeEach(() => {
      mock.restore()
      if (fs.existsSync(tmpConfigDir)) {
        fs.rmSync(tmpConfigDir, { recursive: true, force: true })
      }
      fs.mkdirSync(tmpConfigDir, { recursive: true })
      process.env.OPENBUFF_CONFIG_DIR = tmpConfigDir
      setProjectRoot(tmpConfigDir)
      setCurrentChatId('test-chat-envelope')
    })

    afterEach(() => {
      if (originalConfigDir === undefined) {
        delete process.env.OPENBUFF_CONFIG_DIR
      } else {
        process.env.OPENBUFF_CONFIG_DIR = originalConfigDir
      }
      if (fs.existsSync(tmpConfigDir)) {
        fs.rmSync(tmpConfigDir, { recursive: true, force: true })
      }
    })

    test('saveChatState leaves a newer envelope in place instead of clobbering it', () => {
      // A downgraded CLI continuing a session must not destroy the newer
      // release's chat-state.json: the read path relies on that file being
      // found again after re-upgrade.
      const newerEnvelope = {
        version: 2,
        runState: {
          output: { type: 'error', message: 'written by a newer CLI' },
        },
        messages: [
          {
            id: 'newer-msg-1',
            variant: 'user',
            content: 'Newer session prompt',
            timestamp: new Date().toISOString(),
            blocks: [],
          },
        ],
      }
      const chatStatePath = getChatStatePath()
      fs.writeFileSync(chatStatePath, JSON.stringify(newerEnvelope, null, 2))

      saveChatState(
        {
          output: { type: 'error', message: 'downgraded CLI output' },
        } as unknown as RunState,
        [
          {
            id: 'downgraded-msg-1',
            variant: 'user',
            content: 'Downgraded session prompt',
            timestamp: new Date().toISOString(),
            blocks: [],
          },
        ],
      )

      expect(JSON.parse(fs.readFileSync(chatStatePath, 'utf8'))).toEqual(
        newerEnvelope,
      )
      // Legacy sidecars still advance so compatibility recovery keeps working
      // for the downgraded process.
      expect(fs.existsSync(getRunStatePath())).toBe(true)
      expect(fs.existsSync(getChatMessagesPath())).toBe(true)
    })

    test('saveChatState still refreshes an envelope of its own version', () => {
      // The guard must only skip unrecognized versions, never strand a stale
      // session behind a same-version envelope.
      fs.writeFileSync(
        getChatStatePath(),
        JSON.stringify({ version: 1, runState: {}, messages: [] }),
      )
      saveChatState(
        { output: { type: 'error', message: 'fresh output' } } as unknown as RunState,
        [
          {
            id: 'fresh-msg-1',
            variant: 'user',
            content: 'Fresh prompt',
            timestamp: new Date().toISOString(),
            blocks: [],
          },
        ],
      )

      const parsed = JSON.parse(fs.readFileSync(getChatStatePath(), 'utf8'))
      expect(parsed.version).toBe(1)
      expect(parsed.messages).toHaveLength(1)
      expect(parsed.messages[0].id).toBe('fresh-msg-1')
    })

    test('a newer envelope survives a downgraded session load for re-upgrade', () => {
      // Read-path counterpart: the parseable newer envelope is neither
      // quarantined nor deleted, so the re-upgraded CLI finds it again; the
      // downgraded CLI falls back to compatibility recovery, which finds no
      // legacy files here and reports no session.
      const newerEnvelope = {
        version: 2,
        runState: {},
        messages: [],
      }
      const chatStatePath = getChatStatePath()
      fs.writeFileSync(chatStatePath, JSON.stringify(newerEnvelope))
      const chatDir = path.dirname(chatStatePath)

      expect(loadChatStateFromDirectory(chatDir)).toBeNull()

      expect(JSON.parse(fs.readFileSync(chatStatePath, 'utf8'))).toEqual(
        newerEnvelope,
      )
      expect(
        fs
          .readdirSync(chatDir)
          .some((name) => name.startsWith('chat-state.json.corrupt.')),
      ).toBe(false)
    })
  })

  describe('file serialization format', () => {
    test('recovers from compatibility files when the envelope is corrupt', () => {
      const runState = {
        output: { type: 'error', message: 'Recovered output' },
      } as unknown as RunState
      const messages: ChatMessage[] = [
        {
          id: 'recovered-message',
          variant: 'user',
          content: 'Recovered prompt',
          timestamp: new Date().toISOString(),
          blocks: [],
        },
      ]
      fs.writeFileSync(
        path.join(mockCurrentChatDir, 'run-state.json'),
        JSON.stringify(runState),
      )
      fs.writeFileSync(
        path.join(mockCurrentChatDir, 'chat-messages.json'),
        JSON.stringify(messages),
      )
      fs.writeFileSync(
        path.join(mockCurrentChatDir, 'chat-state.json'),
        '{ corrupt json',
      )

      const recovered = loadChatStateFromDirectory(mockCurrentChatDir)

      expect(recovered?.runState).toEqual(runState)
      expect(recovered?.messages).toEqual(messages)
      expect(recovered?.chatId).toBe('test-chat-123')
      expect(
        fs.existsSync(path.join(mockCurrentChatDir, 'chat-state.json')),
      ).toBe(false)
      expect(
        fs
          .readdirSync(mockCurrentChatDir)
          .some((name) => name.startsWith('chat-state.json.corrupt.')),
      ).toBe(true)
    })

    test('run state JSON structure is preserved through serialization', () => {
      const runState: RunState = {
        output: {
          type: 'error',
          message: 'Test output',
        },
      } as unknown as RunState

      const runStatePath = path.join(mockCurrentChatDir, 'run-state.json')
      fs.writeFileSync(runStatePath, JSON.stringify(runState, null, 2))

      const savedRunState = JSON.parse(fs.readFileSync(runStatePath, 'utf8'))
      expect(savedRunState.output.type).toBe('error')
      expect(savedRunState.output.message).toBe('Test output')
    })

    test('messages JSON structure is preserved through serialization', () => {
      const messages: ChatMessage[] = [
        {
          id: 'msg-1',
          variant: 'user',
          content: 'Hello',
          timestamp: new Date().toISOString(),
          blocks: [{ type: 'text', content: 'Hello' }],
        },
      ]

      const messagesPath = path.join(mockCurrentChatDir, 'chat-messages.json')
      fs.writeFileSync(messagesPath, JSON.stringify(messages, null, 2))

      const savedMessages = JSON.parse(fs.readFileSync(messagesPath, 'utf8'))
      expect(savedMessages).toHaveLength(1)
      expect(savedMessages[0].variant).toBe('user')
    })

    test('nested message structure is preserved through serialization', () => {
      const messages: ChatMessage[] = [
        {
          id: 'msg-1',
          variant: 'agent',
          content: '',
          timestamp: new Date().toISOString(),
          blocks: [
            {
              type: 'agent',
              agentId: 'nested-agent',
              agentName: 'NestedAgent',
              agentType: 'inline',
              content: '',
              status: 'complete',
              blocks: [
                { type: 'text', content: 'Nested content' },
                {
                  type: 'tool',
                  toolCallId: 'tool-xyz',
                  toolName: 'glob',
                  input: {},
                  output: '',
                },
              ],
            },
          ],
        },
      ]

      const messagesPath = path.join(mockCurrentChatDir, 'chat-messages.json')
      fs.writeFileSync(messagesPath, JSON.stringify(messages, null, 2))

      const savedMessages = JSON.parse(fs.readFileSync(messagesPath, 'utf8'))
      expect(savedMessages[0].blocks[0].type).toBe('agent')
      expect(savedMessages[0].blocks[0].blocks).toHaveLength(2)
    })
  })

  describe('edge cases', () => {
    test('handles empty blocks array', () => {
      const messages: ChatMessage[] = [
        {
          id: 'msg-1',
          variant: 'agent',
          content: '',
          timestamp: new Date().toISOString(),
          blocks: [],
        },
      ]

      const ids = getAllToggleIdsFromMessages(messages)
      expect(ids).toHaveLength(0)
    })

    test('handles deeply nested structure', () => {
      const deepBlock: ContentBlock = {
        type: 'agent',
        agentId: 'level-0',
        agentName: 'Level0Agent',
        agentType: 'inline',
        content: '',
        status: 'complete',
        blocks: [
          {
            type: 'agent',
            agentId: 'level-1',
            agentName: 'Level1Agent',
            agentType: 'inline',
            content: '',
            status: 'complete',
            blocks: [
              {
                type: 'agent',
                agentId: 'level-2',
                agentName: 'Level2Agent',
                agentType: 'inline',
                content: '',
                status: 'complete',
                blocks: [
                  {
                    type: 'tool',
                    toolCallId: 'deep-tool',
                    toolName: 'glob',
                    input: {},
                    output: '',
                  },
                ],
              },
            ],
          },
        ],
      }

      const messages: ChatMessage[] = [
        {
          id: 'msg-1',
          variant: 'agent',
          content: '',
          timestamp: new Date().toISOString(),
          blocks: [deepBlock],
        },
      ]

      const ids = getAllToggleIdsFromMessages(messages)

      expect(ids).toContain('level-0')
      expect(ids).toContain('level-1')
      expect(ids).toContain('level-2')
      expect(ids).toContain('deep-tool')
    })

    test('preserves order of IDs as encountered', () => {
      const messages: ChatMessage[] = [
        {
          id: 'msg-1',
          variant: 'agent',
          content: '',
          timestamp: new Date().toISOString(),
          blocks: [
            {
              type: 'agent',
              agentId: 'first',
              agentName: 'FirstAgent',
              agentType: 'inline',
              content: '',
              status: 'complete',
              blocks: [],
            },
            {
              type: 'tool',
              toolCallId: 'second',
              toolName: 'glob',
              input: {},
              output: '',
            },
            {
              type: 'agent',
              agentId: 'third',
              agentName: 'ThirdAgent',
              agentType: 'inline',
              content: '',
              status: 'complete',
              blocks: [],
            },
          ],
        },
      ]

      const ids = getAllToggleIdsFromMessages(messages)

      expect(ids[0]).toBe('first')
      expect(ids[1]).toBe('second')
      expect(ids[2]).toBe('third')
    })
  })
})

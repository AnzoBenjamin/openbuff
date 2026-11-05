import type { RunState } from '@openbuff/sdk'
import type { ChatMessage } from '../types/chat'

const PROMPT_TAG = 'OPENBUFF_UI_PROMPT:'

// An opaque, immutable reference avoids cloning an entire SDK transcript for
// undo. SDK continuation creates a fresh state; old references remain stable.
export class RunStateSnapshot {
  #state: RunState | null
  constructor(state: RunState | null) {
    this.#state = state
  }
  getState(): RunState | null {
    return this.#state
  }
}

export function stampRunPromptBoundary(
  runState: RunState,
  messageId: string,
): RunState {
  const session = runState.sessionState
  const agent = session?.mainAgentState
  if (!agent || !Array.isArray(agent.messageHistory)) return runState
  const index = agent.messageHistory.findLastIndex(
    (message) =>
      message?.role === 'user' &&
      Array.isArray(message.tags) &&
      message.tags.includes('USER_PROMPT'),
  )
  if (index < 0) return runState
  return {
    ...runState,
    sessionState: {
      ...session,
      mainAgentState: {
        ...agent,
        messageHistory: agent.messageHistory.map((message, current) =>
          current === index
            ? {
                ...message,
                tags: [
                  ...(message.tags ?? []).filter(
                    (tag) =>
                      typeof tag === 'string' && !tag.startsWith(PROMPT_TAG),
                  ),
                  PROMPT_TAG + messageId,
                ],
              }
            : message,
        ),
      },
    },
  }
}

export function forkConversationBeforeMessage(
  runState: RunState | null,
  messages: ChatMessage[],
  messageId: string,
) {
  const visibleIndex = messages.findIndex(
    (message) => message.id === messageId && message.variant === 'user',
  )
  const session = runState?.sessionState
  const agent = session?.mainAgentState
  const historyIndex = Array.isArray(agent?.messageHistory)
    ? agent.messageHistory.findIndex(
        (message) =>
          Array.isArray(message?.tags) &&
          message.tags.includes(PROMPT_TAG + messageId),
      )
    : -1
  if (!runState || !session || !agent || visibleIndex < 0 || historyIndex < 0) {
    return {
      status: 'unavailable' as const,
      reason:
        'The earlier conversation context is not retained. Start a new chat or copy this prompt as a follow-up.',
    }
  }
  return {
    status: 'ready' as const,
    messages: messages.slice(0, visibleIndex),
    runState: {
      ...runState,
      sessionState: {
        ...session,
        mainAgentState: {
          ...agent,
          messageHistory: agent.messageHistory.slice(0, historyIndex),
          output: undefined,
          agentContext: {},
          subagents: [],
          childRunIds: [],
          backgroundAgentJobs: [],
          taskMemory: undefined,
          base2ActiveWork: undefined,
          compactionArchive: [],
          contextConsolidations: [],
          contextArchiveHydration: 'in-memory-only' as const,
          memoryV2: undefined,
          memoryAuthority: undefined,
          memoryV2Context: undefined,
          playbookContext: undefined,
          memoryReuse: undefined,
          memoryUsageTurn: undefined,
          orchestrationLedger: undefined,
          workspacePathLeases: [],
          discoveryCoverage: undefined,
          workflowStates: undefined,
          unlockedToolTiers: undefined,
          lastSetOutputError: undefined,
          readAuthorizationsByPath: {},
          readAuthorizationHashesByPath: {},
          confirmedPostEditAnchorsByPath: {},
          editRereadRequirementsByPath: {},
        },
      },
    },
  }
}

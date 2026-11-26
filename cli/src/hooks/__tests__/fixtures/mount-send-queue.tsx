import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { spyOn } from 'bun:test'
import { enableMapSet } from 'immer'
import React from 'react'

import { routeUserPrompt } from '../../../commands/router'
import * as project from '../../../project-files'
import * as registries from '../../../services/deferred-registries'
import { useChatStore } from '../../../state/chat-store'
import * as clients from '../../../utils/codebuff-client'
import * as runConfigs from '../../../utils/create-run-config'
import * as agents from '../../../utils/local-agent-registry'
import * as providers from '../../../utils/openbuff-provider'
import * as journals from '../../../utils/run-journal-path'
import * as storage from '../../../utils/run-state-storage'
import * as snapshots from '../../../utils/turn-snapshots'
import { useChatStreaming } from '../../use-chat-streaming'
import { useSendMessage } from '../../use-send-message'

import type { CommandResult, RouterParams } from '../../../commands/command-registry'
import type { SendMessageFn } from '../../../types/contracts/send-message'
import type { AgentMode } from '../../../utils/constants'
import type { UseChatStreamingReturn } from '../../use-chat-streaming'
import type { RunState } from '@openbuff/sdk'

export type Client = NonNullable<Awaited<ReturnType<typeof clients.getCodebuffClient>>>
type Validate = Parameters<typeof useSendMessage>[0]['onBeforeMessageSend']
export const noop = () => {}
export const valid = { success: true, errors: [] }
export const completedRun: RunState = { output: { type: 'lastMessage', value: [] } }

export const completionOf = (result: CommandResult) =>
  result && 'status' in result && result.status === 'accepted' && result.disposition === 'started'
    ? result.completion : undefined

/** Mount the production send and queue hooks; stub only external dependencies. */
export async function mountRealSend(
  run: Client['run'],
  validate: Validate = async () => valid,
  projectRoot = process.cwd(),
) {
  const { testRender } = await import('@opentui/react/test-utils')
  enableMapSet()
  spyOn(registries, 'whenRegistriesReady').mockResolvedValue(undefined)
  const getClient = spyOn(clients, 'getCodebuffClient').mockResolvedValue({ run } as Client)
  spyOn(agents, 'loadAgentDefinitions').mockReturnValue([])
  spyOn(providers, 'getOpenbuffProviderReadiness').mockReturnValue({ ok: true })
  spyOn(project, 'getProjectRoot').mockReturnValue(projectRoot)
  spyOn(runConfigs, 'createRunConfig').mockImplementation(
    ({ signal, prompt, previousRunState, costMode, content }) =>
      ({ signal, prompt, previousRun: previousRunState, costMode, content }) as ReturnType<typeof runConfigs.createRunConfig>,
  )
  spyOn(journals, 'resolveRunJournalPath').mockReturnValue(':memory:')
  spyOn(journals, 'openRunJournalForRun').mockReturnValue(undefined)
  spyOn(storage, 'saveChatState').mockImplementation(noop)
  spyOn(storage, 'clearCheckpoint').mockResolvedValue(undefined)
  spyOn(snapshots, 'createTurnSnapshot').mockResolvedValue({ status: 'skipped', reason: 'fixture' })

  const chain = { current: false }
  const active = { current: 0 }
  const activeSubagents = { current: new Set<string>() }
  const abort = { current: null as AbortController | null }
  const input = { current: null }
  const sendRef = { current: undefined as SendMessageFn | undefined }
  let streaming!: UseChatStreamingReturn
  let sender!: ReturnType<typeof useSendMessage>
  function Host() {
    streaming = useChatStreaming({
      agentMode: 'DEFAULT', inputValue: '', setInputValue: noop,
      terminalWidth: 80, separatorWidth: 78, isChainInProgressRef: chain,
      activeAgentStreamsRef: active, sendMessageRef: sendRef,
    })
    sender = useSendMessage({
      inputRef: input, activeSubagentsRef: activeSubagents,
      isChainInProgressRef: chain, abortControllerRef: abort,
      setStreamStatus: streaming.setStreamStatus,
      setContextWindowUsage: noop, setCompactionNotice: noop,
      setCanProcessQueue: streaming.setCanProcessQueue,
      onBeforeMessageSend: validate, mainAgentTimer: streaming.mainAgentTimer,
      scrollToLatest: noop, isQueuePausedRef: streaming.isQueuePausedRef,
      pauseQueue: streaming.pauseQueue,
      continueChat: false,
    })
    sendRef.current = sender.sendMessage
    return <text>{streaming.queuePaused ? 'Queue paused' : 'Queue ready'}</text>
  }
  const client = new QueryClient()
  let setup!: Awaited<ReturnType<typeof testRender>>
  await React.act(async () => {
    setup = await testRender(
      <QueryClientProvider client={client}><Host /></QueryClientProvider>,
      { width: 80, height: 8 },
    )
  })
  const route = (inputValue: string, overrides: Partial<RouterParams> = {}) => {
    const store = useChatStore.getState()
    const params: RouterParams = {
      inputValue, agentMode: store.agentMode as AgentMode,
      isStreaming: streaming.isStreaming, isChainInProgressRef: chain,
      streamMessageIdRef: streaming.streamMessageIdRef,
      abortControllerRef: abort, inputRef: input, sendMessage: sender.sendMessage,
      setMessages: store.setMessages, setInputValue: store.setInputValue,
      restoreComposerDraft: store.setInputValue,
      addToQueue: streaming.addToQueue, clearMessages: sender.clearMessages,
      parkRejectedPrompt: streaming.parkRejectedPrompt,
      clearQueue: streaming.clearQueue, pauseQueue: streaming.pauseQueue,
      getPromptTurnState: streaming.getPromptTurnState,
      setCanProcessQueue: streaming.setCanProcessQueue,
      setInputFocused: noop, saveToHistory: noop, scrollToLatest: noop,
      stopStreaming: streaming.stopStreaming,
      ...overrides,
    }
    return routeUserPrompt(params)
  }
  return {
    chain, abort, getClient, route,
    send: (request: Parameters<SendMessageFn>[0]) => sender.sendMessage(request),
    get streaming() { return streaming },
    async destroy() {
      await React.act(async () => setup.renderer.destroy())
      client.clear()
    },
  }
}

import { expect, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { OpenbuffClient } from '../../../../sdk/src/client'
import { createStreamController } from '../../hooks/stream-state'
import { createMessageUpdater } from '../message-updater'
import { createEventHandler } from '../sdk-event-handlers'

import type { PrintModeEvent } from '@codebuff/common/types/print-mode'
import type { ChatMessage, TextContentBlock } from '../../types/chat'

const logger = { debug() {}, info() {}, warn() {}, error() {} }
const primaryBaseURL = 'https://n04-primary.invalid/v1'
const backupBaseURL = 'https://n04-backup.invalid/v1'
const apiKeyEnv = 'N04_OFFLINE_PROVIDER_KEY'
const fakeKey = 'n04-synthetic-credential-value'
const replyText = 'Reply from the offline backup.'

function backupResponse() {
  const sse = (delta: object, finishReason: string | null) =>
    `data: ${JSON.stringify({
      id: 'n04-backup-response',
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    })}\n\n`
  return new Response(
    sse({ role: 'assistant', content: replyText }, null) +
      sse({}, 'stop') +
      'data: [DONE]\n\n',
    { headers: { 'content-type': 'text/event-stream' } },
  )
}

function createTranscript() {
  const id = 'n04-ai-message'
  let messages: ChatMessage[] = [
    { id, variant: 'ai', content: '', blocks: [], timestamp: 'now' },
  ]
  const updater = createMessageUpdater(id, (update) => {
    messages = update(messages)
  })
  const handleEvent = createEventHandler({
    streaming: {
      streamRefs: createStreamController(),
      setStreamingAgents() {},
      setStreamStatus() {},
      setContextWindowUsage() {},
      setCompactionNotice() {},
    },
    message: {
      aiMessageId: id,
      updater,
      hasReceivedContentRef: { current: false },
    },
    subagents: { addActiveSubagent() {}, removeActiveSubagent() {} },
    mode: { agentMode: 'DEFAULT', setHasReceivedPlanResponse() {} },
    logger,
    setIsRetrying() {},
  })
  return {
    handleEvent,
    message: () => messages[0],
    statusBlocks: () =>
      (messages[0].blocks ?? []).filter(
        (block): block is TextContentBlock & { textType: 'status' } =>
          block.type === 'text' && block.textType === 'status',
      ),
  }
}

test.each([401, 403])(
  'N04: the SDK HTTP %i failover warning survives CLI recovery and finish without exposing the credential',
  async (statusCode) => {
    const root = mkdtempSync(join(tmpdir(), 'openbuff-n04-failover-'))
    const configPath = join(root, 'provider.json')
    const primaryURL = `${primaryBaseURL}/chat/completions`
    const backupURL = `${backupBaseURL}/chat/completions`
    const events: PrintModeEvent[] = []
    const requests: Array<{
      url: string
      method: string
      model: unknown
      correctAuthorization: boolean
    }> = []
    let streamedText = ''

    // Inject only HTTP transport. The real model adapter, failover loop and
    // SDK callbacks run against the HTTPS config without opening a socket.
    const transport = spyOn(globalThis, 'fetch').mockImplementation(
      Object.assign(
        async (input: RequestInfo | URL, init?: RequestInit) => {
          const request = new Request(input, init)
          if (request.url !== primaryURL && request.url !== backupURL) {
            throw new Error(`Unexpected N04 request: ${request.url}`)
          }
          const primary = request.url === primaryURL
          const { model } = (await request.json()) as { model?: unknown }
          requests.push({
            url: request.url,
            method: request.method,
            model,
            correctAuthorization:
              request.headers.get('authorization') ===
              (primary ? `Bearer ${fakeKey}` : null),
          })
          if (!primary) return backupResponse()
          // Even a provider that echoes the rejected value must not put it in
          // the failover warning.
          return Response.json(
            { error: { message: `Credential rejected: ${fakeKey}` } },
            { status: statusCode },
          )
        },
        {
          preconnect() {
            throw new Error('N04 does not allow preconnect')
          },
        },
      ),
    )
    try {
      writeFileSync(
        configPath,
        JSON.stringify({
          defaultModel: 'n04-primary/primary',
          failoverModels: ['n04-backup/backup'],
          providers: {
            'n04-primary': {
              type: 'openai-compatible',
              baseURL: primaryBaseURL,
              apiKeyEnv,
              models: ['primary'],
            },
            'n04-backup': {
              type: 'openai-compatible',
              baseURL: backupBaseURL,
              models: ['backup'],
            },
          },
        }),
      )
      const client = new OpenbuffClient({
        cwd: root,
        projectFiles: {},
        knowledgeFiles: {},
        userKnowledgeFiles: {},
        repositoryIntelligence: false,
        harnessStateDir: join(root, 'harness'),
        runTimeoutMs: 5_000,
        logger,
        hostConfiguration: {
          // The synthetic value exists only in this captured host environment.
          environment: { [apiKeyEnv]: fakeKey, OPENBUFF_TELEMETRY: '0' },
          platform: process.platform,
          invocationCwd: root,
          projectRoot: root,
          home: { kind: 'none' },
          globals: { kind: 'disabled' },
          selection: { kind: 'explicit', path: configPath, required: true },
          trust: { ancestorConfig: false, projectReadableRoots: false },
        },
        handleEvent(event) {
          events.push(event)
        },
        handleStreamChunk(chunk) {
          if (typeof chunk === 'string') streamedText += chunk
        },
      })
      const result = await client.run({
        agent: {
          id: 'n04-failover-probe',
          displayName: 'N04 failover probe',
          toolNames: [],
          systemPrompt: 'Reply without using tools.',
        },
        prompt: 'Return the offline fixture reply.',
      })

      expect(result.runOutcome).toMatchObject({ termination: 'completed' })
      expect(transport).toHaveBeenCalledTimes(2)
      expect(requests).toEqual([
        {
          url: primaryURL,
          method: 'POST',
          model: 'primary',
          correctAuthorization: true,
        },
        {
          url: backupURL,
          method: 'POST',
          model: 'backup',
          correctAuthorization: true,
        },
      ])
      expect(streamedText).toBe(replyText)
      const observed = events.filter(
        (event) => event.type === 'provider_status' || event.type === 'finish',
      )
      expect(
        observed.map((event) =>
          event.type === 'finish' ? 'finish' : event.status,
        ),
      ).toEqual(['failover', 'recovered', 'finish'])
      const [failover, recovered, finish] = observed
      expect(failover).toMatchObject({
        type: 'provider_status',
        status: 'failover',
        model: 'n04-primary/primary',
        nextModel: 'n04-backup/backup',
        statusCode,
        providerId: 'n04-primary',
        apiKeyEnv,
        degraded: true,
      })
      expect(JSON.stringify(observed)).not.toContain(fakeKey)

      const { handleEvent, message, statusBlocks } = createTranscript()
      handleEvent(failover)
      const warning = {
        type: 'text',
        textType: 'status',
        color: 'yellow',
        content: `Provider failover: n04-primary/primary (n04-primary) returned ${statusCode}; check ${apiKeyEnv}. Using n04-backup/backup for the rest of this session (/provider resets it).`,
      } as const
      expect(statusBlocks()).toEqual([warning])
      handleEvent(recovered)
      expect(statusBlocks()).toEqual([
        warning,
        {
          type: 'text',
          textType: 'status',
          color: 'muted',
          content: 'Provider connection recovered.',
        },
      ])
      handleEvent(finish)
      expect(message().runOutcome).toEqual(result.runOutcome)
      expect(
        statusBlocks().filter((block) => block.color === 'yellow'),
      ).toEqual([warning])
      expect(JSON.stringify(message())).not.toContain(fakeKey)
    } finally {
      transport.mockRestore()
      rmSync(root, { recursive: true, force: true })
    }
  },
  10_000,
)

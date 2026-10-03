import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'
import { createRequire } from 'node:module'

import { useChatStore } from '../../state/chat-store'

import type { RouterParams } from '../command-registry'

// bun's mock.module is registry-wide for the whole test process (afterAll
// mock.restore does not undo it), so capture the REAL modules before any
// mock.module registration and spread their exports in the factories below.
const requireReal = createRequire(import.meta.url)
const realChatGptOauth = requireReal(
  '@codebuff/common/constants/chatgpt-oauth',
) as typeof import('@codebuff/common/constants/chatgpt-oauth') & {
  default?: typeof import('@codebuff/common/constants/chatgpt-oauth')
}
// ESM/CJS interop: spread .default first, then the namespace, so real keys win.
const realChatGptOauthModule = {
  ...realChatGptOauth.default,
  ...realChatGptOauth,
}

// TSX component module: capture via the query-busted dynamic import so a
// previously leaked mock registration cannot shadow the real module.
const realBannerModule = (await import(
  '../../components/chatgpt-connect-banner?real' as string
)) as unknown as typeof import('../../components/chatgpt-connect-banner')

// Snapshot the namespace into a plain object so the factory spread and the
// afterAll re-registration restore the captured exports, not a live binding.
const realBannerSnapshot = { ...realBannerModule }

const saveToHistory = mock(() => {})
const setInputValue = mock(() => {})
const setMessages = mock(() => {})
const handleChatGptAuthCode = mock(async () => ({
  success: true,
  message: 'ok',
}))

// Inline snapshot+restore pattern: every real banner export keeps flowing
// (spread over the captured original, with the query-busted realBannerModule
// capture winning over any stale registration) and afterAll re-registers the
// original, so this registry-wide mock cannot drop the component module's
// real exports — including handleChatGptAuthCode — for later files sharing
// this test worker.
mock.module('../../components/chatgpt-connect-banner', () => ({
  // Real exports first so nothing the component module ships is dropped for
  // later files in this process; the override below must keep winning.
  ...realBannerSnapshot,
  handleChatGptAuthCode,
}))

// Inline snapshot+restore pattern: the constants mock overrides 13 exports
// unconditionally (CHATGPT_OAUTH_ENABLED, the model map,
// isChatGptOAuthModelAllowed, ...) and would otherwise reach every later
// importer in the worker — chatgpt-oauth.test.ts included — because bun
// does not isolate mock.module registrations across test files.
mock.module('@codebuff/common/constants/chatgpt-oauth', () => ({
  // Real constants first (registry-wide mock leak guard); the hardcoded
  // CHATGPT_OAUTH_ENABLED override below must keep winning.
  ...realChatGptOauthModule,
  CHATGPT_OAUTH_ENABLED: true,
  CHATGPT_OAUTH_CLIENT_ID: 'test-client-id',
  CHATGPT_OAUTH_AUTHORIZE_URL: 'https://auth.openai.com/oauth/authorize',
  CHATGPT_OAUTH_TOKEN_URL: 'https://auth.openai.com/oauth/token',
  CHATGPT_OAUTH_REDIRECT_URI: 'http://localhost:1455/auth/callback',
  CHATGPT_BACKEND_BASE_URL: 'https://chatgpt.com/backend-api',
  CHATGPT_OAUTH_TOKEN_ENV_VAR: 'CODEBUFF_CHATGPT_OAUTH_TOKEN',
  OPENBUFF_CHATGPT_OAUTH_TOKEN_ENV_VAR: 'OPENBUFF_CHATGPT_OAUTH_TOKEN',
  OPENROUTER_TO_OPENAI_MODEL_MAP: {},
  CHATGPT_OAUTH_OPENAI_MODEL_ALLOWLIST: [],
  isOpenAIProviderModel: (model: string) => model.startsWith('openai/'),
  isChatGptOAuthModelAllowed: () => false,
  toOpenAIModelId: (model: string) => model,
}))

describe('routeUserPrompt connect:chatgpt mode', () => {
  beforeEach(() => {
    useChatStore.getState().reset()
    useChatStore.getState().setInputMode('connect:chatgpt')
    saveToHistory.mockClear()
    setInputValue.mockClear()
    setMessages.mockClear()
    handleChatGptAuthCode.mockClear()
  })

  afterEach(() => {
    useChatStore.getState().reset()
  })

  afterAll(() => {
    // Re-register the real banner + chatgpt-oauth constants modules so the
    // registry-wide mocks above cannot leak into other test files in this
    // worker. The dynamic import of '../router' happens inside each test,
    // strictly after these mocks are registered and before this restore.
    mock.module(
      '../../components/chatgpt-connect-banner',
      () => ({ ...realBannerSnapshot }),
    )
    mock.module(
      '@codebuff/common/constants/chatgpt-oauth',
      () => ({ ...realChatGptOauthModule }),
    )
  })

  test('when in connect:chatgpt mode, it exchanges the auth code and updates messages', async () => {
    const { routeUserPrompt } = await import('../router')

    const params = {
      abortControllerRef: { current: null },
      agentMode: 'DEFAULT',
      inputRef: { current: null },
      inputValue: 'auth-code-123',
      isChainInProgressRef: { current: false },
      isStreaming: false,
      streamMessageIdRef: { current: null },
      addToQueue: () => {},
      clearMessages: () => {},
      saveToHistory,
      scrollToLatest: () => {},
      sendMessage: async () => {},
      setCanProcessQueue: () => {},
      setInputFocused: () => {},
      setInputValue,
      setMessages,
      stopStreaming: () => {},
    } satisfies RouterParams

    await routeUserPrompt(params)

    expect(handleChatGptAuthCode).toHaveBeenCalledWith('auth-code-123')
    expect(setMessages).toHaveBeenCalled()
    expect(useChatStore.getState().inputMode).toBe('default')
  })
})

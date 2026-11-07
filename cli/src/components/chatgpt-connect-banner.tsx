import React, { useEffect, useRef, useState } from 'react'
import { useKeyboard } from '@opentui/react'

import { loadProviderConfigSync } from '@openbuff/sdk'

import { MultilineInput } from './multiline-input'
import { createTextPasteHandler } from '../utils/strings'
import { safeOpen } from '../utils/open-url'

import { Button } from './button'
import { useTheme } from '../hooks/use-theme'
import { useChatStore } from '../state/chat-store'
import {
  connectChatGptOAuth,
  disconnectChatGptOAuth,
  exchangeChatGptCodeForTokens,
  getChatGptOAuthStatus,
  stopChatGptOAuthServer,
} from '../utils/chatgpt-oauth'
import { setupOpenbuffProviderFromArgs } from '../utils/openbuff-provider'
import { BORDER_CHARS } from '../utils/ui-constants'

import type { KeyEvent } from '@opentui/core'

type FlowState =
  | 'checking'
  | 'not-connected'
  | 'waiting-for-code'
  | 'connected'
  | 'error'

type AutoConfigState = 'idle' | 'prompt' | 'done'

export const ChatGptConnectBanner = ({
  dependencies = {
    connect: connectChatGptOAuth,
    exchange: exchangeChatGptCodeForTokens,
    status: getChatGptOAuthStatus,
    stop: stopChatGptOAuthServer,
    open: safeOpen,
  },
}: {
  dependencies?: {
    connect: typeof connectChatGptOAuth
    exchange: typeof exchangeChatGptCodeForTokens
    status: typeof getChatGptOAuthStatus
    stop: typeof stopChatGptOAuthServer
    open: typeof safeOpen
    hasCodexProvider?: () => boolean
  }
} = {}) => {
  const theme = useTheme()
  const setInputMode = useChatStore((state) => state.setInputMode)
  const flowRevision = useRef(0)
  const mounted = useRef(true)
  const [callback, setCallback] = useState('')
  const [callbackCursor, setCallbackCursor] = useState(0)
  const [exchanging, setExchanging] = useState(false)
  const exchangeOwner = useRef<symbol | null>(null)
  const [browserOpened, setBrowserOpened] = useState<boolean | null>(null)
  const [flowState, setFlowState] = useState<FlowState>('checking')
  const [error, setError] = useState<string | null>(null)
  const [authUrl, setAuthUrl] = useState<string | null>(null)
  const [isCloseHovered, setIsCloseHovered] = useState(false)
  const [isAutoConfigHovered, setIsAutoConfigHovered] = useState(false)
  const [isDisconnectHovered, setIsDisconnectHovered] = useState(false)
  const [isConnectHovered, setIsConnectHovered] = useState(false)
  const [isRetryHovered, setIsRetryHovered] = useState(false)
  const [autoConfigState, setAutoConfigState] =
    useState<AutoConfigState>('idle')
  const [autoConfigError, setAutoConfigError] = useState<string | null>(null)

  function maybePromptAutoConfig(): void {
    try {
      const hasCodexProvider = dependencies.hasCodexProvider
        ? dependencies.hasCodexProvider()
        : loadProviderConfigSync().config.providers?.codex != null
      if (!hasCodexProvider) {
        setAutoConfigState('prompt')
      }
    } catch {
      // If config can't be read, quietly skip the prompt; the user can still run /setup codex
    }
  }

  const handleConnect = () => {
    const revision = ++flowRevision.current
    exchangeOwner.current = null
    setExchanging(false)
    setFlowState('waiting-for-code')
    setError(null)
    setCallback('')
    setCallbackCursor(0)
    setAutoConfigState('idle')
    setAutoConfigError(null)
    setBrowserOpened(null)
    const result = dependencies.connect()
    setAuthUrl(result.authUrl)
    void result.browserOpened.then((opened) => {
      if (mounted.current && revision === flowRevision.current)
        setBrowserOpened(opened)
    })
    void result.credentials
      .then(() => {
        if (!mounted.current || revision !== flowRevision.current) return
        setFlowState('connected')
        maybePromptAutoConfig()
      })
      .catch((err) => {
        if (!mounted.current || revision !== flowRevision.current) return
        setError(err instanceof Error ? err.message : 'Failed to connect')
        setFlowState('error')
      })
  }

  useEffect(() => {
    mounted.current = true
    if (!dependencies.status().connected) handleConnect()
    else {
      setFlowState('connected')
      maybePromptAutoConfig()
    }
    return () => {
      mounted.current = false
      flowRevision.current++
      dependencies.stop()
    }
  }, [])

  const handleCallback = async (submittedValue = callback) => {
    if (!submittedValue.trim() || exchangeOwner.current) return
    const owner = Symbol('callback-exchange')
    exchangeOwner.current = owner
    const revision = flowRevision.current
    setExchanging(true)
    setError(null)
    const value = submittedValue
    setCallback('')
    setCallbackCursor(0)
    try {
      await dependencies.exchange(value, undefined, {
        isAbandoned: () =>
          !mounted.current || revision !== flowRevision.current,
      })
      if (!mounted.current || revision !== flowRevision.current) return
      // Ignore the loopback promise rejection caused by disposing its server.
      flowRevision.current++
      dependencies.stop()
      setFlowState('connected')
      maybePromptAutoConfig()
    } catch (err) {
      if (mounted.current && revision === flowRevision.current)
        setError(
          err instanceof Error ? err.message : 'Callback exchange failed',
        )
    } finally {
      if (exchangeOwner.current === owner) {
        exchangeOwner.current = null
        if (mounted.current) setExchanging(false)
      }
    }
  }

  const handleDisconnect = () => {
    exchangeOwner.current = null
    setExchanging(false)
    disconnectChatGptOAuth()
    setFlowState('not-connected')
    setAutoConfigState('idle')
    setAutoConfigError(null)
  }

  const handleAutoConfigure = () => {
    try {
      setupOpenbuffProviderFromArgs('codex')
      setAutoConfigError(null)
      setAutoConfigState('done')
    } catch (err) {
      setAutoConfigError(
        err instanceof Error ? err.message : 'Failed to auto-configure',
      )
      // Keep the button visible so the user can retry
    }
  }

  useKeyboard((key: KeyEvent) => {
    if (key.name === 'escape') {
      key.preventDefault()
      handleClose()
      return
    }
    if (key.name === 'd' && flowState === 'connected') {
      key.preventDefault()
      handleDisconnect()
      return
    }
    if (key.name !== 'return' && key.name !== 'enter') return
    key.preventDefault()
    if (flowState === 'error' || flowState === 'not-connected') {
      handleConnect()
    } else if (flowState === 'connected' && autoConfigState === 'prompt') {
      handleAutoConfigure()
    }
  })

  const panelStyle = {
    width: '100%' as const,
    borderStyle: 'single' as const,
    borderColor: theme.border,
    customBorderChars: BORDER_CHARS,
    paddingLeft: 1,
    paddingRight: 1,
  }

  const actionButtonStyle = {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    paddingLeft: 1,
    paddingRight: 1,
    borderStyle: 'single' as const,
    borderColor: theme.border,
    customBorderChars: BORDER_CHARS,
  }

  const handleClose = () => {
    flowRevision.current++
    dependencies.stop()
    setInputMode('default')
  }

  const closeButton = (
    <Button
      onClick={handleClose}
      onMouseOver={() => setIsCloseHovered(true)}
      onMouseOut={() => setIsCloseHovered(false)}
    >
      <text style={{ fg: isCloseHovered ? theme.error : theme.muted }}>x</text>
    </Button>
  )

  if (flowState === 'connected') {
    const showAutoConfig = autoConfigState === 'prompt'
    const showAutoConfigError =
      autoConfigState === 'prompt' && autoConfigError != null
    const statusText =
      autoConfigState === 'done'
        ? '✓ ChatGPT connected · Codex provider added'
        : showAutoConfigError
          ? `✓ ChatGPT connected · ${autoConfigError}`
          : showAutoConfig
            ? '✓ ChatGPT connected · Route requests through Codex?'
            : '✓ ChatGPT connected'

    return (
      <box
        style={{
          ...panelStyle,
          flexDirection: 'row',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <text style={{ fg: theme.foreground }}>{statusText}</text>
        <box style={{ flexDirection: 'row', gap: 1, alignItems: 'center' }}>
          {showAutoConfig && (
            <Button
              style={{
                ...actionButtonStyle,
                borderColor: isAutoConfigHovered
                  ? theme.foreground
                  : theme.border,
              }}
              onClick={handleAutoConfigure}
              onMouseOver={() => setIsAutoConfigHovered(true)}
              onMouseOut={() => setIsAutoConfigHovered(false)}
            >
              <text wrapMode="none">
                <span fg={theme.success}>Use Codex preset</span>
              </text>
            </Button>
          )}
          <Button
            style={{
              ...actionButtonStyle,
              borderColor: isDisconnectHovered
                ? theme.foreground
                : theme.border,
            }}
            onClick={handleDisconnect}
            onMouseOver={() => setIsDisconnectHovered(true)}
            onMouseOut={() => setIsDisconnectHovered(false)}
          >
            <text wrapMode="none">
              <span fg={theme.muted}>Disconnect</span>
            </text>
          </Button>
          {closeButton}
        </box>
      </box>
    )
  }

  if (flowState === 'error') {
    return (
      <box
        style={{
          ...panelStyle,
          flexDirection: 'row',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <text style={{ fg: theme.error, flexShrink: 1 }}>
          {error ?? 'Unknown error'}
        </text>
        <box style={{ flexDirection: 'row', gap: 1, alignItems: 'center' }}>
          <Button
            style={{
              ...actionButtonStyle,
              borderColor: isRetryHovered ? theme.foreground : theme.border,
            }}
            onClick={handleConnect}
            onMouseOver={() => setIsRetryHovered(true)}
            onMouseOut={() => setIsRetryHovered(false)}
          >
            <text wrapMode="none">
              <span fg={theme.foreground}>Retry</span>
            </text>
          </Button>
          {closeButton}
        </box>
      </box>
    )
  }

  if (flowState === 'waiting-for-code') {
    return (
      <box style={{ ...panelStyle, flexDirection: 'column' }}>
        <box
          style={{
            flexDirection: 'row',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <text style={{ fg: theme.foreground }}>Connecting to ChatGPT...</text>
          {closeButton}
        </box>
        <text style={{ fg: theme.muted }}>
          {browserOpened === false
            ? 'Browser could not open. Open the URL below on your browser.'
            : 'Sign in via your browser. Remote terminal: paste the callback URL below.'}
        </text>
        {authUrl ? <text style={{ fg: theme.muted }}>{authUrl}</text> : null}
        {error && <text fg={theme.error}>{error}</text>}
        <MultilineInput
          value={callback}
          onChange={({ text, cursorPosition }) => {
            setCallback(text)
            setCallbackCursor(cursorPosition)
          }}
          onSubmit={(input) => void handleCallback(input?.text)}
          onPaste={createTextPasteHandler(
            callback,
            callbackCursor,
            ({ text, cursorPosition }) => {
              setCallback(text)
              setCallbackCursor(cursorPosition)
            },
          )}
          placeholder={
            exchanging
              ? 'Exchanging callback…'
              : 'Paste callback URL or authorization code'
          }
          focused={!exchanging}
          cursorPosition={callbackCursor}
          minHeight={1}
          maxHeight={2}
          onKeyIntercept={(key) => {
            if (key.name === 'escape') {
              handleClose()
              return true
            }
            return false
          }}
        />
        <box style={{ flexDirection: 'row' }}>
          <Button onClick={() => void handleCallback()}>
            <text fg={theme.primary}>Submit callback</text>
          </Button>
          <Button
            onClick={() => {
              if (authUrl)
                void dependencies.open(authUrl).then(setBrowserOpened)
            }}
          >
            <text fg={theme.primary}>Open browser again</text>
          </Button>
          <Button onClick={handleClose}>
            <text fg={theme.muted}>Cancel (Esc)</text>
          </Button>
        </box>
      </box>
    )
  }

  if (flowState === 'not-connected') {
    return (
      <box
        style={{
          ...panelStyle,
          flexDirection: 'row',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <Button
          style={{
            ...actionButtonStyle,
            borderColor: isConnectHovered ? theme.foreground : theme.border,
          }}
          onClick={handleConnect}
          onMouseOver={() => setIsConnectHovered(true)}
          onMouseOut={() => setIsConnectHovered(false)}
        >
          <text wrapMode="none">
            <span fg={theme.link}>Connect to ChatGPT</span>
          </text>
        </Button>
        {closeButton}
      </box>
    )
  }

  return null
}

export async function handleChatGptAuthCode(code: string): Promise<{
  success: boolean
  message: string
}> {
  try {
    await exchangeChatGptCodeForTokens(code)
    stopChatGptOAuthServer()
    return {
      success: true,
      message: `Successfully connected your ChatGPT subscription! If needed, run /setup codex to route requests through Codex, or click Use Codex preset if the banner is still open.`,
    }
  } catch (err) {
    return {
      success: false,
      message:
        err instanceof Error
          ? err.message
          : 'Failed to exchange ChatGPT authorization code',
    }
  }
}

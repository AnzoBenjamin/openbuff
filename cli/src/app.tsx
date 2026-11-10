import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'

import { Chat } from './chat'
import { ChatHistoryScreen } from './components/chat-history-screen'
import { ProjectPickerScreen } from './components/project-picker-screen'
import { TerminalLink } from './components/terminal-link'
import { useTerminalFocus } from './hooks/use-terminal-focus'
import { useTheme } from './hooks/use-theme'
import { getProjectRoot, startNewChat } from './project-files'
import { useOutputReaderStore } from './state/output-reader-store'
import { useChatHistoryStore } from './state/chat-history-store'
import { useChatStore } from './state/chat-store'
import type { TopBannerType } from './types/store'
import { findGitRoot } from './utils/git'
import { createLaunchIntent, type LaunchIntent } from './utils/launch-intent'
import { openFileAtPath } from './utils/open-file'
import { formatCwd } from './utils/path-helpers'
import { consumeCapturedEarlyInput } from './utils/early-input-capture'

import type { MultilineInputHandle } from './components/multiline-input'
import type { AgentMode } from './utils/constants'
import type { AuthStatus } from './utils/status-indicator-state'
import type { FileTreeNode } from '@codebuff/common/util/file'

interface AppProps {
  initialPrompt: string | null
  agentId?: string
  fileTree: FileTreeNode[]
  fileInventoryState?: 'loading' | 'loaded' | 'unavailable'
  continueChat: boolean
  continueChatId?: string
  initialMode?: AgentMode
  showProjectPicker: boolean
  onProjectChange: (projectPath: string) => void | Promise<void>
  launchIntent?: LaunchIntent
  projectSwitchError?: string
  switchingProject?: boolean
}

export const App = ({
  initialPrompt,
  agentId,
  fileTree,
  fileInventoryState,
  continueChat,
  continueChatId,
  initialMode,
  showProjectPicker,
  onProjectChange,
  launchIntent,
  projectSwitchError,
  switchingProject,
}: AppProps) => {
  const [projectLaunchQuery, setProjectLaunchQuery] = useState(() =>
    showProjectPicker ? (consumeCapturedEarlyInput() ?? '') : '',
  )
  useEffect(() => {
    if (!showProjectPicker && projectLaunchQuery) setProjectLaunchQuery('')
  }, [showProjectPicker, projectLaunchQuery])
  const fallbackIntent = useRef<LaunchIntent | null>(null)
  if (!fallbackIntent.current)
    fallbackIntent.current = createLaunchIntent(
      initialPrompt,
      continueChat,
      continueChatId,
    )
  const intent = launchIntent ?? fallbackIntent.current
  const [continuation, setContinuation] = useState(intent.peekContinuation)
  useEffect(() => {
    if (!showProjectPicker) intent.consumeContinuation()
  }, [intent, showProjectPicker])
  const theme = useTheme()

  const inputRef = useRef<MultilineInputHandle | null>(null)
  const {
    setInputFocused,
    setIsFocusSupported,
    resetChatStore,
    activeTopBanner,
    setActiveTopBanner,
    closeTopBanner,
  } = useChatStore(
    useShallow((store) => ({
      setInputFocused: store.setInputFocused,
      setIsFocusSupported: store.setIsFocusSupported,
      resetChatStore: store.reset,
      activeTopBanner: store.activeTopBanner,
      setActiveTopBanner: store.setActiveTopBanner,
      closeTopBanner: store.closeTopBanner,
    })),
  )

  // Wrap in useCallback to prevent re-subscribing on every render
  const handleSupportDetected = useCallback(() => {
    setIsFocusSupported(true)
  }, [setIsFocusSupported])

  // Enable terminal focus detection to stop cursor blinking when window loses focus
  // Cursor starts visible but not blinking; blinking enabled once terminal support confirmed
  useTerminalFocus({
    onFocusChange: setInputFocused,
    onSupportDetected: handleSupportDetected,
  })

  const projectRoot = getProjectRoot()
  const gitRoot = useMemo(
    () => findGitRoot({ cwd: projectRoot }),
    [projectRoot],
  )
  const showGitRootBanner = Boolean(gitRoot && gitRoot !== projectRoot)
  const [gitRootBannerDismissed, setGitRootBannerDismissed] = useState(false)
  const prevTopBannerRef = useRef<TopBannerType | null>(null)

  useEffect(() => {
    setGitRootBannerDismissed(false)
  }, [projectRoot])

  useEffect(() => {
    const prevBanner = prevTopBannerRef.current
    if (
      prevBanner === 'gitRoot' &&
      activeTopBanner === null &&
      showGitRootBanner
    ) {
      setGitRootBannerDismissed(true)
    }
    prevTopBannerRef.current = activeTopBanner
  }, [activeTopBanner, showGitRootBanner])

  useEffect(() => {
    if (!showGitRootBanner) {
      if (activeTopBanner === 'gitRoot') {
        closeTopBanner()
      }
      return
    }
    if (!gitRootBannerDismissed && activeTopBanner === null) {
      setActiveTopBanner('gitRoot')
    }
  }, [
    activeTopBanner,
    closeTopBanner,
    gitRootBannerDismissed,
    setActiveTopBanner,
    showGitRootBanner,
  ])

  const handleSwitchToGitRoot = useCallback(() => {
    if (gitRoot) {
      onProjectChange(gitRoot)
    }
  }, [gitRoot, onProjectChange])

  // Chat history state from store
  const { showChatHistory, closeChatHistory } = useChatHistoryStore()

  // State to track which chat to resume (set when user selects from history)
  const [resumeChatId, setResumeChatId] = useState<string | null>(null)

  const handleResumeChat = useCallback(
    (chatId: string) => {
      intent.discard()
      setContinuation({ enabled: false, id: undefined })
      closeChatHistory()
      // Reset chat store to clear previous messages before loading the selected chat
      resetChatStore()
      setResumeChatId(chatId)
    },
    [closeChatHistory, resetChatStore, intent],
  )

  const handleNewChat = useCallback(() => {
    intent.discard()
    setContinuation({ enabled: false, id: undefined })
    closeChatHistory()
    startNewChat()
    useOutputReaderStore.getState().close()
    resetChatStore()
    setResumeChatId(null)
  }, [closeChatHistory, resetChatStore, intent])

  // Determine effective continueChat values
  const effectiveContinueChat = continuation.enabled || resumeChatId !== null
  const effectiveContinueChatId = resumeChatId ?? continuation.id

  const headerContent = useMemo(() => {
    const displayPath = formatCwd(projectRoot)

    return (
      <box
        style={{
          flexDirection: 'column',
          gap: 0,
          paddingLeft: 1,
          paddingRight: 1,
          marginTop: 1,
          marginBottom: 1,
        }}
      >
        <text fg={theme.foreground}>
          <b>Openbuff</b>
        </text>
        <text style={{ wrapMode: 'word', fg: theme.muted }}>
          Project{' '}
          <TerminalLink
            text={displayPath}
            color={theme.muted}
            inline={true}
            underlineOnHover={true}
            onActivate={() => openFileAtPath(projectRoot)}
          />
        </text>
      </box>
    )
  }, [projectRoot, theme])

  // Auth status is always 'ok' in local/BYOK mode — no cloud backend to query
  const authStatus: AuthStatus = 'ok'

  // Render project picker FIRST when at home directory or outside a project
  if (showProjectPicker) {
    return (
      <ProjectPickerScreen
        onSelectProject={onProjectChange}
        initialPath={projectRoot}
        initialQuery={projectLaunchQuery}
        error={projectSwitchError}
        busy={switchingProject}
      />
    )
  }

  // Use key to force remount when resuming a different chat from history
  const chatKey = resumeChatId ?? 'current'

  return (
    <AuthedSurface
      chatKey={chatKey}
      headerContent={headerContent}
      initialPrompt={intent.peekPrompt()}
      claimInitialPrompt={intent.claimPrompt}
      agentId={agentId}
      fileTree={fileTree}
      fileInventoryState={fileInventoryState}
      inputRef={inputRef}
      continueChat={effectiveContinueChat}
      continueChatId={effectiveContinueChatId}
      authStatus={authStatus}
      initialMode={initialMode}
      gitRoot={gitRoot}
      onSwitchToGitRoot={handleSwitchToGitRoot}
      showChatHistory={showChatHistory}
      onSelectChat={handleResumeChat}
      onCancelChatHistory={closeChatHistory}
      onNewChat={handleNewChat}
    />
  )
}

interface AuthedSurfaceProps {
  chatKey: string
  headerContent: React.ReactNode
  initialPrompt: string | null
  claimInitialPrompt?: (prompt: string) => boolean
  agentId?: string
  fileTree: FileTreeNode[]
  fileInventoryState?: 'loading' | 'loaded' | 'unavailable'
  inputRef: React.MutableRefObject<MultilineInputHandle | null>
  continueChat: boolean
  continueChatId: string | undefined
  authStatus: AuthStatus
  initialMode: AgentMode | undefined
  gitRoot: string | null | undefined
  onSwitchToGitRoot: () => void
  showChatHistory: boolean
  onSelectChat: (chatId: string) => void
  onCancelChatHistory: () => void
  onNewChat: () => void
}

const AuthedSurface = ({
  chatKey,
  headerContent,
  initialPrompt,
  claimInitialPrompt,
  agentId,
  fileTree,
  fileInventoryState,
  inputRef,
  continueChat,
  continueChatId,
  authStatus,
  initialMode,
  gitRoot,
  onSwitchToGitRoot,
  showChatHistory,
  onSelectChat,
  onCancelChatHistory,
  onNewChat,
}: AuthedSurfaceProps) => {
  // Chat history renders inside AuthedSurface
  if (showChatHistory) {
    return (
      <ChatHistoryScreen
        onSelectChat={onSelectChat}
        onCancel={onCancelChatHistory}
        onNewChat={onNewChat}
      />
    )
  }

  return (
    <Chat
      key={chatKey}
      headerContent={headerContent}
      initialPrompt={initialPrompt}
      claimInitialPrompt={claimInitialPrompt}
      agentId={agentId}
      fileTree={fileTree}
      fileInventoryState={fileInventoryState}
      inputRef={inputRef}
      continueChat={continueChat}
      continueChatId={continueChatId}
      authStatus={authStatus}
      initialMode={initialMode}
      gitRoot={gitRoot}
      onSwitchToGitRoot={onSwitchToGitRoot}
    />
  )
}

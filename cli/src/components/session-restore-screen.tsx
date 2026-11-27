import { useKeyboard } from '@opentui/react'
import { Button } from './button'
import { useTheme } from '../hooks/use-theme'
import type { SessionRestoreState } from '../state/chat-store'

/** Selected history failure is a blocking state, not permission to create a fresh conversation. */
export function SessionRestoreScreen({
  state,
  onRetry,
  onCancel,
}: {
  state: SessionRestoreState
  onRetry: () => void
  onCancel: () => void
}) {
  const theme = useTheme()
  useKeyboard((key) => {
    if (key.defaultPrevented) return
    if (key.name === 'escape') {
      key.preventDefault()
      onCancel()
    } else if (
      state.status === 'error' &&
      key.name === 'r' &&
      !key.ctrl &&
      !key.meta
    ) {
      key.preventDefault()
      onRetry()
    }
  })
  return (
    <box flexDirection="column" padding={2} gap={1}>
      <text fg={theme.foreground}>
        {state.status === 'loading'
          ? 'Restoring saved session…'
          : 'Could not restore the selected session'}
      </text>
      <text fg={theme.muted}>
        {state.chatId ?? 'Most recent saved session'}
      </text>
      {state.status === 'error' && (
        <text fg={theme.foreground}>{state.message}</text>
      )}
      <text fg={theme.muted}>
        Your draft and queued prompts are preserved. No new run starts until
        this selection is resolved.
      </text>
      <box flexDirection="row" gap={2}>
        {state.status === 'error' && (
          <Button onClick={onRetry}>
            <text fg={theme.foreground}>Retry · R</text>
          </Button>
        )}
        <Button onClick={onCancel}>
          <text fg={theme.foreground}>Cancel · Esc</text>
        </Button>
      </box>
    </box>
  )
}

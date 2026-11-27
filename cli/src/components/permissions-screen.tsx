import { useKeyboard } from '@opentui/react'
import { TextAttributes } from '@opentui/core'
import { loadProviderConfigSync } from '@openbuff/sdk'
import { useCallback, useLayoutEffect, useRef, useState } from 'react'

import { Button } from './button'
import { handlePermissionsCommand } from '../commands/permissions'
import { useTerminalLayout } from '../hooks/use-terminal-layout'
import { useTheme } from '../hooks/use-theme'
import { getAttachTarget } from '../utils/codebuff-client'
import {
  COMMAND_APPROVAL_DESCRIPTIONS,
  COMMAND_APPROVAL_MODES,
  getCommandApprovalOverride,
} from '../utils/command-approvals'
import { isPlainEnterKey } from '../utils/terminal-enter-detection'

import type { HarnessApprovalMode } from '@openbuff/sdk'
import type { BoxRenderable } from '@opentui/core'

interface PermissionSettings {
  attached: boolean
  configuredMode?: HarnessApprovalMode
  override?: HarnessApprovalMode
}

function readPermissionSettings(): PermissionSettings {
  const attached = Boolean(getAttachTarget())
  return {
    attached,
    ...(attached
      ? {}
      : {
          configuredMode: loadProviderConfigSync().config.approvalMode,
          override: getCommandApprovalOverride(),
        }),
  }
}

interface PermissionsScreenProps {
  onClose: () => void
  onApplied: (message: string) => void
  loadSettings?: () => PermissionSettings
  applySetting?: (value: string) => string
}

export function PermissionsScreen({
  onClose,
  onApplied,
  loadSettings = readPermissionSettings,
  applySetting = handlePermissionsCommand,
}: PermissionsScreenProps) {
  const theme = useTheme()
  const { terminalHeight } = useTerminalLayout()
  const [loaded, setLoaded] = useState(() => {
    try {
      return { settings: loadSettings(), error: '' }
    } catch (error) {
      return {
        settings: undefined,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  })
  const settings = loaded.settings
  const configuredMode = settings?.configuredMode ?? 'balanced'
  const currentMode = settings?.override ?? configuredMode
  const [selected, setSelected] = useState(() =>
    settings?.override ? COMMAND_APPROVAL_MODES.indexOf(settings.override) : 3,
  )
  const selectedRef = useRef(selected)
  const choiceRefs = useRef<Array<BoxRenderable | null>>([])
  const applied = useRef(false)
  const select = useCallback((index: number) => {
    selectedRef.current = Math.max(0, Math.min(3, index))
    setSelected(selectedRef.current)
    const node = choiceRefs.current[selectedRef.current]
    if (node && !node.focused) node.focus()
  }, [])
  const [applyError, setApplyError] = useState('')
  const canApply = settings !== undefined && !settings.attached
  useLayoutEffect(() => {
    choiceRefs.current[selectedRef.current]?.focus()
  }, [canApply])
  const apply = useCallback(() => {
    if (!canApply || applied.current) return
    applied.current = true
    try {
      const result = applySetting(
        COMMAND_APPROVAL_MODES[selectedRef.current] ?? 'reset',
      )
      onApplied(result)
    } catch (error) {
      applied.current = false
      setApplyError(error instanceof Error ? error.message : String(error))
    }
  }, [applySetting, canApply, onApplied])
  const retry = useCallback(() => {
    try {
      const next = loadSettings()
      setLoaded({ settings: next, error: '' })
      select(next.override ? COMMAND_APPROVAL_MODES.indexOf(next.override) : 3)
    } catch (error) {
      setLoaded({
        settings: undefined,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }, [loadSettings, select])

  useKeyboard((key) => {
    if (key.defaultPrevented) return
    if (key.name === 'escape' || (key.ctrl && key.name === 'c')) {
      key.preventDefault()
      onClose()
    } else if (loaded.error && key.name === 'r') {
      key.preventDefault()
      retry()
    } else if (canApply) {
      if (key.name === 'up' || key.name === 'down' || key.name === 'tab') {
        key.preventDefault()
        const direction = key.name === 'up' || key.shift ? -1 : 1
        select((selectedRef.current + direction + 4) % 4)
      } else if (isPlainEnterKey(key)) {
        key.preventDefault()
        apply()
      }
    }
  })

  const choices = [
    ...COMMAND_APPROVAL_MODES.map((value) => ({
      label:
        value === 'allow-all'
          ? 'Allow all'
          : value === 'strict'
            ? 'Strict'
            : 'Balanced',
      description: COMMAND_APPROVAL_DESCRIPTIONS[value],
    })),
    {
      label: `Use configuration · ${configuredMode}`,
      description: 'Follow openbuff.json and clear the session override.',
    },
  ]

  return (
    <box
      style={{
        width: '100%',
        height: '100%',
        flexDirection: 'column',
        paddingLeft: 2,
        paddingRight: 2,
        paddingTop: terminalHeight >= 24 ? 1 : 0,
        backgroundColor: theme.background,
      }}
    >
      <text
        fg={theme.primary}
        attributes={TextAttributes.BOLD}
        style={{ flexShrink: 0 }}
      >
        Permissions
      </text>
      <text fg={theme.foreground} style={{ flexShrink: 0, marginBottom: 1 }}>
        {settings?.attached
          ? 'Command approvals are managed by the attached server.'
          : settings
            ? `For next run: ${currentMode} · ${settings.override ? 'this session' : settings.configuredMode ? 'configuration' : 'default'}`
            : 'Permission settings unavailable'}
      </text>
      <scrollbox style={{ flexGrow: 1, flexShrink: 1 }} scrollX={false}>
        {loaded.error ? (
          <box style={{ flexDirection: 'column', gap: 1 }}>
            <text fg={theme.error} wrapMode="word">
              {loaded.error}
            </text>
            <Button onClick={retry}>
              <text fg={theme.primary}>Retry (R)</text>
            </Button>
          </box>
        ) : settings?.attached ? (
          <text fg={theme.muted} wrapMode="word">
            Set --approval-mode when starting openbuff serve.
          </text>
        ) : (
          <box
            style={{
              flexDirection: 'column',
              gap: terminalHeight >= 24 ? 1 : 0,
            }}
          >
            {choices.map((choice, index) => (
              <Button
                key={index}
                ref={(node) => {
                  choiceRefs.current[index] = node
                }}
                onClick={() => select(index)}
                onFocused={() => select(index)}
                onKeyDown={(key) => {
                  if (isPlainEnterKey(key)) {
                    key.preventDefault()
                    select(index)
                    apply()
                  }
                }}
                style={{ flexDirection: 'column', flexShrink: 0 }}
              >
                <text
                  fg={selected === index ? theme.primary : theme.foreground}
                >
                  {`${selected === index ? '›' : ' '} ${choice.label}`}
                </text>
                {(selected === index || terminalHeight >= 24) && (
                  <text
                    fg={theme.muted}
                    wrapMode="word"
                  >{`  ${choice.description}`}</text>
                )}
              </Button>
            ))}
          </box>
        )}
      </scrollbox>
      {applyError && (
        <text fg={theme.error} style={{ flexShrink: 0 }}>
          {applyError}
        </text>
      )}
      {canApply && (
        <text
          fg={theme.muted}
          wrapMode="word"
          style={{ flexShrink: 0, marginTop: 1 }}
        >
          Changes apply to the next run. Pending approvals keep their current
          policy.
        </text>
      )}
      <box
        style={{ flexDirection: 'row', gap: 3, flexShrink: 0, marginTop: 1 }}
      >
        {canApply && (
          <Button onClick={apply}>
            <text fg={theme.primary}>Apply (Enter)</text>
          </Button>
        )}
        <Button onClick={onClose}>
          <text fg={theme.primary}>Back (Esc)</text>
        </Button>
      </box>
      {canApply && (
        <text fg={theme.muted} style={{ flexShrink: 0 }}>
          ↑↓ or Tab choose · Enter apply · Esc back
        </text>
      )}
    </box>
  )
}

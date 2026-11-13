import { TextAttributes } from '@opentui/core'

import { TerminalCommandDisplay } from './terminal-command-display'
import { Button } from './button'
import { cancelBashCommand } from '../utils/bash-command-controller'
import { useTheme } from '../hooks/use-theme'
import { DASHED_BORDER_CHARS } from '../utils/ui-constants'
import { useOutputReaderStore } from '../state/output-reader-store'
import { createTextDocument } from '../utils/output-document'

import type { PendingBashMessage as PendingBashMessageType } from '../types/store'

interface PendingBashMessageProps {
  message: PendingBashMessageType
  onStopCommand?: (id: string) => void
}

export const PendingBashMessage = ({
  message,
  onStopCommand = cancelBashCommand,
}: PendingBashMessageProps) => {
  const theme = useTheme()

  return (
    <box
      style={{
        flexDirection: 'column',
        width: '100%',
        gap: 0,
        paddingBottom: 1,
      }}
    >
      {/* Ghost message container with dashed border */}
      <box
        style={{
          flexDirection: 'column',
          width: '100%',
          borderStyle: 'single',
          borderColor: theme.muted,
          customBorderChars: DASHED_BORDER_CHARS,
          paddingLeft: 1,
          paddingRight: 1,
          paddingTop: 0,
          paddingBottom: 0,
          gap: 0,
        }}
      >
        {/* Command output using shared component */}
        <TerminalCommandDisplay
          command={message.command}
          output={null}
          expandable={false}
          maxVisibleLines={10}
          isRunning={message.isRunning}
          cwd={message.cwd}
          status={
            message.isRunning
              ? 'running'
              : message.exitCode === undefined
                ? 'outcome unknown'
                : message.exitCode === 0
                  ? 'succeeded'
                  : 'failed'
          }
          exitCode={message.exitCode ?? undefined}
        />
        {message.stdout !== null && message.stdout !== undefined && (
          <TerminalCommandDisplay
            command={message.command}
            output={message.stdout || '(No stdout captured)'}
            showCommandHeader={false}
            outputLabel="stdout · captured"
            expandable={false}
            maxVisibleLines={5}
          />
        )}
        {message.stderr !== null && message.stderr !== undefined && (
          <TerminalCommandDisplay
            command={message.command}
            output={message.stderr || '(No stderr captured)'}
            showCommandHeader={false}
            outputLabel="stderr · captured"
            expandable={false}
            maxVisibleLines={5}
          />
        )}
        <Button
          onClick={() =>
            useOutputReaderStore.getState().open({
              document: createTextDocument({
                id: `pending-shell:${message.id}`,
                title: `$ ${message.command}`,
                kind: 'log',
                text: `Command: ${message.command}\nWorking directory: ${message.cwd ?? 'not captured'}\nState: ${message.isRunning ? 'running' : message.exitCode === undefined ? 'outcome unknown' : `exit ${message.exitCode}`}\n\nstdout · captured\n${message.stdout ?? '(Not captured)'}\n\nstderr · captured\n${message.stderr ?? '(Not captured)'}`,
                notice:
                  'Captured stdout and stderr are grouped by channel; their original interleaving is unavailable.',
              }),
            })
          }
        >
          <text fg={theme.secondary}>Inspect captured channels</text>
        </Button>

        {/* Note about pending status */}
        <box style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
          <text
            fg={theme.muted}
            attributes={TextAttributes.ITALIC}
            flexShrink={1}
          >
            {message.isRunning
              ? 'Stop this shell command; agent run and draft remain available.'
              : 'Captured shell result; retained channels remain inspectable.'}
          </text>
          {message.isRunning && (
            <Button
              flexShrink={0}
              marginLeft={1}
              onClick={() => {
                onStopCommand(message.id)
              }}
            >
              <text fg={theme.error} wrapMode="none">
                Stop shell command
              </text>
            </Button>
          )}
        </box>
      </box>
    </box>
  )
}

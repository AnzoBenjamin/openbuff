import React from 'react'

import { detectEngineProfiles } from '@codebuff/common/util/engine-profiles'
import { getGameDevSlashCommands } from '@codebuff/common/util/game-dev-presets'
import type { FileTreeNode } from '@codebuff/common/util/file'

import { BottomBanner } from './bottom-banner'
import { useTheme } from '../hooks/use-theme'
import { useChatStore } from '../state/chat-store'
import { Button } from './button'
import { createTextDocument } from '../utils/output-document'
import { useOutputReaderStore } from '../state/output-reader-store'

/** Help banner showing keyboard shortcuts and tips in an organized layout. */
export const HelpBanner = ({ fileTree }: { fileTree?: FileTreeNode[] }) => {
  const setInputMode = useChatStore((state) => state.setInputMode)
  const theme = useTheme()

  // Detect game engines from the project file tree (optional).
  const engineProfiles = React.useMemo(
    () => (fileTree ? detectEngineProfiles(fileTree) : []),
    [fileTree],
  )
  const gameDevCommands = React.useMemo(
    () =>
      engineProfiles.length > 0
        ? getGameDevSlashCommands(engineProfiles.map((p) => p.id))
        : [],
    [engineProfiles],
  )

  const fullHelp = [
    'Keyboard help',
    '',
    'Composer',
    'Enter: send prompt',
    'Ctrl+J / Shift+Enter / Opt+Enter: insert newline',
    'Up / Down: prompt history',
    'Ctrl+V: paste text or image',
    'Tab / Shift+Tab: navigate suggestions',
    'Ctrl+C / Esc: stop the current response when no local panel owns the key',
    '',
    'Navigation',
    'Ctrl+P: commands, files, output, work queue and session details',
    'Ctrl+R: search prompt history',
    'PgUp / PgDn: scroll output',
    'Ctrl+T: collapse or expand agents',
    '',
    'Output reader',
    '/: find captured text',
    'G: line number, or row <number> for captured tables',
    'O: outline',
    'D: source and availability details',
    'C: copy selected line',
    'E: export retained view as plain text',
    'Esc: close local search/details, then return',
    '',
    'Commands and mentions',
    '/: slash commands',
    '@files: mention captured project files',
    '@agents: choose an agent',
    '!bash: run a shell command',
    ...(gameDevCommands.length
      ? [
          '',
          'Detected game tools',
          ...gameDevCommands.map(
            (command) => `/${command.id}: ${command.description}`,
          ),
        ]
      : []),
  ].join('\n')
  return (
    <BottomBanner borderColorKey="info" onClose={() => setInputMode('default')}>
      <box style={{ flexDirection: 'column', gap: 0, flexGrow: 1 }}>
        <text fg={theme.foreground}>Keyboard help</text>
        <text fg={theme.muted}>Ctrl+P commands · Ctrl+R history</text>
        <text fg={theme.muted}>Enter send · Shift+Enter newline</text>
        <text fg={theme.muted}>PgUp / PgDn scroll output</text>
        <Button
          onClick={() =>
            useOutputReaderStore.getState().open({
              document: createTextDocument({
                id: 'keyboard-help',
                title: 'Keyboard help',
                text: fullHelp,
                notice:
                  'Local keyboard reference · Back returns to the composer',
              }),
            })
          }
        >
          <text fg={theme.link}>Inspect keyboard help</text>
        </Button>
      </box>
    </BottomBanner>
  )
}

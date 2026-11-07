import { afterEach, expect, test } from 'bun:test'
import React from 'react'
import type { BoxRenderable } from '@opentui/core'
import { PendingBashMessage } from '../pending-bash-message'
import { AgentModeToggle } from '../agent-mode-toggle'
import { MultilineInput } from '../multiline-input'
import { estimatedAgentModeToggleWidth } from '../../hooks/use-chat-input'
import { initializeThemeStore } from '../../hooks/use-theme'
import { useChatStore } from '../../state/chat-store'
import { useOutputReaderStore } from '../../state/output-reader-store'
import type { AgentMode } from '../../utils/constants'
import type { InputValue } from '../../types/store'

initializeThemeStore()
const renderTest = process.env.NODE_ENV === 'production' ? test.skip : test
afterEach(() => {
  useOutputReaderStore.getState().close()
  useChatStore.getState().reset()
})

renderTest(
  'pending shell mixed channels retain both streams, captured cwd and scoped stop/inspection',
  async () => {
    const { testRender } = await import('@opentui/react/test-utils')
    const stopped: string[] = []
    const setup = await testRender(
      <PendingBashMessage
        message={{
          id: 'shell-fixture',
          command: 'fixture shell',
          stdout: 'ordinary stdout evidence',
          stderr: 'important stderr failure',
          exitCode: 0,
          isRunning: true,
          cwd: '/captured/project',
        }}
        onStopCommand={(id) => stopped.push(id)}
      />,
      { width: 80, height: 24 },
    )
    await React.act(async () => setup.renderOnce())
    const clickLabel = async (label: string) => {
      const rows = setup.captureCharFrame().split('\n')
      const y = rows.findIndex((row) => row.includes(label))
      expect(y).toBeGreaterThanOrEqual(0)
      await React.act(async () =>
        setup.mockMouse.click(rows[y]!.indexOf(label) + 2, y),
      )
    }
    try {
      const frame = setup.captureCharFrame()
      expect(frame).toContain('ordinary stdout evidence')
      expect(frame).toContain('important stderr failure')
      expect(frame).toContain('/captured/project')
      expect(frame).toContain('status running')
      await clickLabel('Inspect captured channels')
      const document = useOutputReaderStore.getState().request?.document
      expect(document?.text).toContain(
        'stdout · captured\nordinary stdout evidence',
      )
      expect(document?.text).toContain(
        'stderr · captured\nimportant stderr failure',
      )
      expect(document?.text).toContain('Working directory: /captured/project')
      expect(document?.notice).toContain('interleaving is unavailable')
      await clickLabel('Stop shell command')
      expect(stopped).toEqual(['shell-fixture'])
    } finally {
      await React.act(async () => setup.renderer.destroy())
    }
  },
)

renderTest(
  'C03-03 empty and stderr-only completed shell captures preserve channel and truthful outcome labels',
  async () => {
    const { testRender } = await import('@opentui/react/test-utils')
    for (const fixture of [
      { stdout: '', stderr: '', exitCode: 0, label: 'succeeded' },
      {
        stdout: '',
        stderr: 'stderr-only exact failure',
        exitCode: 2,
        label: 'failed',
      },
    ]) {
      const setup = await testRender(
        <PendingBashMessage
          message={{
            id: 'channel-fixture',
            command: 'fixture shell',
            stdout: fixture.stdout,
            stderr: fixture.stderr,
            exitCode: fixture.exitCode,
            isRunning: false,
            cwd: '/captured/project',
          }}
        />,
        { width: 60, height: 18 },
      )
      try {
        await React.act(async () => setup.renderOnce())
        const frame = setup.captureCharFrame()
        expect(frame).toContain('stdout · captured')
        expect(frame).toContain('stderr · captured')
        expect(frame).toContain(`status ${fixture.label}`)
        expect(frame).not.toContain('Stop shell command')
        if (fixture.stderr) expect(frame).toContain(fixture.stderr)
        const rows = frame.split('\n')
        const y = rows.findIndex((row) =>
          row.includes('Inspect captured channels'),
        )
        expect(y).toBeGreaterThanOrEqual(0)
        await React.act(async () =>
          setup.mockMouse.click(rows[y]!.indexOf('Inspect') + 2, y),
        )
        const document = useOutputReaderStore.getState().request?.document
        expect(document?.text).toContain(`State: exit ${fixture.exitCode}`)
        expect(document?.text).toContain(`stdout · captured\n${fixture.stdout}`)
        expect(document?.text).toContain(`stderr · captured\n${fixture.stderr}`)
      } finally {
        await React.act(async () => setup.renderer.destroy())
        useOutputReaderStore.getState().close()
      }
    }
  },
)

renderTest(
  'mode popup preserves editor width/draft at 60/80/100 and owns batched arrow/Enter/Escape',
  async () => {
    const { testRender } = await import('@opentui/react/test-utils')
    for (const columns of [60, 80, 100]) {
      const inputBox = React.createRef<BoxRenderable>()
      let latest: InputValue = {
        text: 'wrap boundary '.repeat(8),
        cursorPosition: 13,
        lastEditDueToNav: false,
      }
      let submitted = 0
      let modeChanged = 0
      let open = false
      function Host() {
        const [draft, setDraft] = React.useState(latest)
        const [mode, setMode] = React.useState<AgentMode>('DEFAULT')
        const [menuOpen, setMenuOpen] = React.useState(false)
        latest = draft
        const width =
          columns - estimatedAgentModeToggleWidth('default', mode, false, false)
        return (
          <box width={columns} height={18} flexDirection="column">
            <box flexGrow={1}>
              <text>Conversation remains available</text>
            </box>
            <box flexDirection="row">
              <box ref={inputBox} width={width}>
                <MultilineInput
                  value={draft.text}
                  cursorPosition={draft.cursorPosition}
                  onChange={setDraft}
                  onSubmit={() => submitted++}
                  onPaste={() => {}}
                  focused={!menuOpen}
                  pasteEnabled={!menuOpen}
                  wrapWidth={width}
                />
              </box>
              <AgentModeToggle
                mode={mode}
                onToggle={() => {}}
                onSelectMode={(value) => {
                  modeChanged++
                  setMode(value)
                }}
                onOpenChange={(value) => {
                  open = value
                  setMenuOpen(value)
                }}
              />
            </box>
          </box>
        )
      }
      const setup = await testRender(<Host />, {
        width: columns,
        height: 18,
        kittyKeyboard: true,
      })
      await React.act(async () => setup.renderOnce())
      const clickToggle = async () => {
        const rows = setup.captureCharFrame().split('\n')
        const y = rows.findIndex((row) => /< (DEFAULT|PLAN)/.test(row))
        expect(y).toBeGreaterThanOrEqual(0)
        const x = rows[y]!.indexOf('< ')
        await React.act(async () => setup.mockMouse.click(x + 3, y))
        await React.act(async () => setup.renderOnce())
      }
      try {
        const initial = { ...latest }
        const width = inputBox.current!.width
        await clickToggle()
        expect(open).toBe(true)
        expect(inputBox.current!.width).toBe(width)
        expect(latest).toEqual(initial)
        await React.act(async () => setup.mockInput.pressKeys(['\x1b[B', '\r']))
        expect(modeChanged).toBe(1)
        expect(submitted).toBe(0)
        expect(open).toBe(false)
        expect(latest).toEqual(initial)
        await clickToggle()
        await React.act(async () => setup.mockInput.pressEscape())
        expect(open).toBe(false)
        expect(submitted).toBe(0)
        expect(latest).toEqual(initial)
        await React.act(async () => setup.mockInput.pressEnter())
        expect(submitted).toBe(1)
      } finally {
        await React.act(async () => setup.renderer.destroy())
      }
    }
  },
)

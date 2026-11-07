import { afterEach, expect, test } from 'bun:test'
import React from 'react'

import { CommandPaletteScreen } from '../command-palette-screen'
import { PromptHistorySearchScreen } from '../prompt-history-search-screen'
import { initializeThemeStore, useThemeStore } from '../../hooks/use-theme'
import { setSessionHistoryRetry } from '../../utils/message-history'
import type { FileTreeNode } from '@codebuff/common/util/file'

initializeThemeStore()
const renderTest = process.env.NODE_ENV === 'production' ? test.skip : test
afterEach(() =>
  setSessionHistoryRetry({ attempts: 0, lastAttemptMs: -Infinity }),
)

async function mount(node: React.ReactNode, width = 60, height = 18) {
  const { testRender } = await import('@opentui/react/test-utils')
  let setup!: Awaited<ReturnType<typeof testRender>>
  await React.act(async () => {
    setup = await testRender(node, { width, height, exitOnCtrlC: false })
  })
  await setup.renderOnce()
  return setup
}

const files: FileTreeNode[] = Array.from({ length: 250 }, (_, index) => ({
  name: `file-${index + 1}.ts`,
  filePath: `file-${index + 1}.ts`,
  type: 'file' as const,
}))

renderTest(
  'palette uses the latest query, batched arrows and exactly one activation',
  async () => {
    const selected: string[] = []
    const setup = await mount(
      <CommandPaletteScreen
        slashCommands={[]}
        fileTree={[]}
        actions={[
          'First action',
          'Target one',
          'Target two',
          'Target three',
        ].map((label) => ({
          id: label,
          label,
          description: 'Local fixture',
          onSelect: () => selected.push(label),
        }))}
        onClose={() => {}}
        onExecuteCommand={() => {
          throw new Error('Unexpected dispatch')
        }}
        onSelectFile={() => {
          throw new Error('Unexpected file')
        }}
      />,
    )
    try {
      await React.act(async () => {
        await setup.mockInput.typeText('Target')
        setup.mockInput.pressArrow('down')
        setup.mockInput.pressArrow('down')
        setup.mockInput.pressEnter()
        setup.mockInput.pressEnter()
      })
      expect(selected).toEqual(['Target three'])
    } finally {
      await React.act(async () => setup.renderer.destroy())
    }
  },
)

renderTest(
  'palette searches beyond the initial file cap in the same paste/Enter batch',
  async () => {
    const selected: string[] = []
    const setup = await mount(
      <CommandPaletteScreen
        slashCommands={[]}
        fileTree={files}
        onClose={() => {}}
        onExecuteCommand={() => {}}
        onSelectFile={(path) => selected.push(path)}
      />,
    )
    try {
      expect(setup.captureCharFrame()).toContain('First 50 of 250 files')
      await React.act(async () => {
        await setup.mockInput.pasteBracketedText('file-250.ts')
        setup.mockInput.pressEnter()
      })
      expect(selected).toEqual(['file-250.ts'])
    } finally {
      await React.act(async () => setup.renderer.destroy())
    }
  },
)

renderTest(
  'palette keeps result limits, input and tail selection visible across themes and narrow resize',
  async () => {
    for (const theme of ['dark', 'light'] as const) {
      useThemeStore.getState().setThemeName(theme)
      for (const [width, height] of [
        [40, 15],
        [50, 20],
        [80, 24],
        [120, 40],
        [40, 10],
      ]) {
        const selected: string[] = []
        const setup = await mount(
          <CommandPaletteScreen
            slashCommands={[]}
            fileTree={files}
            onClose={() => {}}
            onExecuteCommand={() => {}}
            onSelectFile={(path) => selected.push(path)}
          />,
          width,
          height,
        )
        try {
          const frame = setup.captureCharFrame()
          expect(frame).toContain('Command Palette')
          expect(frame).toContain('Esc close')
          expect(frame).toContain('First 50 of 250 files')
          expect(frame).toContain('Search commands or files')
          expect(frame).toContain('file-1.ts')
          await React.act(async () => setup.mockInput.typeText('file'))
          await setup.renderOnce()
          expect(setup.captureCharFrame()).toContain('200 of 250')
          expect(setup.captureCharFrame()).toContain('Refine search')
          await React.act(async () => {
            for (let index = 0; index < 199; index++)
              setup.mockInput.pressArrow('down')
          })
          await React.act(async () => setup.resize(40, 10))
          await setup.renderOnce()
          expect(setup.captureCharFrame()).toContain('file-200.ts')
          await React.act(async () => setup.mockInput.pressEnter())
          expect(selected).toEqual(['file-200.ts'])
        } finally {
          await React.act(async () => setup.renderer.destroy())
        }
      }
    }
  },
)

renderTest(
  'palette insertion prepares a draft once without dispatching',
  async () => {
    const inserted: string[] = []
    let closed = 0
    const setup = await mount(
      <CommandPaletteScreen
        slashCommands={[
          {
            id: 'agent:general',
            label: 'agent:general',
            description: 'Prepare agent prompt',
            insertText: '@general-agent ',
          },
        ]}
        fileTree={[]}
        onClose={() => closed++}
        onExecuteCommand={() => {
          throw new Error('Insertion must not dispatch')
        }}
        onInsertText={(text) => inserted.push(text)}
        onSelectFile={() => {}}
      />,
    )
    try {
      expect(setup.captureCharFrame()).toContain('Insert draft')
      await React.act(async () => {
        setup.mockInput.pressEnter()
        setup.mockInput.pressEnter()
      })
      expect(inserted).toEqual(['@general-agent '])
      expect(closed).toBe(1)
    } finally {
      await React.act(async () => setup.renderer.destroy())
    }
  },
)

renderTest(
  'empty palette accepts arriving results and blocks a removed selected identity',
  async () => {
    const selected: string[] = []
    let update!: (paths: FileTreeNode[]) => void
    function Host() {
      const [tree, setTree] = React.useState<FileTreeNode[]>([])
      update = setTree
      return (
        <CommandPaletteScreen
          slashCommands={[]}
          fileTree={tree}
          onClose={() => {}}
          onExecuteCommand={() => {}}
          onSelectFile={(path) => selected.push(path)}
        />
      )
    }
    const setup = await mount(<Host />)
    try {
      await React.act(async () => setup.mockInput.pressArrow('down'))
      await React.act(async () => update(files.slice(0, 2)))
      await React.act(async () => setup.mockInput.pressArrow('down'))
      await React.act(async () => update([files[0]!]))
      await React.act(async () => setup.mockInput.pressEnter())
      expect(selected).toEqual([])
      await setup.renderOnce()
      expect(setup.captureCharFrame()).toContain('Selection unavailable')
      await React.act(async () => {
        setup.mockInput.pressArrow('down')
        setup.mockInput.pressEnter()
      })
      expect(selected).toEqual(['file-1.ts'])
    } finally {
      await React.act(async () => setup.renderer.destroy())
    }
  },
)

renderTest(
  'history uses current pasted query and batched focus without duplicate selection',
  async () => {
    const selected: string[] = []
    const setup = await mount(
      <PromptHistorySearchScreen
        onClose={() => {}}
        onSelectPrompt={(text) => selected.push(text)}
        loadHistory={() => ({
          history: ['Target three', 'Target two', 'Target one', 'Other prompt'],
          unavailable: false,
        })}
      />,
    )
    try {
      await React.act(async () => {
        await setup.mockInput.pasteBracketedText('Target')
        setup.mockInput.pressArrow('down')
        setup.mockInput.pressArrow('down')
        setup.mockInput.pressEnter()
        setup.mockInput.pressEnter()
      })
      expect(selected).toEqual(['Target three'])
    } finally {
      await React.act(async () => setup.renderer.destroy())
    }
  },
)

renderTest(
  'history shows exact counts and stays usable at narrow sizes and after resize',
  async () => {
    for (const [width, height] of [
      [40, 15],
      [50, 20],
      [80, 24],
      [120, 40],
      [40, 10],
    ]) {
      const selected: string[] = []
      const setup = await mount(
        <PromptHistorySearchScreen
          onClose={() => {}}
          onSelectPrompt={(text) => selected.push(text)}
          loadHistory={() => ({
            history: Array.from(
              { length: 250 },
              (_, index) => `Target ${index + 1}`,
            ),
            unavailable: false,
          })}
        />,
        width,
        height,
      )
      try {
        const frame = setup.captureCharFrame()
        expect(frame).toContain('Prompt history')
        expect(frame).toContain('Enter use')
        expect(frame).toContain('Esc')
        expect(frame).toContain('Search past prompts')
        expect(frame).toContain('200 of 250')
        expect(frame).toContain('Refine search')
        expect(frame).toContain('Target 250')
        await React.act(async () => setup.mockInput.typeText('Target 250'))
        await React.act(async () => setup.resize(40, 10))
        await setup.renderOnce()
        expect(setup.captureCharFrame()).toContain('Target 250')
        await React.act(async () => setup.mockInput.pressEnter())
        expect(selected).toEqual(['Target 250'])
      } finally {
        await React.act(async () => setup.renderer.destroy())
      }
    }
  },
)

renderTest(
  'partial history remains visible and Ctrl+R, Escape and Ctrl+C only dismiss',
  async () => {
    for (const key of ['r', 'escape', 'c']) {
      let closed = 0
      const setup = await mount(
        <PromptHistorySearchScreen
          onClose={() => closed++}
          onSelectPrompt={() => {
            throw new Error('Dismissal must not select')
          }}
          loadHistory={() => ({
            history: ['Retained first', 'Retained second'],
            unavailable: true,
          })}
        />,
        40,
        15,
      )
      try {
        const frame = setup.captureCharFrame()
        expect(frame).toContain('Retained first')
        expect(frame).toContain('Retained second')
        expect(frame).toContain('History incomplete')
        await React.act(async () => {
          if (key === 'escape') {
            setup.mockInput.pressEscape()
            await Bun.sleep(120)
          } else setup.mockInput.pressKey(key, { ctrl: true })
        })
        expect(closed).toBe(1)
      } finally {
        await React.act(async () => setup.renderer.destroy())
      }
    }
  },
)

renderTest(
  'a successful history retry removes the partial notice and retains focused prompt identity',
  async () => {
    let reads = 0
    const selected: string[] = []
    const setup = await mount(
      <PromptHistorySearchScreen
        onClose={() => {}}
        onSelectPrompt={(text) => selected.push(text)}
        loadHistory={() => ({
          history:
            reads++ === 0
              ? ['Retained first', 'Retained second']
              : ['Retained first', 'Retained second', 'New arrival'],
          unavailable: reads === 1,
        })}
      />,
      40,
      10,
    )
    try {
      await React.act(async () => setup.mockInput.pressArrow('down'))
      await React.act(async () => Bun.sleep(2200))
      await setup.renderOnce()
      expect(setup.captureCharFrame()).not.toContain('History incomplete')
      expect(setup.captureCharFrame()).toContain('New arrival')
      await React.act(async () => setup.mockInput.pressEnter())
      expect(selected).toEqual(['Retained first'])
    } finally {
      await React.act(async () => setup.renderer.destroy())
    }
  },
)

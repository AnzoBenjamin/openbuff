import { expect, test } from 'bun:test'
import React from 'react'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { ProjectPickerScreen } from '../project-picker-screen'
import {
  useDirectoryBrowser,
  type UseDirectoryBrowserOptions,
} from '../../hooks/use-directory-browser'
import { initializeThemeStore } from '../../hooks/use-theme'

async function renderFixture(
  node: React.ReactNode,
  options: Parameters<typeof import('@opentui/react/test-utils').testRender>[1],
) {
  const { testRender } = await import('@opentui/react/test-utils')
  let setup!: Awaited<ReturnType<typeof testRender>>
  await React.act(async () => {
    setup = await testRender(node, options)
  })
  return setup
}

initializeThemeStore()
const renderTest = process.env.NODE_ENV === 'production' ? test.skip : test
const entries = [
  { name: '..', path: '/tmp', isParent: true, isGitRepo: false },
  { name: 'project', path: '/tmp/project', isParent: false, isGitRepo: true },
]
const dependencies: NonNullable<UseDirectoryBrowserOptions['dependencies']> = {
  list: async () => ({ entries, state: 'ready', omitted: 0 }),
  git: async () => false,
  canonical: (value) => value,
  isDirectory: (value) => value === '/tmp' || value === '/tmp/project',
}

renderTest(
  'invalid paths never fall through to parent navigation; unmatched names have no activation',
  async () => {
    const { testRender } = await import('@opentui/react/test-utils')
    const setup = await renderFixture(
      <ProjectPickerScreen
        initialPath="/tmp/project"
        browserDependencies={dependencies}
        recentProjects={[]}
        onSelectProject={() => {}}
      />,
      { width: 80, height: 24 },
    )
    try {
      for (const value of ['/bad', './bad', 'C:\\bad', '\\\\server\\bad']) {
        await React.act(async () => {
          await setup.mockInput.typeText(value)
          setup.mockInput.pressEnter()
        })
        await setup.renderOnce()
        expect(setup.captureCharFrame()).toContain('/tmp/project')
        expect(setup.captureCharFrame()).toContain('Could not open')
        await React.act(async () => {
          setup.mockInput.pressEscape()
          await Bun.sleep(120)
        })
      }
      await React.act(async () => {
        await setup.mockInput.typeText('unmatched')
        setup.mockInput.pressEnter()
      })
      await setup.renderOnce()
      expect(setup.captureCharFrame()).toContain('No matching directories')
      expect(setup.captureCharFrame()).toContain('/tmp/project')
    } finally {
      await React.act(async () => setup.renderer.destroy())
    }
  },
)

renderTest(
  'short geometry preserves current basename/Open and early input belongs to picker',
  async () => {
    const { testRender } = await import('@opentui/react/test-utils')
    for (const [width, height] of [
      [30, 10],
      [50, 20],
      [80, 12],
      [80, 24],
    ]) {
      const setup = await renderFixture(
        <ProjectPickerScreen
          initialPath="/tmp/very-long-parent/👩🏽‍💻项目"
          initialQuery="early folder text"
          browserDependencies={dependencies}
          recentProjects={[
            { path: '/tmp/a', lastOpened: 1 },
            { path: '/tmp/b', lastOpened: 2 },
            { path: '/tmp/c', lastOpened: 3 },
          ]}
          onSelectProject={() => {}}
        />,
        { width, height },
      )
      try {
        await React.act(async () => Bun.sleep(5))
        await setup.renderOnce()
        const frame = setup.captureCharFrame()
        expect(frame).toContain('👩🏽‍💻项目')
        expect(frame).toContain('Open (Ctrl+Enter)')
        expect(frame).toContain('early folder text')
      } finally {
        await React.act(async () => setup.renderer.destroy())
      }
    }
  },
)

renderTest(
  'picker catches selection failure, preserves query and serializes repeated Open activation',
  async () => {
    const { testRender } = await import('@opentui/react/test-utils')
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'openbuff-picker-retry-'),
    )
    let calls = 0
    const setup = await renderFixture(
      <ProjectPickerScreen
        initialPath={root}
        initialQuery="keep query"
        browserDependencies={dependencies}
        recentProjects={[]}
        onSelectProject={async () => {
          calls++
          if (calls === 1) throw new Error('Client reset denied')
        }}
      />,
      { width: 80, height: 24, kittyKeyboard: true },
    )
    try {
      await React.act(async () => {
        setup.mockInput.pressEnter({ ctrl: true })
        setup.mockInput.pressEnter({ ctrl: true })
      })
      await setup.renderOnce()
      expect(calls).toBe(1)
      expect(setup.captureCharFrame()).toContain('Client reset denied')
      expect(setup.captureCharFrame()).toContain('keep query')
      await React.act(async () => setup.mockInput.pressEnter({ ctrl: true }))
      expect(calls).toBe(2)
    } finally {
      await React.act(async () => setup.renderer.destroy())
      fs.rmSync(root, { recursive: true, force: true })
    }
  },
)

renderTest(
  'directory loading clears old rows and stale generations cannot replace a newer folder',
  async () => {
    const { testRender } = await import('@opentui/react/test-utils')
    let browser!: ReturnType<typeof useDirectoryBrowser>
    const pending = new Map<string, (value: any) => void>()
    const dependencies = {
      list: async (value: string) =>
        new Promise<any>((resolve) => pending.set(value, resolve)),
      git: async () => false,
      canonical: (value: string) => value,
      isDirectory: () => true,
    }
    const Host = () => {
      browser = useDirectoryBrowser({ initialPath: '/A', dependencies })
      return (
        <text>
          {browser.currentPath} {browser.loadState}{' '}
          {browser.directories.map((entry) => entry.name).join(',')}
        </text>
      )
    }
    const setup = await renderFixture(<Host />, { width: 80, height: 24 })
    try {
      await React.act(async () => browser.setCurrentPath('/B'))
      expect(browser.directories).toEqual([])
      await React.act(async () =>
        pending.get('/B')?.({
          entries: [{ ...entries[1], name: 'B child' }],
          state: 'ready',
          omitted: 0,
        }),
      )
      await React.act(async () =>
        pending.get('/A')?.({
          entries: [{ ...entries[1], name: 'stale A' }],
          state: 'ready',
          omitted: 0,
        }),
      )
      expect(browser.currentPath).toBe('/B')
      expect(browser.directories[0]?.name).toBe('B child')
    } finally {
      await React.act(async () => setup.renderer.destroy())
    }
  },
)

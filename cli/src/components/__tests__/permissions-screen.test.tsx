import { afterEach, expect, test } from 'bun:test'
import React from 'react'

import { PermissionsScreen } from '../permissions-screen'
import { handlePermissionsCommand } from '../../commands/permissions'
import { initializeThemeStore, useThemeStore } from '../../hooks/use-theme'
import {
  getCommandApprovalOverride,
  setCommandApprovalMode,
} from '../../utils/command-approvals'

initializeThemeStore()
const nativeTest = process.env.NODE_ENV === 'production' ? test.skip : test
afterEach(() => {
  setCommandApprovalMode(undefined)
  useThemeStore.getState().setThemeName('dark')
})

async function mount(node: React.ReactNode, width = 60, height = 18) {
  const { testRender } = await import('@opentui/react/test-utils')
  let setup!: Awaited<ReturnType<typeof testRender>>
  await React.act(async () => {
    setup = await testRender(node, { width, height })
  })
  await setup.renderOnce()
  return setup
}

for (const theme of ['light', 'dark'] as const) {
  for (const [width, height] of [
    [60, 18],
    [100, 24],
    [160, 32],
  ]) {
    nativeTest(
      `permissions choices and actions fit ${width}×${height} in ${theme}`,
      async () => {
        useThemeStore.getState().setThemeName(theme)
        const setup = await mount(
          <PermissionsScreen
            loadSettings={() => ({ attached: false, configuredMode: 'strict' })}
            onClose={() => {}}
            onApplied={() => {}}
          />,
          width,
          height,
        )
        try {
          const frame = setup.captureCharFrame()
          for (const label of [
            'Permissions',
            'Balanced',
            'Strict',
            'Allow all',
            'Use configuration',
            'Apply (Enter)',
            'Back (Esc)',
            'next run',
          ])
            expect(frame).toContain(label)
          expect(frame).toContain('For next run: strict · configuration')
          expect(getCommandApprovalOverride()).toBeUndefined()
        } finally {
          await React.act(async () => setup.renderer.destroy())
        }
      },
    )
  }
}

nativeTest(
  'batched navigation and repeated Enter apply the latest selection once',
  async () => {
    const selected: string[] = []
    const settings = {
      configuredMode: () => 'strict' as const,
      attached: () => false,
    }
    const setup = await mount(
      <PermissionsScreen
        loadSettings={() => ({ attached: false, configuredMode: 'strict' })}
        applySetting={(value) => {
          selected.push(value)
          return handlePermissionsCommand(value, settings)
        }}
        onClose={() => {}}
        onApplied={(message) =>
          expect(message).toContain('allow-all (this session)')
        }
      />,
    )
    try {
      // Configuration starts at index 3; move to Allow all without a React render.
      await React.act(async () => {
        setup.mockInput.pressArrow('up')
        setup.mockInput.pressEnter()
        setup.mockInput.pressEnter()
      })
      expect(selected).toEqual(['allow-all'])
      expect(getCommandApprovalOverride()).toBe('allow-all')
    } finally {
      await React.act(async () => setup.renderer.destroy())
    }
  },
)

nativeTest(
  'clicking a choice previews it; Apply changes it and configuration resets the override',
  async () => {
    setCommandApprovalMode('strict')
    const selected: string[] = []
    const setup = await mount(
      <PermissionsScreen
        loadSettings={() => ({
          attached: false,
          override: 'strict',
          configuredMode: 'balanced',
        })}
        applySetting={(value) => {
          selected.push(value)
          return handlePermissionsCommand(value, {
            configuredMode: () => 'balanced',
            attached: () => false,
          })
        }}
        onClose={() => {}}
        onApplied={() => {}}
      />,
    )
    const click = async (label: string) => {
      const lines = setup.captureCharFrame().split('\n')
      const row = lines.findIndex((line) => line.includes(label))
      expect(row).toBeGreaterThanOrEqual(0)
      await React.act(async () =>
        setup.mockMouse.click(lines[row].indexOf(label) + 1, row),
      )
      await setup.renderOnce()
    }
    try {
      await click('Use configuration')
      expect(getCommandApprovalOverride()).toBe('strict')
      await click('Apply (Enter)')
      expect(selected).toEqual(['reset'])
      expect(getCommandApprovalOverride()).toBeUndefined()
    } finally {
      await React.act(async () => setup.renderer.destroy())
    }
  },
)

nativeTest(
  'keyboard navigation after a mouse selection applies the visibly selected choice',
  async () => {
    const values: string[] = []
    const setup = await mount(
      <PermissionsScreen
        loadSettings={() => ({ attached: false, configuredMode: 'balanced' })}
        applySetting={(value) => {
          values.push(value)
          return value
        }}
        onClose={() => {}}
        onApplied={() => {}}
      />,
    )
    try {
      const lines = setup.captureCharFrame().split('\n')
      const row = lines.findIndex((line) => line.includes('Balanced'))
      await React.act(async () =>
        setup.mockMouse.click(lines[row].indexOf('Balanced') + 1, row),
      )
      await React.act(async () => {
        setup.mockInput.pressArrow('down')
        setup.mockInput.pressEnter()
      })
      expect(values).toEqual(['strict'])
    } finally {
      await React.act(async () => setup.renderer.destroy())
    }
  },
)

nativeTest(
  'Back closes without applying and an attached server cannot apply a local setting',
  async () => {
    let closed = 0
    let applied = 0
    const setup = await mount(
      <PermissionsScreen
        loadSettings={() => ({ attached: true })}
        applySetting={() => {
          applied++
          return 'unexpected'
        }}
        onClose={() => {
          closed++
        }}
        onApplied={() => {
          applied++
        }}
      />,
    )
    try {
      expect(setup.captureCharFrame()).toContain(
        'managed by the attached server',
      )
      expect(setup.captureCharFrame()).not.toContain('Apply (Enter)')
      await React.act(async () => {
        setup.mockInput.pressEnter()
        setup.mockInput.pressEscape()
        await Bun.sleep(120)
      })
      expect(applied).toBe(0)
      expect(closed).toBe(1)
    } finally {
      await React.act(async () => setup.renderer.destroy())
    }
  },
)

nativeTest(
  'failed configuration stays distinct from defaults and can be retried',
  async () => {
    let reads = 0
    const setup = await mount(
      <PermissionsScreen
        loadSettings={() => {
          if (++reads === 1) throw new Error('Configuration is unreadable')
          return { attached: false, configuredMode: 'balanced' }
        }}
        onClose={() => {}}
        onApplied={() => {}}
      />,
    )
    try {
      expect(setup.captureCharFrame()).toContain('Configuration is unreadable')
      expect(setup.captureCharFrame()).not.toContain('Apply (Enter)')
      await React.act(async () => setup.mockInput.pressKey('r'))
      await setup.renderOnce()
      expect(setup.captureCharFrame()).toContain(
        'For next run: balanced · configuration',
      )
      expect(setup.captureCharFrame()).toContain('Apply (Enter)')
      expect(getCommandApprovalOverride()).toBeUndefined()
    } finally {
      await React.act(async () => setup.renderer.destroy())
    }
  },
)

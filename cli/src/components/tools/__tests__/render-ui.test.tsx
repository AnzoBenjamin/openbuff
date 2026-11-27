import { describe, expect, test } from 'bun:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { initializeThemeStore } from '../../../hooks/use-theme'
import { chatThemes } from '../../../utils/theme-system'
import { RenderUIComponent } from '../render-ui'

import type { ToolBlock } from '../types'

initializeThemeStore()

const createToolBlock = (
  input: unknown,
): ToolBlock & { toolName: 'render_ui' } => ({
  type: 'tool',
  toolName: 'render_ui',
  toolCallId: 'test-render-ui-call-id',
  input,
})

describe('RenderUIComponent', () => {
  test('renders a button widget', () => {
    const result = RenderUIComponent.render(
      createToolBlock({
        widget: {
          type: 'button',
          text: 'Open preview',
          link: 'https://example.com/preview',
          variant: 'primary',
        },
      }),
      chatThemes.light,
      {
        availableWidth: 80,
        indentationOffset: 0,
        labelWidth: 10,
      },
    )

    expect(result.collapsedPreview).toBe(
      'Open preview -> https://example.com/preview',
    )
    expect(result.content).toBeDefined()
    expect(renderToStaticMarkup(<>{result.content}</>)).toContain(
      'Open preview',
    )
  })

  test('returns no content for unsupported widgets', () => {
    const result = RenderUIComponent.render(
      createToolBlock({
        widget: {
          type: 'slider',
          text: 'Volume',
        },
      }),
      chatThemes.light,
      {
        availableWidth: 80,
        indentationOffset: 0,
        labelWidth: 10,
      },
    )

    expect(result.content).toBeNull()
  })
})

test('controlled default and custom primary fills choose text above 4.5:1', async () => {
  const { primaryButtonForeground } = await import('../render-ui')
  const luminance = (hex: string) => {
    const values = [1, 3, 5]
      .map((at) => parseInt(hex.slice(at, at + 2), 16) / 255)
      .map((value) =>
        value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4,
      )
    return values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722
  }
  for (const background of [
    chatThemes.dark.primary,
    chatThemes.light.primary,
    '#777777',
    '#ffffff',
    '#000000',
    '#00ffff',
    '#ff0000',
  ]) {
    const foreground = primaryButtonForeground(background)
    const values = [luminance(background), luminance(foreground)].sort(
      (a, b) => a - b,
    )
    expect((values[1] + 0.05) / (values[0] + 0.05)).toBeGreaterThanOrEqual(4.5)
  }
})

test('named custom primary fills use the renderer color contract and readable foregrounds', async () => {
  const { parseColor } = await import('@opentui/core')
  const { getRenderUIButtonColors } = await import('../render-ui')
  const luminance = (value: string) => {
    const color = parseColor(value)
    const linear = [color.r, color.g, color.b].map((channel) =>
      channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
    )
    return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722
  }
  for (const primary of [
    'blue',
    'navy',
    'green',
    'red',
    'white',
    'black',
    '#00f',
  ]) {
    const colors = getRenderUIButtonColors(
      { ...chatThemes.light, primary },
      'primary',
      false,
    )
    const values = [
      luminance(colors.backgroundColor),
      luminance(colors.foregroundColor),
    ].sort((a, b) => a - b)
    expect((values[1] + 0.05) / (values[0] + 0.05)).toBeGreaterThanOrEqual(4.5)
  }
})

const nativeTest = process.env.NODE_ENV === 'production' ? test.skip : test
nativeTest(
  'failed browser launch preserves the destination and exact copy route while repeated activation is bounded',
  async () => {
    const { RenderUIButton } = await import('../render-ui')
    const { testRender } = await import('@opentui/react/test-utils')
    let resolve!: (value: boolean) => void
    let launches = 0
    const copied: string[] = []
    const link = 'https://fixture.example/retained-destination'
    const setup = await testRender(
      <RenderUIButton
        widget={{
          type: 'button',
          text: 'BROWSER_FIXTURE',
          link,
          variant: 'primary',
        }}
        services={{
          open: async () => {
            launches++
            return new Promise<boolean>((done) => {
              resolve = done
            })
          },
          copy: async (text) => {
            copied.push(text)
          },
        }}
      />,
      { width: 60, height: 18 },
    )
    try {
      await setup.renderOnce()
      await React.act(async () => {
        await setup.mockMouse.click(2, 0)
        await setup.mockMouse.click(2, 0)
      })
      expect(launches).toBe(1)
      await React.act(async () => setup.flush())
      expect(setup.captureCharFrame()).toContain('Opening browser')
      await React.act(async () => resolve(false))
      await setup.renderOnce()
      expect(setup.captureCharFrame()).toContain('launch unavailable')
      expect(setup.captureCharFrame()).toContain(link)
      const lines = setup.captureCharFrame().split('\n')
      const row = lines.findIndex((line) => line.includes('Copy address'))
      await React.act(async () =>
        setup.mockMouse.click(lines[row].indexOf('Copy address') + 1, row),
      )
      await setup.renderOnce()
      expect(copied).toEqual([link])
      expect(setup.captureCharFrame()).toContain('Address copied')
    } finally {
      await React.act(async () => setup.renderer.destroy())
    }
  },
)

nativeTest(
  'a resolved successful browser request is reported accurately and cannot double-launch immediately',
  async () => {
    const { RenderUIButton } = await import('../render-ui')
    const { testRender } = await import('@opentui/react/test-utils')
    let launches = 0
    const setup = await testRender(
      <RenderUIButton
        widget={{
          type: 'button',
          text: 'LAUNCH_FIXTURE',
          link: 'https://fixture.example',
          variant: 'primary',
        }}
        services={{
          open: async () => {
            launches++
            return true
          },
          copy: async () => {},
        }}
      />,
      { width: 80, height: 24 },
    )
    try {
      await setup.renderOnce()
      await React.act(async () => {
        await setup.mockMouse.click(2, 0)
        await setup.mockMouse.click(2, 0)
      })
      await setup.renderOnce()
      expect(launches).toBe(1)
      expect(setup.captureCharFrame()).toContain('Browser launch requested')
    } finally {
      await React.act(async () => setup.renderer.destroy())
    }
  },
)

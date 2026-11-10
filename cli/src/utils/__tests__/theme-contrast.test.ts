import { describe, expect, test } from 'bun:test'

import { chatThemes } from '../theme-system'

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((offset) => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  })
  return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722
}

function contrast(foreground: string, background: string): number {
  const values = [luminance(foreground), luminance(background)]
  return (Math.max(...values) + 0.05) / (Math.min(...values) + 0.05)
}

describe('readability on the built-in controlled surfaces', () => {
  for (const name of ['dark', 'light'] as const) {
    const theme = chatThemes[name]
    test(`${name} content, actions and status text retain readable contrast`, () => {
      for (const background of [
        theme.background,
        theme.surface,
        theme.surfaceHover,
      ]) {
        for (const role of [
          'foreground',
          'muted',
          'secondary',
          'primary',
          'link',
          'success',
          'error',
          'warning',
          'info',
          'inputFg',
        ] as const) {
          expect(contrast(theme[role], background)).toBeGreaterThanOrEqual(4.5)
        }
      }
      expect(contrast(theme.border, theme.surface)).toBeGreaterThanOrEqual(3)
    })
  }
})

import { expect, test } from 'bun:test'
import React from 'react'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'

import { chatThemes } from '../../utils/theme-system'

const nativeTest = process.env.NODE_ENV === 'production' ? test.skip : test
let captureDirectory: string | undefined

function capturePath(filename: string): string {
  if (!captureDirectory) {
    captureDirectory = mkdtempSync(join(tmpdir(), 'openbuff-terminal-native-'))
    console.info(`Terminal background captures: ${captureDirectory}`)
  }
  return join(captureDirectory, filename)
}

function rgb(hex: string): [number, number, number] {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ]
}

nativeTest(
  'native dark and light canvases emit terminal-default backgrounds and preserve slate insets',
  async () => {
    const { testRender } = await import('@opentui/react/test-utils')
    for (const name of ['dark', 'light'] as const) {
      const theme = chatThemes[name]
      let ansi = ''
      const stdout = Object.assign(
        new Writable({
          write(chunk, _encoding, callback) {
            ansi += String(chunk)
            callback()
          },
        }),
        { isTTY: true, columns: 60, rows: 12, getColorDepth: () => 24 },
      ) as NodeJS.WriteStream
      let setup!: Awaited<ReturnType<typeof testRender>>
      await React.act(async () => {
        setup = await testRender(
          <box width={60} height={12} backgroundColor={theme.background}>
            <text fg={theme.primary}>Openbuff terminal-native canvas</text>
            <text fg={theme.foreground}>
              Ordinary prose inherits the terminal
            </text>
            <box backgroundColor={theme.surface}>
              <text fg={theme.foreground}>Slate inset remains distinct</text>
            </box>
          </box>,
          {
            width: 60,
            height: 12,
            stdout,
            bufferedOutput: 'stdout',
            backgroundColor: theme.background,
            useMouse: false,
          },
        )
        await setup.renderer.setupTerminal()
        await setup.flush()
      })
      try {
        await setup.renderOnce()
        await setup.renderer.idle()
        const frame = setup.captureSpans()
        const spans = frame.lines.flatMap((line) => line.spans)
        const main = spans.find((span) => span.text.includes('Ordinary prose'))!
        const brand = spans.find((span) => span.text.includes('Openbuff'))!
        const inset = spans.find((span) => span.text.includes('Slate inset'))!
        expect(main.bg.toInts()[3]).toBe(0)
        expect(brand.bg.toInts()[3]).toBe(0)
        expect(brand.fg.toInts().slice(0, 3)).toEqual(rgb(theme.primary))
        expect(inset.bg.toInts()).toEqual([...rgb(theme.surface), 255])
        expect(ansi).toContain('\u001b[49m')
        expect(ansi).not.toMatch(/\u001b\[48;(?:2;0;0;0|5;0)m/)
        writeFileSync(capturePath(`${name}.ansi.txt`), ansi)
        writeFileSync(capturePath(`${name}.txt`), setup.captureCharFrame())
        writeFileSync(
          capturePath(`${name}.json`),
          JSON.stringify(
            frame.lines.map((line) =>
              line.spans.map((span) => ({
                text: span.text,
                fg: span.fg.toInts(),
                bg: span.bg.toInts(),
              })),
            ),
            null,
            2,
          ),
        )
      } finally {
        await React.act(async () => setup.renderer.destroy())
      }
    }
  },
)

nativeTest(
  'transparent theme content preserves non-black terminal backdrops in both modes',
  async () => {
    const { testRender } = await import('@opentui/react/test-utils')
    for (const [name, terminalBackground] of [
      ['dark', '#263238'],
      ['light', '#fdf6e3'],
    ] as const) {
      const theme = chatThemes[name]
      let setup!: Awaited<ReturnType<typeof testRender>>
      await React.act(async () => {
        setup = await testRender(
          <box width={60} height={12} backgroundColor={terminalBackground}>
            <box backgroundColor={theme.background}>
              <text fg={theme.foreground}>Retained terminal backdrop</text>
              <box backgroundColor={theme.surface}>
                <text fg={theme.foreground}>Owned inset</text>
              </box>
            </box>
          </box>,
          { width: 60, height: 12 },
        )
        await setup.flush()
      })
      try {
        await setup.renderOnce()
        const frame = setup.captureSpans()
        const spans = frame.lines.flatMap((line) => line.spans)
        const main = spans.find((span) =>
          span.text.includes('Retained terminal'),
        )!
        const inset = spans.find((span) => span.text.includes('Owned inset'))!
        expect(main.bg.toInts()).toEqual([...rgb(terminalBackground), 255])
        expect(inset.bg.toInts()).toEqual([...rgb(theme.surface), 255])
        writeFileSync(
          capturePath(`${name}-non-black.txt`),
          setup.captureCharFrame(),
        )
        writeFileSync(
          capturePath(`${name}-non-black.json`),
          JSON.stringify(
            frame.lines.map((line) =>
              line.spans.map((span) => ({
                text: span.text,
                fg: span.fg.toInts(),
                bg: span.bg.toInts(),
              })),
            ),
            null,
            2,
          ),
        )
      } finally {
        await React.act(async () => setup.renderer.destroy())
      }
    }
  },
)

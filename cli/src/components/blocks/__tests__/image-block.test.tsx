import { beforeEach, describe, expect, mock, test } from 'bun:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { chatThemes } from '../../../utils/theme-system'

import type { ImageContentBlock } from '../../../types/chat'

// Collaborators are mocked so the native <image> branch and the metadata
// fallback branch can be driven per test (same mock.module-before-dynamic-
// import pattern as content-with-markdown.test.tsx). The inline-support flag
// is read during render, so per-test mutation is enough.
let inlineImageSupported = true

// bun's mock.module is registry-wide for the whole test process (afterAll
// mock.restore does not undo it), so capture the REAL terminal-images module
// first. The `?real` query bypasses the registry so a previously leaked mock
// cannot shadow the real module. Spreading keeps parseDa1ImageCapability and
// every other export alive for terminal-images.test.ts later in this process.
const realTerminalImagesModule = (await import(
  '../../../utils/terminal-images?real' as string
)) as unknown as typeof import('../../../utils/terminal-images')

mock.module('../../../utils/terminal-images', () => ({
  // Real exports first (registry-wide leak guard); the two overrides below
  // must keep winning.
  ...realTerminalImagesModule,
  supportsInlineImages: () => inlineImageSupported,
  getImageSupportDescription: () =>
    inlineImageSupported ? 'stub inline images' : 'No inline image support',
}))

// The `?real` capture + spread + delegate pattern: a factory with ONLY the
// constant stub dropped every real export of image-display and pinned
// calculateDisplaySize to {width:40,height:12} process-wide, breaking
// image-dimensions.test.ts later in the same run (Expected <= 20, Received 40).
const realImageDisplayModule = (await import(
  '../../../utils/image-display?real' as string
)) as unknown as typeof import('../../../utils/image-display')

let mockDisplaySize:
  | { width: number; height: number }
  | undefined

mock.module('../../../utils/image-display', () => ({
  // Real exports first (registry-wide leak guard); this suite's assertions do
  // not depend on the stub, so delegation is unconditional.
  ...realImageDisplayModule,
  calculateDisplaySize: (
    input: Parameters<
      typeof realImageDisplayModule.calculateDisplaySize
    >[0],
  ) =>
    mockDisplaySize ?? realImageDisplayModule.calculateDisplaySize(input),
}))

mock.module('../../../hooks/use-theme', () => ({
  // A complete real theme, not a partial stub: bun's mock.module is global to
  // the test process, so later test files that render theme-consuming
  // components (DiffViewer reads theme.name via DIFF_LINE_COLORS) would
  // otherwise crash on undefined fields. Mirrors the plan-box.test.tsx pattern.
  useTheme: () => chatThemes.dark,
  initializeThemeStore: () => {},
}))

const { ImageBlock } = await import('../image-block')

const makeBlock = (
  overrides: Partial<ImageContentBlock> = {},
): ImageContentBlock => ({
  type: 'image',
  // base64 for "hello"
  image: 'aGVsbG8=',
  mediaType: 'image/png',
  filename: 'photo.png',
  size: 2048,
  width: 640,
  height: 480,
  ...overrides,
})

describe('ImageBlock', () => {
  beforeEach(() => {
    inlineImageSupported = true
  })

  test('renders the native <image> renderable with a data-URI source when inline images are supported', () => {
    const markup = renderToStaticMarkup(
      <ImageBlock block={makeBlock()} availableWidth={80} />,
    )

    // D47 Stage 4: the raw escape-sequence emission is replaced by the
    // 0.5.12 native <image> renderable, sourced from the block's base64
    // data via a data URI (ImageSource accepts string) and auto protocol.
    expect(markup).toContain('<image')
    expect(markup).toContain('data:image/png;base64,aGVsbG8=')
    expect(markup).toContain('protocol="auto"')
    // Caption metadata still renders alongside the native image.
    expect(markup).toContain('photo.png')
    expect(markup).toContain('2.0KB')
    // No metadata fallback card in this branch.
    expect(markup).not.toContain('Image attachment')
  })

  test('falls back to the metadata card when the terminal has no inline image support', () => {
    inlineImageSupported = false

    const markup = renderToStaticMarkup(
      <ImageBlock block={makeBlock()} availableWidth={80} />,
    )

    expect(markup).toContain('Image attachment')
    expect(markup).not.toContain('<image')
    expect(markup).toContain('No inline image support')
  })

  test('shows the redaction note instead of an image when image data is omitted', () => {
    const markup = renderToStaticMarkup(
      <ImageBlock
        block={makeBlock({ image: '', imageRedacted: true })}
        availableWidth={80}
      />,
    )

    expect(markup).toContain('Image data omitted from saved chat state.')
    expect(markup).not.toContain('<image')
  })
})

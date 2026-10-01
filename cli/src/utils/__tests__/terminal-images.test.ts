import { describe, expect, test } from 'bun:test'

import { parseDa1ImageCapability } from '../terminal-images'

describe('parseDa1ImageCapability (P1-T7 DA1/XTGETTCAP)', () => {
  test('reports sixel when DA1 attribute 4 is present', () => {
    // DA1 with attributes 1,2,4,6 → attribute 4 = sixel graphics.
    expect(parseDa1ImageCapability('\x1b[?1;2;4;6c')).toBe('sixel')
  })

  test('reports none for a DA1 response without sixel/image attributes', () => {
    expect(parseDa1ImageCapability('\x1b[?1;2c')).toBe('none')
  })

  test('reports kitty when the probe response carries the kitty marker', () => {
    expect(parseDa1ImageCapability('\x1b[?1;2c kitty graphics')).toBe('kitty')
  })

  test('reports iterm2 when the probe response carries the iTerm marker', () => {
    expect(parseDa1ImageCapability('\x1b[?1;2c iTerm2')).toBe('iterm2')
  })

  test('reports none for an empty/unparseable response', () => {
    expect(parseDa1ImageCapability('')).toBe('none')
    expect(parseDa1ImageCapability('no-params-here')).toBe('none')
  })

  test('never throws on malformed input', () => {
    expect(() => parseDa1ImageCapability('\x1b[???')).not.toThrow()
    // @ts-expect-error - deliberately non-string to prove fail-closed
    expect(parseDa1ImageCapability(null)).toBe('none')
  })
})

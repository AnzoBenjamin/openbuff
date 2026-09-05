import { describe, expect, test } from 'bun:test'

import {
  IMAGE_EXTENSION_TO_MIME,
  detectImageMediaTypeFromBytes,
} from '../constants/images'

/** Buffer holding `signature` at `offset`, zero-padded before it. */
function withSignature(offset: number, signature: number[]): Buffer {
  const buffer = Buffer.alloc(offset + signature.length)
  Buffer.from(signature).copy(buffer, offset)
  return buffer
}

describe('detectImageMediaTypeFromBytes', () => {
  test('recognizes every supported signature', () => {
    expect(
      detectImageMediaTypeFromBytes(
        withSignature(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      ),
    ).toBe('image/png')
    expect(
      detectImageMediaTypeFromBytes(withSignature(0, [0xff, 0xd8, 0xff])),
    ).toBe('image/jpeg')
    // "GIF8" covers GIF87a and GIF89a alike.
    expect(detectImageMediaTypeFromBytes(Buffer.from('GIF89a', 'ascii'))).toBe(
      'image/gif',
    )
    expect(detectImageMediaTypeFromBytes(Buffer.from('GIF87a', 'ascii'))).toBe(
      'image/gif',
    )
    expect(detectImageMediaTypeFromBytes(Buffer.from('BMxx', 'ascii'))).toBe(
      'image/bmp',
    )
  })

  test('requires the WEBP form tag at offset 8, not just the RIFF prefix', () => {
    const webp = Buffer.concat([
      Buffer.from('RIFF', 'ascii'),
      Buffer.alloc(4),
      Buffer.from('WEBP', 'ascii'),
    ])
    expect(detectImageMediaTypeFromBytes(webp)).toBe('image/webp')

    // RIFF also fronts WAV and AVI, so a prefix-only check would misreport
    // audio as an image.
    const wav = Buffer.concat([
      Buffer.from('RIFF', 'ascii'),
      Buffer.alloc(4),
      Buffer.from('WAVE', 'ascii'),
    ])
    expect(detectImageMediaTypeFromBytes(wav)).toBeNull()
  })

  test('accepts TIFF in both byte orders', () => {
    expect(
      detectImageMediaTypeFromBytes(withSignature(0, [0x49, 0x49, 0x2a, 0x00])),
    ).toBe('image/tiff')
    expect(
      detectImageMediaTypeFromBytes(withSignature(0, [0x4d, 0x4d, 0x00, 0x2a])),
    ).toBe('image/tiff')
  })

  test('returns null for short buffers instead of throwing', () => {
    // A truncated PNG header shares a prefix with the real signature, so an
    // unguarded read would compare against undefined bytes.
    expect(detectImageMediaTypeFromBytes(Buffer.alloc(0))).toBeNull()
    expect(
      detectImageMediaTypeFromBytes(Buffer.from([0x89, 0x50, 0x4e])),
    ).toBeNull()
    expect(detectImageMediaTypeFromBytes(Buffer.from('RIFF', 'ascii'))).toBeNull()
    expect(detectImageMediaTypeFromBytes(Buffer.from([0x49, 0x49]))).toBeNull()
  })

  test('returns null for plain text wearing no signature', () => {
    expect(
      detectImageMediaTypeFromBytes(
        Buffer.from('just some plain text, definitely not an image'),
      ),
    ).toBeNull()
  })

  test('accepts a Uint8Array as well as a Buffer', () => {
    expect(
      detectImageMediaTypeFromBytes(
        new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      ),
    ).toBe('image/png')
  })

  test('only ever returns MIME strings the extension map already publishes', () => {
    // The two sources must not disagree: a sniffed type that is not in the map
    // would be announced to a provider under a name the extension path can
    // never produce.
    const published = new Set(Object.values(IMAGE_EXTENSION_TO_MIME))
    const detected = [
      withSignature(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      withSignature(0, [0xff, 0xd8, 0xff]),
      Buffer.from('GIF89a', 'ascii'),
      Buffer.from('BMxx', 'ascii'),
      Buffer.concat([
        Buffer.from('RIFF', 'ascii'),
        Buffer.alloc(4),
        Buffer.from('WEBP', 'ascii'),
      ]),
      withSignature(0, [0x49, 0x49, 0x2a, 0x00]),
    ].map((bytes) => detectImageMediaTypeFromBytes(bytes))

    expect(detected.every((mime) => mime !== null)).toBe(true)
    for (const mime of detected) {
      expect(published.has(mime!)).toBe(true)
    }
  })
})

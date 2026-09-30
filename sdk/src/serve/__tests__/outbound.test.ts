import { describe, expect, test } from 'bun:test'

import { createProviderPresetConfig } from '../../provider-config'

import {
  OutboundHoldback,
  collectCredentialValues,
  getConfiguredCredentialEnvKeys,
  holdbackSizeFor,
  sanitizeOutboundStream,
} from '../outbound'

/**
 * Regression coverage for the §12.8 NEW-3/NEW-4 streaming guards:
 * - GV-27 (RF-11): no configured credential or cap.v3 token is ever SPLIT
 *   across emitted frames — neither on the progressive path, the
 *   MAX_HELD_WINDOW_CHARS overflow path, nor across a flush boundary — and
 *   configured credentials are redacted by VALUE even without a
 *   provider-secret shape.
 * - RF-12: flush routing is session-scoped — flushSession/flushIdleSession
 *   never release another session's held text.
 * - GV-28: the ndJsonStream chokepoint sanitizes every serialized frame.
 */

const CREDENTIAL = 'QQUNIQQMARKERVALUEQQ'
/** Interior fragments that would betray a split credential. */
const CREDENTIAL_FRAGMENTS = ['QQUNIQQ', 'MARKERVALUEQQ']

describe('OutboundHoldback no-split invariant (GV-27 / RF-11)', () => {
  test('a credential straddling chunk boundaries is never emitted raw', () => {
    const hb = new OutboundHoldback()
    const pieces: string[] = []
    pieces.push(...hb.push('s', 'm', 'before ', [CREDENTIAL], 0))
    pieces.push(...hb.push('s', 'm', CREDENTIAL, [CREDENTIAL], 1))
    pieces.push(...hb.push('s', 'm', ' after', [CREDENTIAL], 2))
    pieces.push(...hb.flush('s', 'm', 3))
    const all = pieces.join('')
    expect(all).not.toContain(CREDENTIAL)
    for (const fragment of CREDENTIAL_FRAGMENTS) {
      expect(all).not.toContain(fragment)
    }
    expect(all).toContain('before ')
    expect(all).toContain(' after')
  })

  test('a configured credential is redacted by VALUE even without a provider-secret shape', () => {
    const hb = new OutboundHoldback()
    const pieces = hb.push(
      's',
      'm',
      'x '.repeat(200) + CREDENTIAL,
      [CREDENTIAL],
      0,
    )
    pieces.push(...hb.flush('s', 'm', 1))
    const all = pieces.join('')
    expect(all).toContain('[REDACTED_SECRET]')
    expect(all).not.toContain(CREDENTIAL)
  })

  test('the MAX_HELD_WINDOW_CHARS overflow path never splits a credential', () => {
    const hb = new OutboundHoldback()
    // Position the credential so the naive overflow cut (held.length -
    // holdback) would land INSIDE it: without the safe-cut walk the first
    // frame would carry a prefixless fragment the redaction regexes cannot
    // match (the exact overflow split the reviewer finding describes).
    const filler = 'h'.repeat(65335)
    const tail = 't'.repeat(243)
    const pieces = hb.push('s', 'm', filler + CREDENTIAL + tail, [CREDENTIAL], 0)
    expect(pieces.length).toBeGreaterThan(0)
    const all = pieces.join('')
    expect(all).not.toContain(CREDENTIAL)
    for (const fragment of CREDENTIAL_FRAGMENTS) {
      expect(all).not.toContain(fragment)
    }
    // The remainder flushes whole and clean.
    const rest = hb.flush('s', 'm', 1).join('')
    expect(rest).not.toContain(CREDENTIAL)
    expect(all + rest).toContain(tail)
  })

  test('a cap.v3 token straddling the cut is held whole and redacted in one frame', () => {
    const hb = new OutboundHoldback()
    const token = 'cap.v3.1.2.' + 'B'.repeat(50)
    const pieces: string[] = []
    pieces.push(
      ...hb.push('s', 'm', 'f'.repeat(100) + token.slice(0, 30), [], 0),
    )
    pieces.push(...hb.push('s', 'm', token.slice(30) + 'g'.repeat(200), [], 1))
    pieces.push(...hb.flush('s', 'm', 2))
    const all = pieces.join('')
    expect(all).toContain('[REDACTED_CAPABILITY]')
    expect(all).not.toMatch(/cap\.v3\.[A-Za-z0-9._-]{4,}/)
  })
})

describe('OutboundHoldback session-scoped flush routing (RF-12)', () => {
  test('flushSession releases only the owning session and leaves others held', () => {
    const hb = new OutboundHoldback()
    hb.push('sA', 'm1', 'alpha-text', [], 0)
    hb.push('sB', 'm1', 'beta-text', [], 0)
    expect(hb.flushSession('sA', 1).join('')).toBe('alpha-text')
    // sB is untouched: its window is still held and flushes on its own turn.
    expect(hb.flush('sB', 'm1', 2).join('')).toBe('beta-text')
  })

  test('flushIdleSession releases only the owning session idle windows', () => {
    const hb = new OutboundHoldback()
    hb.push('sA', 'm1', 'idle-a', [], 0)
    hb.push('sB', 'm1', 'fresh-b', [], 500)
    expect(hb.flushIdleSession('sA', 1000, 250).join('')).toBe('idle-a')
    expect(hb.flush('sB', 'm1', 1001).join('')).toBe('fresh-b')
  })
})

describe('sanitizeOutboundStream chokepoint (GV-28)', () => {
  test('redacts a cap.v3 token inside a serialized frame', async () => {
    const chunks: Uint8Array[] = []
    const target = new WritableStream<Uint8Array>({
      write(chunk) {
        chunks.push(chunk)
      },
    })
    const wrapped = sanitizeOutboundStream(target)
    const writer = wrapped.getWriter()
    await writer.write(
      new TextEncoder().encode('{"x":"cap.v3.1.2.AAAA.BBBB"}\n'),
    )
    await writer.close()
    const out = new TextDecoder().decode(concatChunks(chunks))
    expect(out).toContain('[REDACTED_CAPABILITY]')
    expect(out).not.toContain('cap.v3.')
  })

  test('forwards frames without redactable text byte-identically', async () => {
    const chunks: Uint8Array[] = []
    const target = new WritableStream<Uint8Array>({
      write(chunk) {
        chunks.push(chunk)
      },
    })
    const wrapped = sanitizeOutboundStream(target)
    const writer = wrapped.getWriter()
    const frame = new TextEncoder().encode('{"ok":true}\n')
    await writer.write(frame)
    await writer.close()
    expect(chunks).toEqual([frame])
  })
})

function concatChunks(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

describe('collectCredentialValues (NEW-3 host seam)', () => {
  test('emits KEY=value pairs and bare values for the well-known credential env keys', () => {
    // An explicit configured-key list keeps this test hermetic (no ambient
    // provider-config read); the configured-surface path is covered below.
    expect(
      collectCredentialValues(
        {
          OPENROUTER_API_KEY: 'sk-or-1',
          ANTHROPIC_API_KEY: 'sk-ant-1',
          OPENAI_API_KEY: 'sk-oai-1',
        },
        [],
      ),
    ).toEqual([
      'OPENROUTER_API_KEY=sk-or-1',
      'sk-or-1',
      'ANTHROPIC_API_KEY=sk-ant-1',
      'sk-ant-1',
      'OPENAI_API_KEY=sk-oai-1',
      'sk-oai-1',
    ])
  })

  test('skips absent and empty values, and ignores non-credential keys', () => {
    expect(collectCredentialValues({}, [])).toEqual([])
    expect(
      collectCredentialValues(
        {
          OPENROUTER_API_KEY: undefined,
          ANTHROPIC_API_KEY: '',
          OPENAI_API_KEY: 'sk-only',
          SOME_OTHER_SECRET: 'not-a-configured-credential',
        },
        [],
      ),
    ).toEqual(['OPENAI_API_KEY=sk-only', 'sk-only'])
  })

  test('collects values for configured provider-config apiKeyEnv keys (NEW-3)', () => {
    // The provider configuration surface (providers.json apiKeyEnv, built-in
    // presets) declares credential env keys beyond the well-known three; the
    // no-split invariant must cover those too.
    expect(
      collectCredentialValues({ MY_PROVIDER_KEY: 'sk-custom-value-1' }, [
        'MY_PROVIDER_KEY',
      ]),
    ).toEqual(['MY_PROVIDER_KEY=sk-custom-value-1', 'sk-custom-value-1'])
    // A configured key already covered by the well-known list is not doubled.
    expect(
      collectCredentialValues({ OPENAI_API_KEY: 'sk-1' }, ['OPENAI_API_KEY']),
    ).toEqual(['OPENAI_API_KEY=sk-1', 'sk-1'])
  })

  test('getConfiguredCredentialEnvKeys reads the built-in preset provider surface', () => {
    const presetConfig = createProviderPresetConfig('opencode-go')
    expect(
      getConfiguredCredentialEnvKeys({}, {
        config: presetConfig,
        sourceFilePaths: [],
      }),
    ).toContain('OPENCODE_GO_API_KEY')

    // A preset whose providers declare no apiKeyEnv yields no configured keys.
    const ollamaConfig = createProviderPresetConfig('ollama')
    expect(
      getConfiguredCredentialEnvKeys({}, {
        config: ollamaConfig,
        sourceFilePaths: [],
      }),
    ).toEqual([])
  })
})

describe('holdbackSizeFor (NEW-3 window sizing)', () => {
  test('uses the 256-char floor with no credentials and widens to the longest value', () => {
    expect(holdbackSizeFor([])).toBe(256)
    expect(holdbackSizeFor(['sk-a'])).toBe(256)
    expect(holdbackSizeFor(['x'.repeat(300)])).toBe(300)
  })
})

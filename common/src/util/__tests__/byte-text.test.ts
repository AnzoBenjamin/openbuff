import { describe, expect, test } from 'bun:test'

import {
  captureTextDocument,
  getRawLineSpan,
  getRawReadBasis,
  observationUtf16ToRawByte,
  observationUtf16ToUtf8,
  rawByteToObservationUtf16,
  reanchorRawReadCapability,
  spliceDocumentObservation,
  spliceDocumentRange,
  utf8ToObservationUtf16,
} from '../byte-text'
import {
  decodeReadCapabilityToken,
  encodeReadCapabilityToken,
  getContentHash,
  getExactContentHash,
} from '../content-hash'
import { parseRawReadBasis, rawReadBasesMatch } from '../raw-read-basis'

import type { ReplacementReadCapability } from '../content-hash'
import type { RawReadBasisV1 } from '../raw-read-basis'

const scope = { projectId: '/byte-fixture', path: 'file.ts', runId: 'byte-run' }

function observedCapability(
  content: string,
  startLine: number,
  endLine: number,
  kind: RawReadBasisV1['scope'] = 'lines',
): ReplacementReadCapability {
  const document = captureTextDocument(content)
  const span = getRawLineSpan(document, startLine, endLine)
  const token = encodeReadCapabilityToken({
    startLine,
    endLine,
    scope,
    hash: getContentHash(
      document.observation.slice(
        span.startObservationOffset,
        span.endObservationOffset,
      ),
    ),
    rawBasis: getRawReadBasis(document, startLine, endLine, kind),
  })
  const decoded = decodeReadCapabilityToken(token)
  if (typeof decoded === 'string') throw new Error(decoded)
  return decoded
}

describe('captured UTF-8 bytes and coordinates', () => {
  for (const bom of ['', '\uFEFF']) {
    for (const eol of ['\n', '\r\n', '\r\nnext\n']) {
      for (const final of ['', '\n']) {
        test(`lossless round trip ${JSON.stringify({ bom, eol, final })}`, () => {
          const raw = bom + 'a😀e\u0301' + eol + 'tail\rcontent' + final
          const document = captureTextDocument(Buffer.from(raw))
          expect(Buffer.from(document.rawText).toString('hex')).toBe(
            Buffer.from(raw).toString('hex'),
          )
          expect(document.rawHash).toBe(getExactContentHash(raw))
          expect(document.observation).toBe(
            raw.slice(bom.length).replaceAll('\r\n', '\n'),
          )
          expect(document.observationHash).toBe(
            getContentHash(document.observation),
          )
        })
      }
    }
  }

  test('BOM and UTF-16/UTF-8 boundaries remain distinct', () => {
    const document = captureTextDocument('\uFEFFa😀b\r\nc')
    expect(observationUtf16ToRawByte(document, 1)).toBe(4)
    expect(observationUtf16ToRawByte(document, 3)).toBe(8)
    expect(observationUtf16ToRawByte(document, 5)).toBe(11)
    expect(observationUtf16ToUtf8(document, 3)).toBe(5)
    expect(rawByteToObservationUtf16(document, 8)).toBe(3)
    expect(utf8ToObservationUtf16(document, 5)).toBe(3)
    expect(() => observationUtf16ToRawByte(document, 2)).toThrow('scalar')
    expect(() => rawByteToObservationUtf16(document, 5)).toThrow('scalar')
    expect(() => rawByteToObservationUtf16(document, 10)).toThrow('terminator')
    expect(() => rawByteToObservationUtf16(document, 1)).toThrow('BOM')
  })

  test('a later slice-leading U+FEFF remains content', () => {
    const document = captureTextDocument(Buffer.from('\uFEFFcontent'), {
      includesBom: false,
    })
    expect(document.bomBytes).toBe(0)
    expect(document.observation).toBe('\uFEFFcontent')
    expect(observationUtf16ToRawByte(document, 1)).toBe(3)
  })

  test('visible and final-empty capability ceilings remain separate', () => {
    for (const [raw, visible, maximum] of [
      ['', 0, 1],
      ['\uFEFF', 0, 1],
      ['a\n', 1, 2],
      ['a', 1, 1],
      ['a\r\nb\n', 2, 3],
    ] as const) {
      const document = captureTextDocument(raw)
      expect(document.visibleLineCount).toBe(visible)
      expect(document.maxCapabilityLine).toBe(maximum)
      expect(spliceDocumentRange(document, maximum, maximum, 'last')).toBe(
        raw.endsWith('\n')
          ? raw + 'last'
          : raw.startsWith('\uFEFF')
            ? '\uFEFFlast'
            : 'last',
      )
    }
  })

  test('localized line and occurrence spans preserve BOM and every outside byte', () => {
    const raw = '\uFEFFfirst\r\nold\nlast\r\n'
    const document = captureTextDocument(raw)
    expect(spliceDocumentRange(document, 2, 2, 'new\nmore')).toBe(
      '\uFEFFfirst\r\nnew\nmore\nlast\r\n',
    )
    expect(spliceDocumentRange(document, 1, 1, 'new')).toBe(
      '\uFEFFnew\r\nold\nlast\r\n',
    )
    const start = document.observation.indexOf('old')
    expect(spliceDocumentObservation(document, start, start + 3, 'new')).toBe(
      '\uFEFFfirst\r\nnew\nlast\r\n',
    )
    const scalar = captureTextDocument('\uFEFFa😀b\r\n')
    expect(spliceDocumentObservation(scalar, 1, 3, '🙂')).toBe('\uFEFFa🙂b\r\n')
    expect(() => spliceDocumentObservation(scalar, 1, 2, 'x')).toThrow('scalar')
  })

  test('invalid UTF-8 and lossy surrogate strings refuse capture', () => {
    expect(() => captureTextDocument(new Uint8Array([0xc0, 0xaf]))).toThrow()
    expect(() => captureTextDocument('\ud800')).toThrow('surrogate')
    expect(() => captureTextDocument('\udc00')).toThrow('surrogate')
  })
})

describe('authenticated raw read basis', () => {
  test('v4 carries its exact original raw basis, and tampering refuses', () => {
    const document = captureTextDocument('\uFEFFa\r\nb\n')
    const basis = getRawReadBasis(
      document,
      1,
      document.maxCapabilityLine,
      'whole',
    )
    const token = encodeReadCapabilityToken({
      startLine: 1,
      endLine: document.maxCapabilityLine,
      hash: document.observationHash,
      scope,
      rawBasis: basis,
    })
    expect(token.startsWith('cap.v4.')).toBe(true)
    const decoded = decodeReadCapabilityToken(token)
    expect(typeof decoded).toBe('object')
    if (typeof decoded === 'string') return
    expect(rawReadBasesMatch(decoded.rawBasis, basis)).toBe(true)
    expect(decoded.hash).toBe(document.observationHash)
    const parts = token.split('.')
    const payload = JSON.parse(Buffer.from(parts[2]!, 'base64url').toString())
    payload.rawBasis.includesBom = false
    parts[2] = Buffer.from(JSON.stringify(payload)).toString('base64url')
    expect(typeof decodeReadCapabilityToken(parts.join('.'))).toBe('string')
  })

  test('legacy normalized capabilities parse but supply no raw edit authority', () => {
    const token = encodeReadCapabilityToken({
      startLine: 1,
      endLine: 1,
      hash: getContentHash('a'),
      scope,
    })
    const capability = decodeReadCapabilityToken(token)
    expect(typeof capability).toBe('object')
    if (typeof capability === 'string') return
    expect(reanchorRawReadCapability({ content: 'a', capability })).toEqual({
      ok: false,
      reason: 'missing_raw_basis',
    })
  })

  test('whole basis rejects BOM, EOL and final-terminator-only drift', () => {
    const raw = '\uFEFFa\r\nb\n'
    const capability = observedCapability(raw, 1, 3, 'whole')
    expect(reanchorRawReadCapability({ content: raw, capability }).ok).toBe(
      true,
    )
    for (const changed of [
      raw.slice(1),
      raw.replaceAll('\r\n', '\n'),
      raw.slice(0, -1),
    ]) {
      expect(
        reanchorRawReadCapability({ content: changed, capability }),
      ).toEqual({ ok: false, reason: 'raw_changed' })
    }
  })

  test('whole basis accepts genuine visible-ceiling coverage with its range hash', () => {
    const raw = 'a\r\nb\n'
    const capability = observedCapability(raw, 1, 2, 'whole')
    expect(reanchorRawReadCapability({ content: raw, capability })).toEqual({
      ok: true,
      startLine: 1,
      endLine: 2,
    })
  })

  test('scoped basis relocates unchanged bytes and rejects in-scope raw-only drift', () => {
    const raw = 'first\r\ntarget\r\nlast\n'
    const capability = observedCapability(raw, 2, 2)
    expect(
      reanchorRawReadCapability({ content: 'new\n' + raw, capability }),
    ).toEqual({ ok: true, startLine: 3, endLine: 3, shiftedBy: 1 })
    expect(
      reanchorRawReadCapability({
        content: raw.replace('target\r\n', 'target\n'),
        capability,
      }).ok,
    ).toBe(false)
  })

  test('outside-scope BOM changes do not widen the selected raw basis', () => {
    const raw = '\uFEFFfirst\nselected\nlast'
    const capability = observedCapability(raw, 2, 2)
    expect(
      reanchorRawReadCapability({ content: raw.slice(1), capability }),
    ).toEqual({ ok: true, startLine: 2, endLine: 2 })
    const first = observedCapability(raw, 1, 1)
    expect(
      reanchorRawReadCapability({ content: raw.slice(1), capability: first })
        .ok,
    ).toBe(false)
  })

  test('a duplicate inserted at the old position refuses after document drift', () => {
    const raw = 'top\ntarget\nend\n'
    const capability = observedCapability(raw, 2, 2)
    expect(
      reanchorRawReadCapability({
        content: 'top\ntarget\ntarget\nend\n',
        capability,
      }),
    ).toEqual({ ok: false, reason: 'ambiguous', matchCount: 2 })
  })

  test('unchanged documents keep an explicitly observed location despite other duplicates', () => {
    const raw = 'top\ntarget\ntarget\nend\n'
    const capability = observedCapability(raw, 2, 2)
    expect(reanchorRawReadCapability({ content: raw, capability })).toEqual({
      ok: true,
      startLine: 2,
      endLine: 2,
    })
  })

  test('over-budget drift never accepts a matching old-position prefix', () => {
    const raw = 'first\ntarget\n'
    const capability = observedCapability(raw, 1, 2)
    const changed = raw + '\n'.repeat(1_000_001) + raw
    expect(reanchorRawReadCapability({ content: changed, capability })).toEqual(
      { ok: false, reason: 'over_budget' },
    )
  })

  test('streamed basis construction rejects unknown authority fields and incomplete whole bounds', () => {
    const document = captureTextDocument('text\n')
    const basis = getRawReadBasis(document, 1, 2, 'whole')
    expect(() => parseRawReadBasis({ ...basis, admitted: true })).toThrow()
    expect(() => parseRawReadBasis({ ...basis, endByteExclusive: 2 })).toThrow()
  })

  test('contradictory signed byte facts never validate against actual source', () => {
    const raw = '\uFEFFa\r\nb\n'
    const scoped = observedCapability(raw, 2, 2)
    const signBasis = (
      capability: ReplacementReadCapability,
      rawBasis: RawReadBasisV1,
    ) => {
      const token = encodeReadCapabilityToken({
        startLine: capability.startLine,
        endLine: capability.endLine,
        hash: capability.hash,
        scope,
        rawBasis,
      })
      const decoded = decodeReadCapabilityToken(token)
      if (typeof decoded === 'string') throw new Error(decoded)
      return decoded
    }
    expect(() =>
      parseRawReadBasis({
        ...scoped.rawBasis!,
        startByte: 1,
        endByteExclusive: 2,
      }),
    ).toThrow()
    expect(() =>
      signBasis(scoped, {
        ...scoped.rawBasis!,
        startByte: 1,
        endByteExclusive: 2,
      }),
    ).toThrow()
    expect(
      reanchorRawReadCapability({
        content: raw,
        capability: signBasis(scoped, {
          ...scoped.rawBasis!,
          documentBytes: 99,
        }),
      }).ok,
    ).toBe(false)
    const whole = observedCapability(raw, 1, 3, 'whole')
    for (const rawBasis of [
      { ...whole.rawBasis!, documentBom: 'none' as const, includesBom: false },
      { ...whole.rawBasis!, endTerminator: 'none' as const },
    ]) {
      expect(
        reanchorRawReadCapability({
          content: raw,
          capability: signBasis(whole, rawBasis),
        }).ok,
      ).toBe(false)
    }
    expect(
      reanchorRawReadCapability({
        content: 'prefix\n' + raw,
        capability: signBasis(scoped, {
          ...scoped.rawBasis!,
          documentBytes: scoped.rawBasis!.documentBytes + 1,
          endByteExclusive: scoped.rawBasis!.endByteExclusive + 1,
        }),
      }).ok,
    ).toBe(false)
  })

  test('generation byte limits prevent minting an undecodable v4 token', () => {
    const document = captureTextDocument('a')
    const basis = getRawReadBasis(document, 1, 1, 'whole')
    expect(() =>
      encodeReadCapabilityToken({
        startLine: 1,
        endLine: 1,
        hash: document.observationHash,
        scope,
        rawBasis: { ...basis, generation: '雪'.repeat(1024) },
      }),
    ).toThrow()
    const token = encodeReadCapabilityToken({
      startLine: 1,
      endLine: 1,
      hash: document.observationHash,
      scope,
      rawBasis: { ...basis, generation: '雪'.repeat(300) },
    })
    expect(token.length).toBeLessThanOrEqual(4096)
    expect(typeof decodeReadCapabilityToken(token)).toBe('object')
  })
})

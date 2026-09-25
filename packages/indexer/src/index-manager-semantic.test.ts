import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { afterAll, describe, expect, test } from 'bun:test'

import { IndexManager } from './index-manager'

import type { EmbedFn } from './semantic'
import type { MetadataIndex } from './types'

const VOCAB = ['auth', 'login', 'token', 'payment', 'invoice', 'charge']
const fakeEmbed: EmbedFn = async (texts) =>
  texts.map((t) => {
    const lower = t.toLowerCase()
    return VOCAB.map((w) => (lower.includes(w) ? 1 : 0))
  })

const roots: string[] = []
function makeProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'openbuff-semantic-'))
  roots.push(root)
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(
    join(root, 'src', 'auth.ts'),
    'export function loginUser() {}\nexport function authToken() {}\n',
  )
  writeFileSync(
    join(root, 'src', 'payment.ts'),
    'export function chargeInvoice() {}\nexport function makePayment() {}\n',
  )
  return root
}

afterAll(() => {
  for (const root of roots) {
    try {
      rmSync(root, { recursive: true, force: true })
    } catch {
      // best-effort cleanup
    }
  }
})

describe('IndexManager semantic integration', () => {
  test('reuses persisted vectors across manager instances and fingerprints by model', async () => {
    const root = makeProject()
    let firstEmbeddedTexts = 0
    const firstEmbed: EmbedFn = async (texts) => {
      firstEmbeddedTexts += texts.length
      return fakeEmbed(texts)
    }
    const first = IndexManager.getInstance(
      root,
      { semantic: { enabled: true, model: 'embedding-v1' } },
      firstEmbed,
    )
    await first.waitUntilReady(10_000)
    expect(firstEmbeddedTexts).toBeGreaterThan(0)

    let cachedEmbeddedTexts = 0
    const cachedEmbed: EmbedFn = async (texts) => {
      cachedEmbeddedTexts += texts.length
      return fakeEmbed(texts)
    }
    // A query-time weight creates a distinct manager while retaining the same
    // semantic fingerprint, simulating a fresh process over the same cache.
    const cached = IndexManager.getInstance(
      root,
      {
        semantic: { enabled: true, model: 'embedding-v1' },
        weights: { semanticBlend: 0.5 },
      },
      cachedEmbed,
    )
    await cached.waitUntilReady(10_000)
    expect(cached.isSemanticReady()).toBe(true)
    expect(cachedEmbeddedTexts).toBe(0)

    let changedModelEmbeddedTexts = 0
    const changedModelEmbed: EmbedFn = async (texts) => {
      changedModelEmbeddedTexts += texts.length
      return fakeEmbed(texts)
    }
    const changedModel = IndexManager.getInstance(
      root,
      { semantic: { enabled: true, model: 'embedding-v2' } },
      changedModelEmbed,
    )
    await changedModel.waitUntilReady(10_000)
    expect(changedModelEmbeddedTexts).toBeGreaterThan(0)
  })

  test('builds vectors and ranks files by semantic similarity', async () => {
    const root = makeProject()
    const mgr = IndexManager.getInstance(
      root,
      { semantic: { enabled: true } },
      fakeEmbed,
    )
    await mgr.waitUntilReady(10_000)

    expect(mgr.isSemanticReady()).toBe(true)
    const hits = await mgr.searchSemantic('user login auth token', 5)
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0].path).toContain('auth')
  })

  test('searchSemantic returns [] when semantic is disabled', async () => {
    const root = makeProject()
    const mgr = IndexManager.getInstance(
      root,
      { semantic: { enabled: false } },
      fakeEmbed,
    )
    await mgr.waitUntilReady(10_000)
    expect(mgr.isSemanticReady()).toBe(false)
    expect(await mgr.searchSemantic('anything')).toEqual([])
  })

  test('queryBlended folds semantic hits into the ranking', async () => {
    const root = makeProject()
    const mgr = IndexManager.getInstance(
      root,
      { semantic: { enabled: true } },
      fakeEmbed,
    )
    await mgr.waitUntilReady(10_000)

    const blended = await mgr.queryBlended('user login auth token', {
      limit: 5,
    })
    expect(blended.ready).toBe(true)
    expect(blended.results[0].path).toContain('auth')
    // A purely-semantic hit carries the 'semantic' matchedOn marker.
    const authHit = blended.results.find((r) => r.path.includes('auth'))!
    expect(authHit.matchedOn.length).toBeGreaterThan(0)
  })

  test('queryBlended applies fileTypes to semantic-only candidates', async () => {
    const root = makeProject()
    writeFileSync(
      join(root, 'secret-topic.md'),
      '# Database internals\n\ndatabase database database\n',
    )
    const mgr = IndexManager.getInstance(
      root,
      { semantic: { enabled: true } },
      fakeEmbed,
    )
    await mgr.waitUntilReady(10_000)

    const blended = await mgr.queryBlended('database internals', {
      limit: 10,
      fileTypes: ['ts'],
    })
    expect(blended.results.every((result) => result.path.endsWith('.ts'))).toBe(
      true,
    )
    expect(blended.results.some((result) => result.path.endsWith('.md'))).toBe(
      false,
    )
  })

  test('queryBlended returns pure lexical results when semantic is off', async () => {
    const root = makeProject()
    const mgr = IndexManager.getInstance(
      root,
      { semantic: { enabled: false } },
      fakeEmbed,
    )
    await mgr.waitUntilReady(10_000)
    const blended = await mgr.queryBlended('auth', { limit: 5 })
    expect(blended.ready).toBe(true)
  })

  test('queryBlended threads config.weights.semanticBlend into ranking', async () => {
    // 'auth' is a lexical hit on auth.ts; 'repayment' embeds the 'payment' vocab
    // bit (payment.ts is a semantic hit) but does not lexically match any file
    // metadata — making payment.ts a purely-semantic result. semanticBlend=0
    // must nullify that semantic contribution.
    const rootZero = makeProject()
    const mgrZero = IndexManager.getInstance(
      rootZero,
      { semantic: { enabled: true }, weights: { semanticBlend: 0 } },
      fakeEmbed,
    )
    await mgrZero.waitUntilReady(10_000)
    expect(mgrZero.isSemanticReady()).toBe(true)

    const blendedZero = await mgrZero.queryBlended('auth repayment', {
      limit: 5,
    })
    expect(blendedZero.ready).toBe(true)
    const paymentZero = blendedZero.results.find((r) =>
      r.path.includes('payment'),
    )
    expect(paymentZero).toBeUndefined()

    // With the default blend weight (1), the same purely-semantic hit surfaces
    // with a nonzero score — proving the weight is actually threaded through.
    const rootDefault = makeProject()
    const mgrDefault = IndexManager.getInstance(
      rootDefault,
      { semantic: { enabled: true } },
      fakeEmbed,
    )
    await mgrDefault.waitUntilReady(10_000)

    const blendedDefault = await mgrDefault.queryBlended('auth repayment', {
      limit: 5,
    })
    const paymentDefault = blendedDefault.results.find((r) =>
      r.path.includes('payment'),
    )
    expect(paymentDefault).toBeDefined()
    expect(paymentDefault?.score).toBeGreaterThan(0)
  })

  test('config.weights.lexical is threaded into queries', async () => {
    // 'loginUser' matches auth.ts primarily via its defined symbol, so zeroing
    // the symbol weight removes the only signal ranking it.
    const rootZero = makeProject()
    const mgrZero = IndexManager.getInstance(
      rootZero,
      { weights: { lexical: { symbol: 0 } } },
      fakeEmbed,
    )
    await mgrZero.waitUntilReady(10_000)

    const rootDefault = makeProject()
    const mgrDefault = IndexManager.getInstance(rootDefault, {}, fakeEmbed)
    await mgrDefault.waitUntilReady(10_000)

    const zeroResults = mgrZero.query('loginUser', { limit: 5 })
    const defaultResults = mgrDefault.query('loginUser', { limit: 5 })

    const defaultAuthScore =
      defaultResults.results.find((r) => r.path.includes('auth'))?.score ?? 0
    const zeroAuthScore =
      zeroResults.results.find((r) => r.path.includes('auth'))?.score ?? 0

    expect(defaultAuthScore).toBeGreaterThan(0)
    expect(zeroAuthScore).toBeLessThan(defaultAuthScore)
  })

  test('queryBlended pins semantic-only metadata to the pre-await snapshot', async () => {
    const root = makeProject()
    // Armed just before the query so the embed call inside queryBlended's
    // semantic search simulates a concurrent refresh swapping this.index
    // mid-await (reliability finding queryblended-mixed-snapshot-metadata).
    let swapArmed = false
    let internal!: { index: MetadataIndex }
    const embed: EmbedFn = async (texts) => {
      if (swapArmed) {
        swapArmed = false
        const previous = internal.index
        internal.index = {
          ...previous,
          builtAt: previous.builtAt + 1,
          files: {
            ...previous.files,
            'src/payment.ts': {
              ...previous.files['src/payment.ts']!,
              hash: 'refreshed-payment-hash',
            },
          },
        }
      }
      return fakeEmbed(texts)
    }
    const mgr = IndexManager.getInstance(
      root,
      { semantic: { enabled: true } },
      embed,
    )
    await mgr.waitUntilReady(10_000)
    internal = mgr as unknown as { index: MetadataIndex }
    const originalPaymentHash = internal.index.files['src/payment.ts']!.hash
    const builtAtBefore = internal.index.builtAt

    swapArmed = true
    const blended = await mgr.queryBlended('auth repayment', { limit: 5 })

    // The semantic-only hit's metadata must come from the snapshot the
    // lexical half ran against, not from the concurrently swapped index.
    const payment = blended.results.find((r) => r.path === 'src/payment.ts')
    expect(payment).toBeDefined()
    expect(payment?.indexedHash).toBe(originalPaymentHash)
    // Snapshot identity must also stay consistent with the lexical results.
    expect(blended.snapshot?.builtAt).toBe(builtAtBefore)
  })

  test('rewires a changed embedder cacheKey instead of silently keeping the stale embedder', async () => {
    // Regression for the M4-S6 second-embedder finding: a runtime BYOK
    // provider swap must rewire the embedder and rebuild the semantic tier
    // under the new fingerprint, not silently keep the first embedder.
    const root = makeProject()
    let firstCalls = 0
    const first: EmbedFn = async (texts) => {
      firstCalls += texts.length
      return fakeEmbed(texts)
    }
    first.cacheKey = 'provider-a/model-a'
    const mgr = IndexManager.getInstance(
      root,
      { semantic: { enabled: true, model: 'embedding-v1' } },
      first,
    )
    await mgr.waitUntilReady(10_000)
    expect(firstCalls).toBeGreaterThan(0)
    expect(mgr.isSemanticReady()).toBe(true)

    let secondCalls = 0
    const second: EmbedFn = async (texts) => {
      secondCalls += texts.length
      return fakeEmbed(texts)
    }
    second.cacheKey = 'provider-b/model-a'
    const rewired = IndexManager.getInstance(
      root,
      { semantic: { enabled: true, model: 'embedding-v1' } },
      second,
    )
    // Same project/config key: the singleton must be rewired, not forked.
    expect(rewired).toBe(mgr)
    await rewired.waitUntilReady(10_000)
    // The new embedder actually re-embedded the corpus under its own
    // fingerprint.
    expect(secondCalls).toBeGreaterThan(0)
    expect(mgr.isSemanticReady()).toBe(true)
    const hits = await mgr.searchSemantic('user login auth token', 5)
    expect(hits.length).toBeGreaterThan(0)
  })

  test('a failed embed leaves prior vectors queryable instead of wiping the tier', async () => {
    // Regression for the M4-S6 semantic-tier-wipe finding: one transient
    // embedder failure must not downgrade retrieval to lexical-only.
    const root = makeProject()
    let embedCalls = 0
    const flaky: EmbedFn = async (texts) => {
      embedCalls++
      if (embedCalls === 2) throw new Error('provider outage')
      return fakeEmbed(texts)
    }
    const mgr = IndexManager.getInstance(
      root,
      { semantic: { enabled: true } },
      flaky,
    )
    await mgr.waitUntilReady(10_000)
    expect(mgr.isSemanticReady()).toBe(true)

    // A new file forces the refresh to embed something, so the failing
    // second embed call is reached during the rebuild.
    writeFileSync(
      join(root, 'src', 'extra.ts'),
      'export function extraThing() {}\n',
    )
    mgr.markStale()
    await mgr.waitUntilReady(10_000)

    // The failure is surfaced through status...
    expect(mgr.getStatus().lastBuildError?.stage).toBe('semantic')
    // ...but the previously built vectors remain queryable.
    expect(mgr.isSemanticReady()).toBe(true)
    const hits = await mgr.searchSemantic('user login auth token', 5)
    expect(hits.length).toBeGreaterThan(0)
  })
})

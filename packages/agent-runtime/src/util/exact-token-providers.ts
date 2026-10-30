/**
 * P3-T10: bundled OpenAI-family exact token providers, wired behind the
 * ExactTokenCounter seam in ./token-counter.
 *
 * The ONLY production import of this module is the flag-gated dynamic import
 * at the SDK seam (sdk/src/run.ts). The module's own top-level tiktoken
 * import transitively loads tiktoken's node entry, which instantiates its
 * WASM at import time, so the flag-off path must never load this module at
 * all — and, since the SDK seam is the only import site, it doesn't.
 *
 * Two counters are registered and the ORDER IS LOAD-BEARING (the seam
 * dispatches first-registered-match-wins):
 *   1. cl100k FIRST, via a custom matcher, for the gpt-3.5-turbo /
 *      gpt-4-turbo lineages tiktoken maps to cl100k_base;
 *   2. o200k SECOND, via exactFamilyMatcher('openai'), for the rest of the
 *      family (gpt-4o and newer). The estimator already prices the whole
 *      family with gpt-4o (o200k) BPE, so the o200k registration is strictly
 *      closer to the routed model's tokenizer; only the two cl100k lineages
 *      need the special case.
 *
 * Registration EAGERLY VALIDATES the bundled encodings: both are constructed
 * before any counter is registered, so an install whose tiktoken package is
 * unusable throws at the seam (where sdk/src/run.ts logs the cause and keeps
 * the estimator) instead of registering a provider set that silently
 * degrades every count to the estimator with no signal at the one moment the
 * breakage is diagnosable. tiktoken's WASM lives in its OWN package
 * (node_modules/tiktoken/tiktoken_bg.wasm, located by tiktoken's node entry
 * via fs.readFileSync) rather than in this package's dist, which is exactly
 * why the SDK declares tiktoken as an EXTERNAL dependency instead of copying
 * the WASM into dist.
 */

import { get_encoding } from 'tiktoken'
import type { Tiktoken } from 'tiktoken'

import {
  exactFamilyMatcher,
  registerExactTokenCounter,
} from './token-counter'

/**
 * P3-T10: the encoding constructor the eager validation runs against.
 * Production uses tiktoken's get_encoding; the indirection exists so the
 * registration-time failure path is pinnable from a test WITHOUT mocking the
 * whole 'tiktoken' module (bun's mock.module is process-global and would leak
 * into every other suite in this process). Exported for testability only.
 */
export type BundledExactTokenProviderDeps = {
  getEncoding?: (encodingName: string) => Tiktoken
}

/**
 * P3-T10: module-level idempotence guard. The SDK seam calls
 * registerBundledExactTokenProviders once per run while the gate is on, so
 * this boolean makes every call after the first a no-op.
 * resetBundledExactTokenProvidersForTest is the only way back to false.
 */
let bundledExactTokenProvidersRegistered = false

/**
 * P3-T10: exported-for-test count of actual registration events. The
 * boolean guard alone is unobservable from outside this module, and the
 * seam's first-registered-match-wins dispatch makes a DOUBLED provider set
 * route identically to a single one — so "call twice, one provider set"
 * cannot be pinned behaviorally. This counter (incremented only inside the
 * guarded block below) is what the idempotence test asserts against.
 */
let bundledExactTokenProviderRegistrations = 0

/**
 * P3-T10: memoized encoding handles, NEVER constructed at module scope.
 * get_encoding builds the multi-MB rank tables at CALL time, so importing
 * this module stays cheap; the eager validation inside
 * registerBundledExactTokenProviders is what populates these handles, after
 * which every count() reuses them — each encoding is constructed at most
 * once per process, and the first count() never re-runs get_encoding.
 */
let cl100kEncoding: Tiktoken | undefined
let o200kEncoding: Tiktoken | undefined

function getCl100kEncoding(): Tiktoken {
  cl100kEncoding ??= get_encoding('cl100k_base')
  return cl100kEncoding
}

function getO200kEncoding(): Tiktoken {
  o200kEncoding ??= get_encoding('o200k_base')
  return o200kEncoding
}

/**
 * P3-T10: counts text exactly under one encoding. encode(text, [], [])
 * passes BOTH an empty allowed_special AND an empty disallowed_special set,
 * so literal special-token text is counted as ordinary BPE tokens and never
 * throws — the same intent as token-counter's BPE_SPECIAL_TOKEN_ESCAPE
 * workaround for gpt-tokenizer, applied here at the provider that owns the
 * special-token policy. tiktoken's DEFAULT encode rejects any special-token
 * text (the risk the task record calls out) and a throwing provider would
 * degrade every count back to the estimator; the (text, [], []) arguments
 * are load-bearing and pinned by test.
 */
function countWithEncoding(encoding: Tiktoken, text: string): number {
  return encoding.encode(text, [], []).length
}

/**
 * P3-T10: eagerly constructs — and therefore validates — BOTH bundled
 * encodings. tiktoken loads its WASM and builds its rank tables on the
 * get_encoding call, so this is the one place a broken/unpruned install
 * (node_modules/tiktoken/tiktoken_bg.wasm missing) surfaces as a throw
 * instead of a silent estimator fallback on every later count. On the default
 * path it also populates the memo handles above, so the first count() reuses
 * them rather than reloading the WASM.
 */
function validateBundledEncodings(
  deps: BundledExactTokenProviderDeps,
): void {
  if (!deps.getEncoding) {
    getCl100kEncoding()
    getO200kEncoding()
    return
  }
  // Test seam: an INJECTED constructor is exercised directly instead of
  // through the process-wide memo, so a throwing double deterministically
  // fails here even after earlier registrations memoized the real handles.
  deps.getEncoding('cl100k_base')
  deps.getEncoding('o200k_base')
}

/**
 * P3-T10: registers the bundled OpenAI-family exact token counters. First
 * registered match wins, so the cl100k-lineage matcher is registered BEFORE
 * the whole-family o200k matcher; a gpt-3.5/gpt-4-turbo model therefore hits
 * cl100k_base and every other OpenAI model hits o200k_base. Idempotent via
 * the module-level boolean, so repeated SDK-seam calls (once per run while
 * the gate is on) register exactly one provider set.
 *
 * Both encodings are validated BEFORE the first registration, so an unusable
 * tiktoken install throws here, at run start, where the seam logs the real
 * cause. The trade: the first registration pays both encodings' construction
 * (WASM load plus the multi-MB rank tables) instead of deferring each build
 * to its first count — once per process behind the guard, and worth it for
 * honest failure. A throw is ATOMIC: nothing is registered and the guard goes
 * back to false so a later call can retry.
 */
export function registerBundledExactTokenProviders(
  deps: BundledExactTokenProviderDeps = {},
): void {
  if (bundledExactTokenProvidersRegistered) {
    return
  }
  bundledExactTokenProvidersRegistered = true

  try {
    validateBundledEncodings(deps)
  } catch (error) {
    // A half-initialized guard would turn every later call into a silent
    // no-op, so it MUST be restored before the failure escapes.
    bundledExactTokenProvidersRegistered = false
    throw error
  }

  bundledExactTokenProviderRegistrations += 1

  // FIRST: cl100k_base for the gpt-3.5-turbo / gpt-4-turbo lineages
  // (tiktoken's model registry maps both to cl100k_base). Registered before
  // the family matcher so first-match-wins dispatch prefers it.
  registerExactTokenCounter(
    (model: string) => {
      const normalized = model.toLowerCase()
      return (
        normalized.includes('gpt-3.5') || normalized.includes('gpt-4-turbo')
      )
    },
    {
      family: 'openai',
      count: (text: string) => countWithEncoding(getCl100kEncoding(), text),
    },
  )

  // SECOND: o200k_base for the rest of the OpenAI family (gpt-4o and newer),
  // keyed by the seam's own family matcher.
  registerExactTokenCounter(exactFamilyMatcher('openai'), {
    family: 'openai',
    count: (text: string) => countWithEncoding(getO200kEncoding(), text),
  })
}

/**
 * P3-T10: test-only counterpart of the seam's clearExactTokenCountersForTest
 * — the seam's clear drops registrations while this module's idempotence
 * boolean would keep remembering them, so tests that clear and re-register
 * restore the never-registered state here. Never called in production.
 */
export function resetBundledExactTokenProvidersForTest(): void {
  bundledExactTokenProvidersRegistered = false
  bundledExactTokenProviderRegistrations = 0
}

/**
 * P3-T10: exported-for-test view of the registration-event count above, so
 * the idempotence test can pin "call twice, one provider set".
 */
export function bundledExactTokenProviderRegistrationsForTest(): number {
  return bundledExactTokenProviderRegistrations
}

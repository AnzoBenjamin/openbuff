#!/usr/bin/env bun

/**
 * P3-T10 calibration harness — OpenAI provider-vs-estimator token-count drift.
 *
 * For a FIXED workload of representative strings (code, prose, JSON,
 * multibyte/unicode, and a pathological repetitive payload) this compares:
 *   (a) the local ESTIMATOR — the raw gpt-4o BPE count from
 *       countTokens/countTokensJson with model 'openai/gpt-4o' (the OpenAI
 *       family fudge factor is 1.0, so the returned count IS the raw BPE
 *       count), against
 *   (b) the REAL provider count from OpenAI's
 *       POST /v1/responses/input_tokens endpoint,
 * and prints a per-workload table plus the aggregate measured ratio
 * (estimator/provider). It then states whether the current
 * OPENAI_TOKEN_FUDGE_FACTOR is within tolerance of the measured ratio and
 * prints a recommendation.
 *
 * EVIDENCE-GENERATING ONLY: this script never edits the fudge factor and
 * never flips a flag — it produces the calibration numbers the P3-T10
 * fudge-factor decision needs.
 *
 * Anthropic/Gemini are explicitly OUT OF SCOPE: neither has a local tokenizer
 * nor a public count endpoint, so their factors stay deferred pending
 * usage-based (usage.input_tokens) calibration.
 *
 * NETWORK-GATED: requires OPENAI_API_KEY and exits before any request without
 * it, so the harness can never run in CI. main() is guarded by
 * import.meta.main so importing this module (as the unit test does) has no
 * side effects. Usage:
 *   OPENAI_API_KEY=... bun scripts/calibrate-openai-tokens.ts
 */

import {
  countTokens,
  countTokensJson,
  tokenFudgeFactorForModel,
} from '../packages/agent-runtime/src/util/token-counter'

const ENDPOINT = 'https://api.openai.com/v1/responses/input_tokens'

/**
 * The estimator keys its OpenAI family (factor 1.0) off this model string;
 * the provider side counts with the matching real model so the comparison is
 * like-for-like within the gpt-4o tokenizer family.
 */
const ESTIMATOR_MODEL = 'openai/gpt-4o'
const PROVIDER_MODEL = 'gpt-4o'

/**
 * Verdict tolerance: the current factor is 'within tolerance' of the measured
 * aggregate ratio when |factor - ratio| <= CALIBRATION_TOLERANCE (5%).
 */
export const CALIBRATION_TOLERANCE = 0.05

const CODE_PAYLOAD = `export async function fetchWorkspaceRoot(cwd: string): Promise<string> {
  const manifest = await readFile(join(cwd, 'package.json'), 'utf-8')
  const parsed: unknown = JSON.parse(manifest)
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('invalid package.json')
  }
  return cwd
}`

const PROSE_PAYLOAD =
  'Token calibration matters because context-window budgeting — when to ' +
  'compact a transcript, evict a stale tool result, or truncate a file ' +
  'tree — is only as honest as the estimate driving it. If the local ' +
  'estimate drifts from the provider count by even ten percent, a long ' +
  'agent session either compacts far too early or slams into the context ' +
  'limit without warning.'

const JSON_PAYLOAD = {
  tool: 'read_files',
  params: {
    paths: ['src/index.ts', 'src/util/token-counter.ts'],
    options: { encoding: 'utf-8', recursive: true, maxBytes: 65536 },
  },
  metadata: { task: 'P3-T10', priority: 3, tags: ['calibration', 'token-count'] },
}

const UNICODE_PAYLOAD =
  '你好世界 🌍 こんにちは مرحبا — Grüße, привет, नमस्ते, 안녕하세요. ' +
  'Café, naïve, résumé — emoji run: 🚀✨🔥.'

/**
 * Pathological repetitive payload: a homogeneous separator-free run (the same
 * shape token-counter.ts caps at MAX_BPE_ENCODE_CHARS for encode speed).
 * Highly BPE-compressible, so it carries an extreme chars/token ratio where
 * estimator/provider drift shows up first. 8k chars stays inside the
 * estimator's cacheable band, so repeat runs (and the unit test) are fast.
 */
const REPETITIVE_PAYLOAD = 'a'.repeat(8 * 1024)

export interface CalibrationWorkload {
  name: string
  /** Exact text sent to the provider endpoint as a single user message. */
  providerText: string
  /** Local estimator count for the same content (gpt-4o BPE, factor applied). */
  estimate: () => number
}

/**
 * The fixed calibration workload. The JSON case goes through countTokensJson
 * (the object path); everything else through countTokens. Both are called
 * with ESTIMATOR_MODEL so the OpenAI-family factor (1.0) is applied, and the
 * provider receives the same serialization so both sides price identical
 * bytes.
 */
export const CALIBRATION_WORKLOADS: readonly CalibrationWorkload[] = [
  {
    name: 'code',
    providerText: CODE_PAYLOAD,
    estimate: () => countTokens(CODE_PAYLOAD, ESTIMATOR_MODEL),
  },
  {
    name: 'prose',
    providerText: PROSE_PAYLOAD,
    estimate: () => countTokens(PROSE_PAYLOAD, ESTIMATOR_MODEL),
  },
  {
    name: 'json',
    providerText: JSON.stringify(JSON_PAYLOAD),
    estimate: () => countTokensJson(JSON_PAYLOAD, ESTIMATOR_MODEL),
  },
  {
    name: 'multibyte-unicode',
    providerText: UNICODE_PAYLOAD,
    estimate: () => countTokens(UNICODE_PAYLOAD, ESTIMATOR_MODEL),
  },
  {
    name: 'pathological-repetitive',
    providerText: REPETITIVE_PAYLOAD,
    estimate: () => countTokens(REPETITIVE_PAYLOAD, ESTIMATOR_MODEL),
  },
]

export interface WorkloadResult {
  name: string
  estimatorTokens: number
  providerTokens: number
  /** estimator / provider — 1.0 means the estimator matches the provider. */
  ratio: number
}

export type CalibrationVerdict = 'within tolerance' | 'out of tolerance'

export interface CalibrationReport {
  estimatorModel: string
  providerModel: string
  /** Current OPENAI_TOKEN_FUDGE_FACTOR the estimator applied. */
  fudgeFactor: number
  tolerance: number
  workloads: WorkloadResult[]
  /** Arithmetic mean of the per-workload ratios. */
  aggregateRatio: number
  verdict: CalibrationVerdict
}

/** estimator/provider for one workload; 1.0 means perfect agreement. */
export function ratioForWorkload(
  estimatorTokens: number,
  providerTokens: number,
): number {
  return estimatorTokens / providerTokens
}

/** Arithmetic mean of the per-workload ratios (the fixed workload is non-empty). */
export function aggregateMeasuredRatio(ratios: readonly number[]): number {
  return ratios.reduce((sum, ratio) => sum + ratio, 0) / ratios.length
}

/**
 * The current factor is within tolerance of the measured ratio when
 * |factor - ratio| <= tolerance (inclusive band edge).
 */
export function verdictForRatio(
  aggregateRatio: number,
  fudgeFactor: number,
  tolerance: number,
): CalibrationVerdict {
  return Math.abs(fudgeFactor - aggregateRatio) <= tolerance
    ? 'within tolerance'
    : 'out of tolerance'
}

interface TokenCountResponse {
  object: string
  input_tokens: number
}

/**
 * Minimal structural view of fetch used by the harness — the global fetch
 * satisfies it, and tests inject a hermetic mock without touching the
 * network.
 */
export type TokenCountFetch = (
  url: string,
  init: {
    method: 'POST'
    headers: Record<string, string>
    body: string
  },
) => Promise<{
  ok: boolean
  status: number
  text(): Promise<string>
  json(): Promise<unknown>
}>

async function fetchProviderTokenCount(
  text: string,
  apiKey: string,
  fetchImpl: TokenCountFetch,
): Promise<number> {
  // Same fetch/auth/endpoint pattern as scripts/test-openai-token-count.ts.
  const response = await fetchImpl(ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: PROVIDER_MODEL,
      input: [{ role: 'user', content: text }],
    }),
  })
  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(
      `OpenAI input_tokens request failed (${response.status}): ${errorText.slice(0, 300)}`,
    )
  }
  const data = (await response.json()) as TokenCountResponse
  return data.input_tokens
}

export interface CalibrationOptions {
  /** OPENAI_API_KEY — required; the harness refuses to run without it. */
  apiKey: string | undefined
  /** Injectable fetch (tests pass a hermetic mock); defaults to real fetch. */
  fetchImpl?: TokenCountFetch
  tolerance?: number
}

/**
 * Runs the calibration: estimator counts are computed locally, provider
 * counts come from POST /v1/responses/input_tokens, and the report carries
 * the per-workload ratios, their aggregate mean, and the tolerance verdict.
 */
export async function runCalibration(
  options: CalibrationOptions,
): Promise<CalibrationReport> {
  const {
    apiKey,
    fetchImpl = fetch,
    tolerance = CALIBRATION_TOLERANCE,
  } = options
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY environment variable is required')
  }
  // tokenFudgeFactorForModel is the exported-for-test accessor: for an
  // OpenAI-family model it returns exactly OPENAI_TOKEN_FUDGE_FACTOR (1.0),
  // which is not itself exported from token-counter.ts.
  const fudgeFactor = tokenFudgeFactorForModel(ESTIMATOR_MODEL)
  const workloads: WorkloadResult[] = []
  for (const workload of CALIBRATION_WORKLOADS) {
    const estimatorTokens = workload.estimate()
    const providerTokens = await fetchProviderTokenCount(
      workload.providerText,
      apiKey,
      fetchImpl,
    )
    workloads.push({
      name: workload.name,
      estimatorTokens,
      providerTokens,
      ratio: ratioForWorkload(estimatorTokens, providerTokens),
    })
  }
  const aggregateRatio = aggregateMeasuredRatio(
    workloads.map((workload) => workload.ratio),
  )
  return {
    estimatorModel: ESTIMATOR_MODEL,
    providerModel: PROVIDER_MODEL,
    fudgeFactor,
    tolerance,
    workloads,
    aggregateRatio,
    verdict: verdictForRatio(aggregateRatio, fudgeFactor, tolerance),
  }
}

/** Renders the evidence artifact: table, measured ratio, verdict, recommendation. */
export function formatCalibrationReport(report: CalibrationReport): string {
  const lines: string[] = []
  lines.push('=== OpenAI token-count calibration (P3-T10 evidence) ===')
  lines.push('')
  lines.push(
    `Estimator: countTokens/countTokensJson (gpt-4o BPE) with model '${report.estimatorModel}'`,
  )
  lines.push(`Provider:  POST ${ENDPOINT} with model '${report.providerModel}'`)
  lines.push('')
  const nameWidth = Math.max(
    'workload'.length,
    ...report.workloads.map((workload) => workload.name.length),
  )
  const header = `${'workload'.padEnd(nameWidth)}  estimator  provider  ratio (est/provider)`
  lines.push(header)
  lines.push('-'.repeat(header.length))
  for (const workload of report.workloads) {
    lines.push(
      `${workload.name.padEnd(nameWidth)}  ${String(workload.estimatorTokens).padStart(9)}  ${String(workload.providerTokens).padStart(8)}  ${workload.ratio.toFixed(4)}`,
    )
  }
  lines.push('')
  lines.push(
    `Measured OpenAI-family ratio (mean estimator/provider): ${report.aggregateRatio.toFixed(4)}`,
  )
  const drift = Math.abs(report.fudgeFactor - report.aggregateRatio)
  lines.push(
    `Current OPENAI_TOKEN_FUDGE_FACTOR: ${report.fudgeFactor} (tolerance ±${report.tolerance})`,
  )
  lines.push(
    `Verdict: ${report.verdict} — |${report.fudgeFactor} - ${report.aggregateRatio.toFixed(4)}| = ${drift.toFixed(4)} ${report.verdict === 'within tolerance' ? '<=' : '>'} ${report.tolerance}`,
  )
  if (report.verdict === 'within tolerance') {
    lines.push(
      'Recommendation: keep OPENAI_TOKEN_FUDGE_FACTOR at its current value; the gpt-4o BPE estimator tracks the provider count within tolerance.',
    )
  } else {
    const impliedFactor = report.fudgeFactor / report.aggregateRatio
    lines.push(
      `Recommendation: the estimator drifts from the provider beyond tolerance; recalibrate OPENAI_TOKEN_FUDGE_FACTOR toward ≈ ${impliedFactor.toFixed(4)} (current factor / measured ratio) as part of the P3-T10 flip.`,
    )
  }
  lines.push('')
  lines.push(
    'Note: Anthropic (claude/*) and Gemini (google/*) calibration is out of scope for this harness — neither has a local tokenizer nor a public count endpoint, so their fudge factors stay deferred pending usage-based (usage.input_tokens) calibration.',
  )
  lines.push(
    'No configuration was changed: this harness only measures and reports.',
  )
  return lines.join('\n')
}

async function main(): Promise<void> {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) {
    console.error(
      '❌ OPENAI_API_KEY environment variable is required — this calibration harness calls the real OpenAI API (POST /v1/responses/input_tokens) and is network-gated: it never runs in CI without the key.',
    )
    process.exit(1)
  }
  const report = await runCalibration({ apiKey })
  console.log(formatCalibrationReport(report))
}

// Network gate: only runs when executed directly (`bun
// scripts/calibrate-openai-tokens.ts`), never on import — the unit test
// imports this module with a mocked fetch.
if (import.meta.main) {
  main().catch((error) => {
    console.error('\n❌ Calibration failed:')
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}

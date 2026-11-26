#!/usr/bin/env bun
/**
 * Generate the bounded runtime model-capability catalog from a models.dev v1
 * API snapshot. Runtime code never fetches models.dev; only this explicit
 * maintainer command has a network mode.
 *
 * Examples:
 *   bun scripts/generate-model-capability-catalog.ts --source /tmp/api.json --inspect
 *   bun scripts/generate-model-capability-catalog.ts --source /tmp/api.json --write
 *   bun scripts/generate-model-capability-catalog.ts --refresh --inspect
 *   bun scripts/generate-model-capability-catalog.ts --check
 */

import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'

const SOURCE_URL = 'https://models.dev/api.json'
const SOURCE_REPOSITORY = 'https://github.com/anomalyco/models.dev'
const SOURCE_REVISION = 'c2b10ec21b6ac2c856b74a08d872af5a54833954'
const EXPECTED_SOURCE_PAYLOAD_SHA256 =
  '0e9a324d88b32ad6e14075997b9f1a0f71e367be0bebfb25b8404701ca03bd1f'
const EXPECTED_CATALOG_SHA256 =
  '504abb06a14a15a129e0d6ed4a710d15e44bfda95b3e519208a78bfc6661c5dd'
const EXPECTED_GENERATED_AT = '2026-11-25T22:30:58.000Z'
const LICENSE = 'MIT'
const UPSTREAM_LICENSE_NOTICE = `MIT License

Copyright (c) 2025 models.dev

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`
const GENERATOR_VERSION = 1
const OUTPUT_PATH = path.resolve(
  import.meta.dir,
  '..',
  'sdk',
  'src',
  'generated',
  'models-dev-capabilities.generated.ts',
)

/**
 * Deliberately bounded exact IDs. Preset defaults and representative current
 * direct/OpenRouter routes are included; discovery persists other models.
 * IDs absent from the selected upstream snapshot are not aliased or guessed.
 */
export const SELECTED_MODELS = {
  anthropic: [
    'claude-haiku-4-5',
    'claude-opus-4-5',
    'claude-sonnet-4-5',
    'claude-sonnet-5-5',
  ],
  openai: [
    'gpt-4.1',
    'gpt-4.1-mini',
    'gpt-5.1',
    'gpt-5.2',
    'gpt-5.4',
    'gpt-5.4-mini',
    'gpt-5.4-nano',
    'gpt-5.5',
    'gpt-6.2-sol',
  ],
  openrouter: [
    'anthropic/claude-opus-4.1',
    'anthropic/claude-sonnet-4.5',
    'anthropic/claude-sonnet-5.5',
    'openai/gpt-4.1-mini',
    'openai/gpt-6.2-sol',
  ],
} as const

type JsonObject = Record<string, unknown>
type CatalogPricing = {
  inputPerMillionTokens: number
  outputPerMillionTokens: number
  cachedInputPerMillionTokens?: number
  cacheWriteInputPerMillionTokens?: number
  currency: 'USD'
}
type CatalogRecord = {
  contextWindowTokens: number
  outputTokens: number
  reasoning?: boolean
  pricing?: CatalogPricing
  pricingOmittedReason?: 'conditional-tiers'
  canonicalModelId?: string
  sourceLastUpdated?: string
}
type Catalog = Record<string, Record<string, CatalogRecord>>

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${label} must be an object`)
  return value as JsonObject
}

function positiveSafeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0)
    throw new Error(`${label} must be a positive safe integer`)
  return value
}

function nonNegativeFinite(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
    throw new Error(`${label} must be a finite non-negative number`)
  return value
}

function sha256(bytes: string | Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as JsonObject)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)]),
  )
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

function hasConditionalPricing(cost: JsonObject): boolean {
  return (
    (Array.isArray(cost.tiers) && cost.tiers.length > 0) ||
    (cost.context_over_200k !== undefined && cost.context_over_200k !== null)
  )
}

function normalizeRecord(
  providerId: string,
  modelId: string,
  raw: unknown,
): CatalogRecord {
  const record = object(raw, `${providerId}/${modelId}`)
  if (record.id !== modelId)
    throw new Error(
      `${providerId}/${modelId} has mismatched upstream id ${String(record.id)}`,
    )
  const limit = object(record.limit, `${providerId}/${modelId}.limit`)
  const result: CatalogRecord = {
    contextWindowTokens: positiveSafeInteger(
      limit.context,
      `${providerId}/${modelId}.limit.context`,
    ),
    outputTokens: positiveSafeInteger(
      limit.output,
      `${providerId}/${modelId}.limit.output`,
    ),
  }
  if (typeof record.reasoning === 'boolean') result.reasoning = record.reasoning
  if (typeof record.canonical_model_id === 'string')
    result.canonicalModelId = record.canonical_model_id
  if (typeof record.last_updated === 'string')
    result.sourceLastUpdated = record.last_updated

  const cost = object(record.cost, `${providerId}/${modelId}.cost`)
  if (hasConditionalPricing(cost)) {
    result.pricingOmittedReason = 'conditional-tiers'
    return result
  }
  const input = nonNegativeFinite(
    cost.input,
    `${providerId}/${modelId}.cost.input`,
  )
  const output = nonNegativeFinite(
    cost.output,
    `${providerId}/${modelId}.cost.output`,
  )
  if (input === undefined || output === undefined)
    throw new Error(
      `${providerId}/${modelId} must have complete base input/output pricing`,
    )
  const cacheRead = nonNegativeFinite(
    cost.cache_read,
    `${providerId}/${modelId}.cost.cache_read`,
  )
  const cacheWrite = nonNegativeFinite(
    cost.cache_write,
    `${providerId}/${modelId}.cost.cache_write`,
  )
  result.pricing = {
    inputPerMillionTokens: input,
    outputPerMillionTokens: output,
    ...(cacheRead === undefined
      ? {}
      : { cachedInputPerMillionTokens: cacheRead }),
    ...(cacheWrite === undefined
      ? {}
      : { cacheWriteInputPerMillionTokens: cacheWrite }),
    currency: 'USD',
  }
  return result
}

export function buildCatalog(snapshot: unknown): Catalog {
  const root = object(snapshot, 'models.dev snapshot')
  const catalog: Catalog = {}
  for (const providerId of Object.keys(SELECTED_MODELS).sort()) {
    const provider = object(root[providerId], `provider ${providerId}`)
    const models = object(provider.models, `provider ${providerId}.models`)
    const selected = SELECTED_MODELS[
      providerId as keyof typeof SELECTED_MODELS
    ] as readonly string[]
    const entries: Record<string, CatalogRecord> = {}
    for (const modelId of [...selected].sort()) {
      if (!(modelId in models))
        throw new Error(
          `Selected models.dev record ${providerId}/${modelId} is missing`,
        )
      entries[modelId] = normalizeRecord(providerId, modelId, models[modelId])
    }
    catalog[providerId] = entries
  }
  return catalog
}

function generateSource(params: {
  snapshotText: string
  generatedAt: string
  sourceRevision: string
}): string {
  const snapshot = JSON.parse(params.snapshotText) as unknown
  const catalog = buildCatalog(snapshot)
  const provenance = {
    schemaVersion: 1,
    sourceUrl: SOURCE_URL,
    sourceRepository: SOURCE_REPOSITORY,
    sourceRevision: params.sourceRevision,
    sourceRevisionAttestedByApi: false,
    sourcePayloadSha256: sha256(params.snapshotText),
    generatedAt: params.generatedAt,
    generatorVersion: GENERATOR_VERSION,
    license: LICENSE,
    licenseUrl: `${SOURCE_REPOSITORY}/blob/${params.sourceRevision}/LICENSE`,
    catalogSha256: sha256(canonicalJson(catalog)),
  }
  return `/**\n * GENERATED FILE — DO NOT EDIT.\n * Regenerate with scripts/generate-model-capability-catalog.ts.\n * models.dev repository license: MIT. The API payload does not attest the\n * separately observed source revision; both identities are recorded below.\n */\n\nexport const MODELS_DEV_UPSTREAM_LICENSE_NOTICE = ${JSON.stringify(UPSTREAM_LICENSE_NOTICE)} as const\n\nexport const MODELS_DEV_CATALOG_PROVENANCE = ${JSON.stringify(provenance, null, 2)} as const\n\nexport const MODELS_DEV_CAPABILITY_CATALOG = ${JSON.stringify(catalog, null, 2)} as const\n`
}

async function checkGenerated(): Promise<void> {
  if (!fs.existsSync(OUTPUT_PATH))
    throw new Error(`Generated catalog is missing: ${OUTPUT_PATH}`)
  const moduleUrl = `${pathToFileURL(OUTPUT_PATH).href}?check=${Date.now()}`
  const generated = (await import(moduleUrl)) as {
    MODELS_DEV_UPSTREAM_LICENSE_NOTICE?: unknown
    MODELS_DEV_CATALOG_PROVENANCE?: Record<string, unknown>
    MODELS_DEV_CAPABILITY_CATALOG?: unknown
  }
  const provenance = generated.MODELS_DEV_CATALOG_PROVENANCE
  if (!provenance) throw new Error('Generated catalog provenance is missing')
  const expectedProvenance = {
    schemaVersion: 1,
    sourceUrl: SOURCE_URL,
    sourceRepository: SOURCE_REPOSITORY,
    sourceRevision: SOURCE_REVISION,
    sourceRevisionAttestedByApi: false,
    sourcePayloadSha256: EXPECTED_SOURCE_PAYLOAD_SHA256,
    generatedAt: EXPECTED_GENERATED_AT,
    generatorVersion: GENERATOR_VERSION,
    license: LICENSE,
    licenseUrl: `${SOURCE_REPOSITORY}/blob/${SOURCE_REVISION}/LICENSE`,
    catalogSha256: EXPECTED_CATALOG_SHA256,
  }
  for (const [key, expectedValue] of Object.entries(expectedProvenance)) {
    if (provenance[key] !== expectedValue)
      throw new Error(
        `Generated catalog provenance mismatch for ${key}: expected ${String(expectedValue)}, got ${String(provenance[key])}`,
      )
  }
  if (generated.MODELS_DEV_UPSTREAM_LICENSE_NOTICE !== UPSTREAM_LICENSE_NOTICE)
    throw new Error('Generated models.dev MIT notice is missing or changed')
  const actual = sha256(canonicalJson(generated.MODELS_DEV_CAPABILITY_CATALOG))
  if (actual !== EXPECTED_CATALOG_SHA256)
    throw new Error(
      `Generated catalog hash mismatch: expected=${EXPECTED_CATALOG_SHA256} actual=${actual}`,
    )
  buildCatalogFromGenerated(generated.MODELS_DEV_CAPABILITY_CATALOG)
  console.log(`models.dev capability catalog is valid (${actual})`)
}

function buildCatalogFromGenerated(value: unknown): void {
  const catalog = object(value, 'generated catalog')
  const providerKeys = Object.keys(catalog)
  const expectedProviderKeys = Object.keys(SELECTED_MODELS).sort()
  if (providerKeys.join('\0') !== expectedProviderKeys.join('\0'))
    throw new Error('Generated catalog provider membership/order is stale')
  for (const providerId of providerKeys) {
    const records = object(catalog[providerId], `generated ${providerId}`)
    const keys = Object.keys(records)
    const selected = [
      ...SELECTED_MODELS[providerId as keyof typeof SELECTED_MODELS],
    ].sort()
    if (keys.join('\0') !== selected.join('\0'))
      throw new Error(
        `Generated provider ${providerId} model membership is stale`,
      )
    for (const modelId of keys) {
      const record = object(records[modelId], `${providerId}/${modelId}`)
      positiveSafeInteger(
        record.contextWindowTokens,
        `${providerId}/${modelId}.contextWindowTokens`,
      )
      positiveSafeInteger(
        record.outputTokens,
        `${providerId}/${modelId}.outputTokens`,
      )
      if (record.pricing !== undefined) {
        const pricing = object(
          record.pricing,
          `${providerId}/${modelId}.pricing`,
        )
        const input = nonNegativeFinite(
          pricing.inputPerMillionTokens,
          `${providerId}/${modelId}.pricing.input`,
        )
        const output = nonNegativeFinite(
          pricing.outputPerMillionTokens,
          `${providerId}/${modelId}.pricing.output`,
        )
        if (input === undefined || output === undefined)
          throw new Error(`${providerId}/${modelId} pricing is incomplete`)
        if (pricing.currency !== 'USD')
          throw new Error(`${providerId}/${modelId} pricing must be USD`)
      }
    }
  }
}

function argument(args: string[], name: string): string | undefined {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}

async function readSelectedSnapshot(args: string[]): Promise<string> {
  const sourcePath = argument(args, '--source')
  const refresh = args.includes('--refresh')
  if (Boolean(sourcePath) === refresh)
    throw new Error('Select exactly one of --source <api.json> or --refresh')
  return sourcePath
    ? fs.readFileSync(path.resolve(sourcePath), 'utf8')
    : fetch(SOURCE_URL).then(async (response) => {
        if (!response.ok)
          throw new Error(
            `models.dev fetch failed: ${response.status} ${response.statusText}`,
          )
        return response.text()
      })
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  if (args.includes('--check')) {
    await checkGenerated()
    return
  }
  if (args.includes('--inspect')) {
    if (args.includes('--write'))
      throw new Error(
        '--inspect is read-only and cannot be combined with --write',
      )
    const snapshotText = await readSelectedSnapshot(args)
    const catalog = buildCatalog(JSON.parse(snapshotText) as unknown)
    console.log(
      JSON.stringify(
        {
          sourcePayloadSha256: sha256(snapshotText),
          catalogSha256: sha256(canonicalJson(catalog)),
          selectedProviders: Object.keys(catalog),
          selectedModelCount: Object.values(catalog).reduce(
            (count, models) => count + Object.keys(models).length,
            0,
          ),
        },
        null,
        2,
      ),
    )
    return
  }
  if (!args.includes('--write')) {
    throw new Error(
      'Use --check, --inspect with --source/--refresh, or select --source <api.json>/--refresh together with --write.',
    )
  }
  const snapshotText = await readSelectedSnapshot(args)
  const sourceHash = sha256(snapshotText)
  if (sourceHash !== EXPECTED_SOURCE_PAYLOAD_SHA256)
    throw new Error(
      `models.dev source payload changed: expected ${EXPECTED_SOURCE_PAYLOAD_SHA256}, got ${sourceHash}. Review the upstream/source diff, then update the pinned source/catalog hashes in this generator before writing.`,
    )
  const generatedAt =
    argument(args, '--generated-at') ?? new Date().toISOString()
  const sourceRevision = argument(args, '--source-revision') ?? SOURCE_REVISION
  const source = generateSource({
    snapshotText,
    generatedAt,
    sourceRevision,
  })
  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true })
  fs.writeFileSync(OUTPUT_PATH, source)
  console.log(`Wrote ${path.relative(process.cwd(), OUTPUT_PATH)}`)
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}

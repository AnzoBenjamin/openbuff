#!/usr/bin/env bun
// Build a project's configured index without holding its interactive terminal.
import { resolve } from 'node:path'

import { IndexManager } from '../packages/indexer/src/index-manager'
import { createConfiguredEmbedder } from '../sdk/src/impl/embeddings'
import { loadProviderConfigSync } from '../sdk/src/provider-config'

const root = resolve(process.argv[2] ?? process.cwd())
process.chdir(root)
const config = loadProviderConfigSync().config.indexing
const configured =
  config.semantic?.enabled && config.semantic.model
    ? createConfiguredEmbedder(config.semantic.model)
    : null
if (config.enabled === false || !configured) {
  throw new Error(
    'Enable indexing.semantic and configure a routable embedding model before warming vectors.',
  )
}
let count = 0
const embed = Object.assign(
  async (texts: string[]) => {
    const vectors = await configured(texts)
    count += texts.length
    console.log(`Embedded ${count} inputs this run`)
    return vectors
  },
  { cacheKey: configured.cacheKey, maxBatchSize: configured.maxBatchSize },
)
const manager = IndexManager.getInstance(root, config, embed)
console.log(`Warming ${root} with ${config.semantic.model}`)
const ready = await manager.waitUntilReady(6 * 60 * 60 * 1_000)
const status = manager.getStatus()
console.log(JSON.stringify(status, null, 2))
if (!ready || !manager.isSemanticReady() || status.semanticSkippedFiles)
  process.exitCode = 1

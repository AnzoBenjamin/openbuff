/**
 * One-off baseline harness for the retrieval-quality-tier1 session.
 * Runs the versioned Openbuff corpus through the lexical retriever and prints
 * the full quality report so baseline/post-fix numbers can be recorded in
 * STATUS.md. Deterministic clock keeps latency samples stable.
 *
 * Run: bun .agents/sessions/retrieval-quality-tier1/baseline.ts
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { queryIndex } from '../../../packages/indexer/src/query'
import {
  evaluateRetrievalQuality,
  type RetrievalQualityCorpus,
} from '../../../packages/indexer/src/retrieval-quality'
import { buildMetadataIndex } from '../../../packages/indexer/src/metadata-indexer'

const repositoryRoot = resolve(import.meta.dir, '../../..')
const corpusPath = resolve(
  import.meta.dir,
  '../../../packages/indexer/fixtures/retrieval-quality-openbuff-v2.json',
)
const corpus = JSON.parse(readFileSync(corpusPath, 'utf8')) as RetrievalQualityCorpus

const index = await buildMetadataIndex(repositoryRoot, {
  maxFiles: 10_000,
})
const report = await evaluateRetrievalQuality(
  corpus,
  (query, limit) =>
    queryIndex(index, query, { limit }).map((result) => result.path),
  { k: 3, now: () => 0 },
)

console.log(JSON.stringify(report, null, 2))

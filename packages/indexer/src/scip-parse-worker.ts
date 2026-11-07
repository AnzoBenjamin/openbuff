import { readFileSync } from 'node:fs'
import { parentPort } from 'node:worker_threads'

import { parseScipJson, scipPreciseEdges } from './scip-ingest'

import type { IndexEdge } from './types'
import type { ScipIndex } from './scip-ingest'

/**
 * SCIP parse worker (perf: scip-dump-json-parse-heap-spike plus the
 * offload-completeness repair): the ENTIRE front half of SCIP dump ingestion
 * — bounded read, JSON.parse, validation (`parseScipJson`), and precise-edge
 * derivation (`scipPreciseEdges`) — runs HERE, off the main event loop, so
 * the raw dump text and the intermediate parse graph never touch the main
 * thread. The worker receives only a dump file path and posts back only the
 * derived `IndexEdge[]` (or a stage-tagged failure envelope).
 */

/**
 * Stage tags for a failed dump derivation, mapped by the scip-runner to the
 * same per-indexer error attributions the on-thread pipeline produced:
 * `parse` (unreadable file / malformed JSON) and `validate` (schema
 * violation) read `failed to parse SCIP dump: ...`; `derive` (a document
 * escaping the project root) reads `SCIP merge failed: ...`.
 */
export type ScipDumpDerivationStage = 'parse' | 'validate' | 'derive'

/** Typed failure for any stage of the off-thread dump derivation. */
export class ScipDumpDerivationError extends Error {
  readonly stage: ScipDumpDerivationStage

  constructor(stage: ScipDumpDerivationStage, message: string) {
    super(message)
    this.name = 'ScipDumpDerivationError'
    this.stage = stage
  }
}

/** Worker → main-thread result envelope (structured clone). */
export type ScipParseWorkerResult =
  | { ok: true; edges: IndexEdge[] }
  | { ok: false; stage: ScipDumpDerivationStage; message: string }

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The full dump front half, shared by the worker message loop below and by
 * scip-runner's main-thread fallback for runtimes without worker threads:
 * read the dump at `filePath`, JSON.parse it, validate it through
 * `parseScipJson`, and derive its precise edges through `scipPreciseEdges`.
 * Fails closed with a typed {@link ScipDumpDerivationError} tagging the
 * failed stage.
 */
export function deriveScipDumpEdges(filePath: string): IndexEdge[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf8'))
  } catch (error) {
    throw new ScipDumpDerivationError('parse', errorMessage(error))
  }
  let scip: ScipIndex
  try {
    scip = parseScipJson(parsed)
  } catch (error) {
    throw new ScipDumpDerivationError('validate', errorMessage(error))
  }
  try {
    return scipPreciseEdges(scip)
  } catch (error) {
    throw new ScipDumpDerivationError('derive', errorMessage(error))
  }
}

// Worker entry: register the message loop only when this module runs AS a
// worker thread. The main thread imports this module for the shared
// derivation helper and typed error, where `parentPort` is null.
const port = parentPort
if (port) {
  port.on('message', (filePath: string) => {
    try {
      const result: ScipParseWorkerResult = {
        ok: true,
        edges: deriveScipDumpEdges(filePath),
      }
      port.postMessage(result)
    } catch (error) {
      const derivation =
        error instanceof ScipDumpDerivationError
          ? error
          : new ScipDumpDerivationError('parse', errorMessage(error))
      const failure: ScipParseWorkerResult = {
        ok: false,
        stage: derivation.stage,
        message: derivation.message,
      }
      port.postMessage(failure)
    }
  })
}

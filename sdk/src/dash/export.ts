/**
 * P2-T7: static HTML export for the `openbuff dash` dashboard. Writes the
 * dashboard page with the provider's data INLINED as a JSON `<script>` blob
 * (so the exported file works fully offline, with no fetch and NO token — a
 * static export has no auth because it is a local file) plus one JSON data
 * file per endpoint.
 *
 * SECURITY NOTE: an exported HTML contains whatever the provider returned.
 * Providers must never include secrets in their responses; the default
 * journal provider surfaces already-redacted wire shapes (receipts/gate),
 * so the default pipeline redacts nothing further.
 *
 * Path safety: the export never writes outside `outDir`. Every target file
 * is resolved against `outDir` and the resolved path must keep the resolved
 * directory as a prefix — a hostile outDir or filename cannot escape.
 */

import { mkdir, mkdtemp, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { DASH_MAX_EVENTS, renderDashHtml } from './server'

import type { DashDataProvider, DashSnapshot } from './server'

export type ExportDashStaticParams = {
  outDir: string
  data: DashDataProvider
  /**
   * Accepted for signature compatibility with the server; the token is
   * NEVER written to disk and the static page never uses it.
   */
  token?: string
}

export type ExportDashStaticResult =
  | { ok: true; files: string[] }
  | { ok: false; error: string }

const EXPORT_FILES = [
  'index.html',
  'runs.json',
  'events.json',
  'receipts.json',
  'gate.json',
] as const

/**
 * Pure containment predicate over already-resolved absolute paths. The
 * directory separator is appended only when the resolved outDir does not
 * already end with one, so an outDir that resolves to a filesystem root
 * ('/' on POSIX, 'C:\\' on Windows) no longer fails every export (the
 * separator-appended root was no longer a prefix of anything). Exported for
 * direct testing.
 */
export function isInsideOutDir(
  resolvedOutDir: string,
  resolvedTarget: string,
): boolean {
  if (resolvedTarget === resolvedOutDir) {
    return true
  }
  const prefix = resolvedOutDir.endsWith(path.sep)
    ? resolvedOutDir
    : resolvedOutDir + path.sep
  return resolvedTarget.startsWith(prefix)
}

/**
 * Assert a target file stays inside outDir (resolve + prefix check): the
 * export NEVER writes outside outDir, whatever a caller passes.
 */
function assertInsideOutDir(outDir: string, target: string): void {
  const resolvedTarget = path.resolve(target)
  if (!isInsideOutDir(path.resolve(outDir), resolvedTarget)) {
    throw new Error(
      `openbuff dash export: refusing to write outside outDir (${resolvedTarget})`,
    )
  }
}

function boundedMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.length <= 300 ? message : `${message.slice(0, 297)}...`
}

/**
 * Export the dashboard as a static site into outDir. `outDir` is created if
 * missing; the actual files land in a fresh `dash-` mkdtemp subdirectory
 * inside it (so a shared export root never collides). On success the five
 * written files are returned with ABSOLUTE paths; on any failure the error
 * is returned as `{ ok: false, error }` (bounded message), never thrown.
 */
export async function exportDashStatic(
  params: ExportDashStaticParams,
): Promise<ExportDashStaticResult> {
  try {
    const { outDir, data } = params
    if (typeof outDir !== 'string' || outDir.trim().length === 0) {
      return { ok: false, error: 'openbuff dash export: outDir is required' }
    }

    let dir: string
    try {
      await mkdir(outDir, { recursive: true })
      const stat_ = await stat(outDir)
      if (!stat_.isDirectory()) {
        return {
          ok: false,
          error: `openbuff dash export: outDir is not a directory: ${outDir}`,
        }
      }
      // mkdtemp into outDir keeps every write under it even for a shared root.
      dir = await mkdtemp(path.join(path.resolve(outDir), 'dash-'))
    } catch (error) {
      return { ok: false, error: `openbuff dash export: ${boundedMessage(error)}` }
    }

    // Gather the snapshot FIRST: runs, then each run's events (bounded to the
    // same cap the live server serves), then receipts and gate.
    const runs = await data.listRuns()
    const events: DashSnapshot['events'] = {}
    for (const run of runs) {
      const runEvents = await data.getRunEvents(run.runId)
      events[run.runId] = runEvents.slice(-DASH_MAX_EVENTS)
    }
    const receipts = await data.getReceipts()
    const gate = await data.getGateState()

    const snapshot: DashSnapshot = { runs, events, receipts, gate }

    const files: string[] = []
    for (const name of EXPORT_FILES) {
      const target = path.join(dir, name)
      assertInsideOutDir(outDir, target)
      const payload =
        name === 'runs.json'
          ? runs
          : name === 'events.json'
            ? events
            : name === 'receipts.json'
              ? receipts
              : gate
      // A provider may violate its contract and return undefined for
      // receipts/gate; mirror the server-side inliner's undefined→null
      // fallback so gate.json/receipts.json never contain the invalid JSON
      // text 'undefined'.
      const content =
        name === 'index.html'
          ? renderDashHtml(snapshot)
          : JSON.stringify(payload ?? null, null, 2) + '\n'
      await writeFile(target, content, 'utf8')
      files.push(target)
    }

    return { ok: true, files }
  } catch (error) {
    return { ok: false, error: `openbuff dash export: ${boundedMessage(error)}` }
  }
}

import { existsSync } from 'node:fs'
import path from 'node:path'

import { createRunJournal } from '@codebuff/agent-runtime/util/run-journal'
import {
  createDashProviderFromJournal,
  exportDashStatic,
  generateDashToken,
  startDashServer,
} from '@openbuff/sdk'

import { getCliEnv } from '../utils/env'
import { resolveRunJournalPath } from '../utils/run-journal-path'

import type { JournalReader } from '@codebuff/common/types/contracts/agent-runtime'

/**
 * The parsed `openbuff dash` invocation (mirrors `ParsedArgs.dash`): an
 * optional explicit port (undefined = 0 = random free port), an optional
 * explicit token, and exactly one mode — `exportDir` selects the static HTML
 * otherwise the dashboard serves. `open` mirrors `--no-open` (true by
 * default: the tokenless base URL is printed to stdout and the token-bearing
 * URL to stderr; with --no-open neither is printed — no browser is
 * auto-opened either way).
 */
export type DashCommandArgs = {
  port?: number
  token?: string
  exportDir?: string
  open: boolean
}

/**
 * P2-T7 live wiring: how `openbuff dash` opens the run journal FOR READING.
 * The opener owns its own connection (createRunJournal-based) and must never
 * write: the dash side never appends and never prunes — the journal is
 * append-only for the RUN side, read-only for the DASH side.
 */
export type DashJournalOpener = (path: string) => {
  reader: JournalReader
  close?: () => void
}

/**
 * Injectable seams for `runDashCommand`. Every dependency defaults to the
 * real implementation, so production callers pass nothing and tests inject
 * hermetic stubs (never touching a real journal or a real port).
 *
 * P2-T7 live wiring: when no explicit `journalReader` is injected, the dash
 * opens the LIVE run journal at `journalPath` (default: the shared
 * resolveRunJournalPath) through `openJournal` (default: the real
 * createRunJournal-based read-only opener) and serves it via
 * createDashProviderFromJournal — listRuns enumerates the journal's
 * `runIds()` extension. If the journal db file is ABSENT or cannot be
 * opened, the dashboard falls back to the empty-data provider with a
 * one-line stderr warning (fail-closed, never crash, never create the db
 * from the dash side).
 */
export type RunDashDeps = {
  journalReader?: NonNullable<
    Parameters<typeof createDashProviderFromJournal>[0]
  >['journalReader']
  receipts?: () => unknown[]
  gateState?: () => unknown | null
  writeStdout?: (chunk: string) => void
  writeStderr?: (line: string) => void
  /**
   * Overridable seam for tests (the real one binds a TCP port and its URL
   * embeds the auth token as ?token=...).
   */
  startServer?: typeof startDashServer
  /**
   * P2-T7: how the dash opens the run journal for reading. Defaults to the
   * real createRunJournal-based opener (read-only contract).
   */
  openJournal?: DashJournalOpener
  /** Journal db location; defaults to the shared resolveRunJournalPath(). */
  journalPath?: string
}

/**
 * The real dash-side journal opener: one createRunJournal connection owned
 * by the dash process, closed best-effort when the command ends. The dash
 * side NEVER writes (no append, no pruneRuns) — the journal is append-only
 * for the run side and read-only here.
 */
const defaultOpenJournal: DashJournalOpener = (journalFile) => {
  const journal = createRunJournal({ path: journalFile })
  return {
    reader: journal,
    close: () => {
      void journal.close().catch(() => {
        // Best-effort close; nothing further to do.
      })
    },
  }
}

/**
 * The `openbuff dash` entry the CLI dispatches BEFORE the TUI (P2-T7).
 *
 * Token contract: an explicit --token wins; otherwise OPENBUFF_DASH_TOKEN is
 * honored through the sanctioned getCliEnv() seam (never ambient process.env
 * — that seam is the established env architecture); otherwise a 256-bit
 * CSPRNG token is generated. A GENERATED token is printed to STDERR (never
 * stdout, which may be piped); an explicitly provided one is never echoed
 * back. An empty/whitespace --token is already rejected at parse time
 * (cli/src/cli-args.ts), because an empty expected token is an auth bypass.
 *
 * Journal contract (P2-T7 live wiring): the dash opens the run journal ONLY
 * after an existence check — an absent file is a fallback to the
 * empty-data provider (one stderr warning), never a db creation — and the
 * dash side is strictly read-only (no append, no pruneRuns). In serve mode
 * SIGINT/SIGTERM close the server AND the journal via a resolvable shutdown
 * promise; in --export mode the journal is closed in a finally.
 *
 * stdout contract: in serve mode stdout carries ONLY the tokenless base URL
 * (http://127.0.0.1:<port>, safe to pipe/tee); the token-bearing URL — which
 * embeds the auth token as ?token=... — goes to STDERR because stdout may
 * be piped. With --no-open the token-bearing URL is printed NOWHERE (neither
 * stdout nor stderr), honoring the option's documented "do not print the
 * dashboard URL on startup" contract; in --export mode stdout carries the
 * written file paths (one per line).
 * Everything human/diagnostic goes to stderr.
 *
 * The returned number is the process exit code (the caller owns
 * `process.exit` / `process.exitCode`): 0 on success, 1 on a server or
 * export failure. This function never throws for a failed dash run.
 */
export async function runDashCommand(
  args: DashCommandArgs,
  deps: RunDashDeps = {},
): Promise<number> {
  const writeStdout =
    deps.writeStdout ?? ((chunk: string) => process.stdout.write(chunk))
  const writeStderr =
    deps.writeStderr ?? ((line: string) => process.stderr.write(line + '\n'))

  const journalPath = deps.journalPath ?? resolveRunJournalPath()
  const openJournal = deps.openJournal ?? defaultOpenJournal

  /**
   * Open the live run journal for reading, fail-closed to undefined:
   * - the file must ALREADY exist (the dash never creates the db — an absent
   *   journal means no runs have been journaled yet, so empty data is the
   *   honest answer), and
   * - an open failure (e.g. sqlite cannot be acquired, a hostile db) falls
   *   back to empty data with a one-line stderr warning instead of crashing.
   * A dash that exists alongside a live WAL writer is safe to read from its
   * own connection (createRunJournal opens WAL + schema idempotently).
   */
  const openJournalIfPresent = ():
    | { reader: JournalReader; close?: () => void }
    | undefined => {
    if (!existsSync(journalPath)) {
      // Fail-closed: an ABSENT journal means no runs have been journaled yet,
      // so empty data is the honest answer — and the dash NEVER creates the
      // db (that would race a live WAL writer and fabricate state).
      writeStderr(
        'openbuff dash: run journal unavailable (no journal file yet), serving empty run data',
      )
      return undefined
    }
    try {
      return openJournal(journalPath)
    } catch (error) {
      writeStderr(
        `openbuff dash: run journal unavailable, serving empty run data (${
          error instanceof Error ? error.message : String(error)
        })`,
      )
      return undefined
    }
  }

  // The explicit journalReader seam wins (hermetic tests inject it); the
  // live journal is opened only when it will actually be used, so an
  // injected reader never leaks an unused connection. Exactly ONE warning
  // line fires on either fallback path.
  const journal = deps.journalReader ? undefined : openJournalIfPresent()

  const data = createDashProviderFromJournal({
    journalReader: deps.journalReader ?? journal?.reader,
    receipts: deps.receipts,
    gateState: deps.gateState,
  })

  // --export is mutually exclusive with serving by construction: the export
  // mode never starts a server. The journal is closed in a finally.
  if (args.exportDir) {
    try {
      const result = await exportDashStatic({
        outDir: path.resolve(args.exportDir),
        data,
      })
      if (!result.ok) {
        writeStderr(`openbuff dash: export failed: ${result.error}`)
        return 1
      }
      for (const file of result.files) {
        writeStdout(`${file}\n`)
      }
      return 0
    } finally {
      try {
        journal?.close?.()
      } catch {
        // Best-effort close; the export outcome is already decided.
      }
    }
  }

  const envToken = getCliEnv().OPENBUFF_DASH_TOKEN
  let token: string
  let generatedToken: string | undefined
  if (args.token) {
    token = args.token
  } else if (envToken) {
    token = envToken
  } else {
    token = generateDashToken()
    generatedToken = token
  }
  if (generatedToken) {
    // stderr ONLY: stdout may be piped, so the generated secret must never
    // ride stdout (the token-bearing URL goes to stderr too, not stdout).
    writeStderr(
      `openbuff dash: generated dashboard token (pass --token or set OPENBUFF_DASH_TOKEN to set your own): ${generatedToken}`,
    )
  }

  const startServer = deps.startServer ?? startDashServer
  try {
    const server = await startServer({
      port: args.port ?? 0,
      token,
      data,
    })
    if (args.open) {
      // stdout may be piped/tee'd, so it carries ONLY the tokenless base URL;
      // the token-bearing URL (which embeds the auth secret as ?token=...)
      // goes to stderr, clearly labeled.
      writeStdout(`${new URL(server.url).origin}\n`)
      writeStderr(
        `openbuff dash: serving at ${server.url} (the URL embeds the auth token; stdout carries only the tokenless base URL)`,
      )
    }
    // --no-open contract: the URL embeds the auth token (?token=...), so with
    // --no-open it is printed NOWHERE — stderr included.
    writeStderr('openbuff dash: press Ctrl+C to stop')
    // P2-T7: keep the process alive until SIGINT/SIGTERM — the promise
    // resolves ONLY through the shutdown handler (never on empty event data).
    // The handler closes the server; the journal is closed once in the
    // finally below (single-owner cleanup, no double close).
    await new Promise<void>((resolveShutdown) => {
      const shutdown = (): void => {
        process.off('SIGINT', shutdown)
        process.off('SIGTERM', shutdown)
        void server.close().catch(() => {
          // Best-effort server close; the shutdown still resolves.
        })
        resolveShutdown()
      }
      process.once('SIGINT', shutdown)
      process.once('SIGTERM', shutdown)
    })
    return 0
  } catch (error) {
    writeStderr(
      `openbuff dash: ${error instanceof Error ? error.message : String(error)}`,
    )
    return 1
  } finally {
    try {
      journal?.close?.()
    } catch {
      // Best-effort close; the dash outcome is already decided.
    }
  }
}

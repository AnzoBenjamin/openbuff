import {
  createDashProviderFromJournal,
  exportDashStatic,
  generateDashToken,
  startDashServer,
} from '@openbuff/sdk'

import { getCliEnv } from '../utils/env'
import path from 'node:path'

/**
 * The parsed `openbuff dash` invocation (mirrors `ParsedArgs.dash`): an
 * optional explicit port (undefined = 0 = random free port), an optional
 * explicit token, and exactly one mode — `exportDir` selects the static HTML
 * otherwise the dashboard serves. `open` mirrors `--no-open` (true by
 * default: the URL is printed to stdout; with --no-open the URL is not
 * printed anywhere — no browser is auto-opened either way).
 */
export type DashCommandArgs = {
  port?: number
  token?: string
  exportDir?: string
  open: boolean
}

/**
 * Injectable seams for `runDashCommand`. Every dependency defaults to the
 * real implementation, so production callers pass nothing and tests inject
 * hermetic stubs (never touching a real journal or a real port).
 * `journalReader`/`receipts`/`gateState` are the same seams
 * `createDashProviderFromJournal` takes: the wiring of a LIVE run's journal
 * reader is the documented follow-up, so by default the dashboard serves
 * empty run/event data (the server + export + CLI contract is the
 * deliverable).
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
 * stdout contract: in serve mode stdout carries the dashboard URL (nothing
 * else); with --no-open the URL — which embeds the auth token as ?token=... —
 * is printed NOWHERE (neither stdout nor stderr), honoring the option's
 * documented "do not print the dashboard URL on startup" contract; in
 * --export mode stdout carries the written file paths (one per line).
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

  const data = createDashProviderFromJournal({
    journalReader: deps.journalReader,
    receipts: deps.receipts,
    gateState: deps.gateState,
  })

  // --export is mutually exclusive with serving by construction: the export
  // mode never starts a server.
  if (args.exportDir) {
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
    // stderr ONLY: stdout may be piped (the URL goes there), so the generated
    // secret must never ride stdout.
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
      writeStdout(`${server.url}\n`)
    }
    // --no-open contract: the URL embeds the auth token (?token=...), so with
    // --no-open it is printed NOWHERE — stderr included.
    writeStderr('openbuff dash: press Ctrl+C to stop')
    // Keep the process alive until the dashboard is stopped: the returned
    // promise resolves only when close() is invoked (or the process dies).
    await new Promise<void>(() => {})
    return 0
  } catch (error) {
    writeStderr(
      `openbuff dash: ${error instanceof Error ? error.message : String(error)}`,
    )
    return 1
  }
}

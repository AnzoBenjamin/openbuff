import { randomBytes } from 'node:crypto'
import path from 'node:path'

import { AcpSessionData, runServe } from '@openbuff/sdk'

import { getProjectRoot } from './project-files'
import { getSystemProcessEnv } from './utils/env'
import { getCodebuffClient } from './utils/codebuff-client'
import { resolveTrustedRootsPath } from './utils/trusted-roots'

import type { ServeBridgeClient } from '@openbuff/sdk'

/**
 * The parsed `openbuff serve` transport selection (mirrors
 * `ParsedArgs.serve`): stdio serves ACP over the process stdio streams, and
 * socket serves it over a SEC-4-authenticated unix domain socket with an
 * optional caller-supplied token. `trustProjectAgents` carries the effective
 * serve trust decision (flag OR trusted-roots allowlist, resolved in
 * cli/src/index.tsx) reported on the stderr banner; optional so injected
 * callers can omit it.
 */
export type ServeCommandArgs =
  | {
      transport: 'stdio'
      agentId?: string
      trustProjectAgents?: boolean
    }
  | {
      transport: 'socket'
      socketPath: string
      token?: string
      agentId?: string
      trustProjectAgents?: boolean
    }

/**
 * Fully-injectable seams for `runAcpServeCommand`. Every dependency defaults
 * to the real CLI/SDK implementation, so production callers pass nothing and
 * tests inject hermetic stubs (never touching a real client, socket, or fs).
 */
export type RunAcpServeDeps = {
  getClient?: () => Promise<ServeBridgeClient>
  makeSessionData?: (opts: { journalDir: string }) => AcpSessionData
  runServeImpl?: typeof runServe
  generateToken?: () => string
  writeStderr?: (line: string) => void
  /**
   * Resolved trusted-roots allowlist path for the untrusted banner hint
   * (defaults to resolveTrustedRootsPath()); injected in tests so the banner
   * never depends on the real env.
   */
  trustedRootsPath?: string
  journalDir?: string
  signal?: AbortSignal
}

/**
 * The `openbuff serve` entry the CLI dispatches BEFORE the TUI. It builds the
 * journal-backed `AcpSessionData` and the real `OpenbuffClient`, then starts
 * the ACP bridge on the chosen transport and returns its `{ close }`.
 *
 * stdout is the ACP protocol wire in serve mode, so EVERY human-readable line
 * goes to stderr via `writeStderr` — nothing is ever written to stdout here.
 * For socket mode the token is generated when the user did not pass one and
 * printed (with the socket path) to stderr so a client can connect. The
 * journal directory makes ACP sessions restore across process restarts.
 */
export async function runAcpServeCommand(
  args: ServeCommandArgs,
  deps?: RunAcpServeDeps,
): Promise<{ close: () => Promise<void> }> {
  const getClient = deps?.getClient ?? (() => getCodebuffClient())
  const makeSessionData =
    deps?.makeSessionData ??
    (({ journalDir }: { journalDir: string }) =>
      new AcpSessionData({ journalDir }))
  const runServeImpl = deps?.runServeImpl ?? runServe
  const generateToken =
    deps?.generateToken ?? (() => randomBytes(32).toString('hex'))
  const writeStderr =
    deps?.writeStderr ?? ((line: string) => process.stderr.write(line + '\n'))
  // Resolve getProjectRoot() lazily here (after initializeApp has run in
  // index.tsx), never at module load; tests that inject journalDir never call it.
  const journalDir =
    deps?.journalDir ??
    path.join(getProjectRoot(), '.openbuff', 'acp-journal')

  // NEW-2 (design §12.8): report the project-scope agent/MCP trust decision
  // on stderr for BOTH transports (stdout is the ACP protocol wire). The hint
  // names the ACTUAL resolved allowlist path (config-dir precedence:
  // OPENBUFF_CONFIG_DIR / XDG_CONFIG_HOME / APPDATA), never a hardcoded
  // ~/.config guess (reviewer finding trusted-roots-path-ignores-config-env /
  // RF-14). Tests inject trustedRootsPath to stay hermetic.
  const trustedRootsHintPath =
    deps?.trustedRootsPath ?? resolveTrustedRootsPath()
  writeStderr(
    'openbuff serve: project agents ' +
      (args.trustProjectAgents
        ? 'trusted'
        : `untrusted (use --trust-project-agents or add the project root to ${trustedRootsHintPath})`),
  )

  const sessionData = makeSessionData({ journalDir })
  const client = await getClient()

  if (args.transport === 'stdio') {
    // Human line to STDERR only — stdout is the ACP protocol wire.
    writeStderr('openbuff serve: ACP v1 over stdio')
    return runServeImpl({
      client,
      sessionData,
      transport: { kind: 'stdio' },
      agentId: args.agentId,
      signal: deps?.signal,
      // NEW-3 (§12.8): hand the live environment to runServe so the SDK
      // collects the configured credential VALUES for the streaming holdback.
      credentialEnv: getSystemProcessEnv(),
    })
  }

  const token = args.token ?? generateToken()
  const listener = runServeImpl({
    client,
    sessionData,
    transport: { kind: 'socket', socketPath: args.socketPath, token },
    agentId: args.agentId,
    signal: deps?.signal,
    // NEW-3 (§12.8): same credential collection for the socket transport.
    credentialEnv: getSystemProcessEnv(),
  })
  // Connection info to STDERR so a client can connect; token never hits stdout.
  writeStderr(`openbuff serve: ACP v1 over unix socket ${args.socketPath}`)
  writeStderr(`openbuff serve token: ${token}`)
  return listener
}

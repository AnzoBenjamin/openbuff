import { lstatSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import path from 'node:path'

import {
  AcpSessionData,
  getConfiguredCredentialEnvKeys,
  runServe,
  WELL_KNOWN_CREDENTIAL_ENV_KEYS,
} from '@openbuff/sdk'

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
  /**
   * SEC-7 (§12.5) containment anchor threaded into runServe for BOTH
   * transports. Optional so tests inject it; defaults to the CLI project
   * root resolved by getProjectRoot().
   */
  projectRoot?: string
  signal?: AbortSignal
  /**
   * SEC (review: serve-socket-symlink): pre-bind socket-path safety gate.
   * Defaults to `assertSocketPathIsNotSymlink` (lstat the resolved path and
   * fail closed when it is an existing symlink); injected in tests so no
   * real filesystem is touched.
   */
  assertSocketPathSafe?: (socketPath: string) => void
}

/**
 * SEC: the default socket-path safety gate, run BEFORE the socket transport
 * binds. An attacker who can plant a symlink at the configured socket path
 * could otherwise redirect the bind (or make the bind clobber a link target
 * elsewhere). The resolved path is lstat'd (symlinks are NOT followed): an
 * existing symlink fails closed with a clear error; a regular file or an
 * absent path (the normal bind case, where the socket is created by
 * `runServe`) passes.
 */
export function assertSocketPathIsNotSymlink(socketPath: string): void {
  const resolved = path.resolve(socketPath)
  const stat = lstatSync(resolved, { throwIfNoEntry: false })
  if (stat?.isSymbolicLink()) {
    throw new Error(
      `refusing to bind serve socket: ${socketPath} is a symlink (resolves to ${resolved}); remove the symlink or choose a different --socket path`,
    )
  }
}

/**
 * Builds the `credentialEnv` projection for `runServe` (NEW-3, §12.8): the
 * host environment restricted to credential-bearing keys — the well-known
 * holdback keys plus every `apiKeyEnv` name the provider configuration
 * declares (built-in presets and custom openbuff.json providers). Values
 * come only from the live process env; non-credential env vars are never
 * copied, so the SDK holdback sees exactly the credentials it must never
 * split and nothing else. A failed provider-config load degrades to the
 * well-known keys alone (a config-load failure must never break serving,
 * and degrading means LESS credential exposure, not more).
 */
function buildCredentialEnv(): Record<string, string | undefined> {
  const source = getSystemProcessEnv()
  const keys = new Set<string>(WELL_KNOWN_CREDENTIAL_ENV_KEYS)
  try {
    for (const key of getConfiguredCredentialEnvKeys(source)) {
      keys.add(key)
    }
  } catch {
    // Provider config unavailable (e.g. invalid OPENBUFF_PROVIDER_CONFIG
    // override): fall back to the well-known keys only.
  }
  const credentialEnv: Record<string, string | undefined> = {}
  for (const key of keys) {
    credentialEnv[key] = source[key]
  }
  return credentialEnv
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
  // SEC-7 (audit HIGH #1): resolve the containment root ONCE and thread it
  // into runServe for BOTH transports, so the SDK's SEC-7 cwd containment
  // and additionalDirectories allowlist are actually wired. Injectable via
  // deps.projectRoot so tests never call getProjectRoot(). Resolved lazily
  // here (after initializeApp has run in index.tsx), never at module load.
  const projectRoot = deps?.projectRoot ?? getProjectRoot()
  const journalDir =
    deps?.journalDir ?? path.join(projectRoot, '.openbuff', 'acp-journal')

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
      // NEW-3 (§12.8): hand the credential-allowlisted env to runServe so
      // the SDK collects the configured credential VALUES for the streaming
      // holdback — never the rest of the host environment.
      credentialEnv: buildCredentialEnv(),
      // SEC-7 (audit HIGH #1): bind the containment root for stdio too.
      projectRoot,
    })
  }

  // SEC (review: serve-socket-symlink): fail closed BEFORE bind when the
  // configured socket path is an existing symlink. Injectable so tests stay
  // hermetic.
  const assertSocketPathSafe =
    deps?.assertSocketPathSafe ?? assertSocketPathIsNotSymlink
  assertSocketPathSafe(args.socketPath)

  const token = args.token ?? generateToken()
  const listener = runServeImpl({
    client,
    sessionData,
    transport: { kind: 'socket', socketPath: args.socketPath, token },
    agentId: args.agentId,
    signal: deps?.signal,
    // NEW-3 (§12.8): same credential-allowlisted collection for the socket
    // transport.
    credentialEnv: buildCredentialEnv(),
    // SEC-7 (audit HIGH #1): bind the containment root for socket mode,
    // decided once here at serve start (never per connection).
    projectRoot,
  })
  // Connection info to STDERR so a client can connect; token never hits stdout.
  writeStderr(`openbuff serve: ACP v1 over unix socket ${args.socketPath}`)
  writeStderr(`openbuff serve token: ${token}`)
  return listener
}

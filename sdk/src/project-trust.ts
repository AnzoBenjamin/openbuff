/**
 * N02 project trust gate: persisted per-project trust decisions.
 *
 * A project's `openbuff.json` / `openbuff.d/` (and `.agents/mcp.json`) may
 * only tighten policy until the user trusts the project. The decision is
 * stored OUTSIDE the repository, in the Openbuff config directory
 * (`<configDir>/project-trust.json`, written owner-only), keyed by the
 * project's canonical path and bound to a hash of the project config bytes.
 * Any change to that hash makes the stored decision stale, so the host asks
 * again. Both provider-config loaders (the captured host snapshot used by
 * `run()`/`serve` and the legacy `loadProviderConfigSync` used by the CLI)
 * resolve trust through this module, so TUI, `run`, `serve` and SDK hosts
 * see the same answer.
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export const PROJECT_TRUST_FILE_NAME = 'project-trust.json'
/** CI/automation opt-in, mirroring OPENBUFF_TRUST_ANCESTOR_CONFIG. */
export const PROJECT_TRUST_ENV_VAR = 'OPENBUFF_TRUST_PROJECT_CONFIG'

export type ProjectTrustDecision = 'trusted' | 'untrusted'
export type ProjectTrustSource = 'prompt' | 'flag' | 'sdk' | 'command'

export type ProjectTrustRecord = {
  decision: ProjectTrustDecision
  configHash: string
  decidedAt: string
  source: ProjectTrustSource
}

export type ProjectTrustStore = {
  version: 1
  projects: Record<string, ProjectTrustRecord>
}

export type ProjectTrustGatedKind =
  | 'provider'
  | 'route'
  | 'fileChangeHooks'
  | 'autoFileChangeHooks'
  | 'approvalMode'
  | 'sandbox'
  | 'semanticIndexing'

/** One thing the project config would enable. Withheld while untrusted. */
export type ProjectTrustGatedItem = {
  kind: ProjectTrustGatedKind
  /** The project config file that declared it. */
  filePath: string
  summary: string
}

export type ProjectTrustReason =
  /** Host passed an explicit decision (SDK option, CLI flag, env opt-in). */
  | 'explicit'
  /** Stored decision whose config hash matches. */
  | 'stored'
  /** Stored decision exists but the project config changed since. */
  | 'changed'
  /** No stored decision for this project. */
  | 'unknown'

export type ProjectTrustState = {
  projectRoot: string
  configHash: string
  status: ProjectTrustDecision
  reason: ProjectTrustReason
  /** Project-scope config files that contributed (hash inputs). */
  files: string[]
  /** What the project config would enable; withheld when status is untrusted. */
  gated: ProjectTrustGatedItem[]
}

/** Read-only view accepted by helpers, so frozen snapshot state can be passed directly. */
export type ProjectTrustStateView = Readonly<{
  projectRoot: string
  status: ProjectTrustDecision
  reason: ProjectTrustReason
  gated: readonly Readonly<ProjectTrustGatedItem>[]
}>

const HASH_PREFIX = 'sha256:'

/** Stable hash over the project-scope config files (path + content). */
export function computeProjectConfigHash(
  projectRoot: string,
  files: readonly Readonly<{ path: string; bytes: Uint8Array }>[],
): string {
  const entries = files
    .map((file) => {
      const relative = path.relative(projectRoot, file.path)
      const display =
        relative && !relative.startsWith('..') && !path.isAbsolute(relative)
          ? relative.split(path.sep).join('/')
          : file.path
      return [display, createHash('sha256').update(file.bytes).digest('hex')]
    })
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return (
    HASH_PREFIX +
    createHash('sha256')
      .update(JSON.stringify(['openbuff.project-trust.v1', entries]))
      .digest('hex')
  )
}

function emptyStore(): ProjectTrustStore {
  return { version: 1, projects: Object.create(null) }
}

/** Fail closed: anything malformed yields an empty store (nothing trusted). */
export function parseProjectTrustStore(text: string): ProjectTrustStore {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return emptyStore()
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    (parsed as { version?: unknown }).version !== 1
  )
    return emptyStore()
  const projects = (parsed as { projects?: unknown }).projects
  if (!projects || typeof projects !== 'object' || Array.isArray(projects))
    return emptyStore()
  const store = emptyStore()
  for (const [root, value] of Object.entries(projects)) {
    if (!path.isAbsolute(root) || !value || typeof value !== 'object') continue
    const record = value as Partial<ProjectTrustRecord>
    if (
      (record.decision !== 'trusted' && record.decision !== 'untrusted') ||
      typeof record.configHash !== 'string' ||
      !record.configHash.startsWith(HASH_PREFIX)
    )
      continue
    store.projects[root] = {
      decision: record.decision,
      configHash: record.configHash,
      decidedAt: typeof record.decidedAt === 'string' ? record.decidedAt : '',
      source:
        record.source === 'prompt' ||
        record.source === 'flag' ||
        record.source === 'sdk' ||
        record.source === 'command'
          ? record.source
          : 'prompt',
    }
  }
  return store
}

export function getProjectTrustStorePath(configDir: string): string {
  return path.join(configDir, PROJECT_TRUST_FILE_NAME)
}

export function readProjectTrustStoreSync(configDir: string): ProjectTrustStore {
  try {
    return parseProjectTrustStore(
      fs.readFileSync(getProjectTrustStorePath(configDir), 'utf8'),
    )
  } catch {
    return emptyStore()
  }
}

export function resolveStoredProjectTrust(
  store: ProjectTrustStore,
  projectRoot: string,
  configHash: string,
): { status: ProjectTrustDecision; reason: ProjectTrustReason } {
  const record = store.projects[projectRoot]
  if (!record) return { status: 'untrusted', reason: 'unknown' }
  if (record.configHash !== configHash)
    return { status: 'untrusted', reason: 'changed' }
  return { status: record.decision, reason: 'stored' }
}

/**
 * Persist a decision for (projectRoot, configHash). Atomic write, owner-only
 * mode. Returns false if the store could not be written (the caller still
 * applies the decision for the current process).
 */
export function recordProjectTrustDecision(params: {
  configDir: string
  projectRoot: string
  configHash: string
  decision: ProjectTrustDecision
  source: ProjectTrustSource
  now?: () => Date
}): boolean {
  const filePath = getProjectTrustStorePath(params.configDir)
  try {
    const store = readProjectTrustStoreSync(params.configDir)
    store.projects[params.projectRoot] = {
      decision: params.decision,
      configHash: params.configHash,
      decidedAt: (params.now?.() ?? new Date()).toISOString(),
      source: params.source,
    }
    fs.mkdirSync(params.configDir, { recursive: true, mode: 0o700 })
    const temp = `${filePath}.${process.pid}.${Date.now()}.tmp`
    fs.writeFileSync(temp, JSON.stringify(store, null, 2) + '\n', {
      mode: 0o600,
    })
    fs.renameSync(temp, filePath)
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Process-scoped host decision. A host (the CLI after its trust prompt or
// `--trust-project-agents`) sets this once; both loaders honour it for the
// matching canonical project root only. Explicit per-call SDK options win.
// ---------------------------------------------------------------------------
let processDecision:
  | { projectRoot: string; decision: ProjectTrustDecision }
  | undefined

export function canonicalProjectRoot(projectRoot: string): string {
  const resolved = path.resolve(projectRoot)
  try {
    return fs.realpathSync(resolved)
  } catch {
    return resolved
  }
}

export function setProjectTrustOverride(
  value: { projectRoot: string; decision: ProjectTrustDecision } | undefined,
): void {
  processDecision = value
    ? {
        projectRoot: canonicalProjectRoot(value.projectRoot),
        decision: value.decision,
      }
    : undefined
}

export function getProjectTrustOverride(
  projectRoot: string,
): ProjectTrustDecision | undefined {
  if (!processDecision) return undefined
  return processDecision.projectRoot === canonicalProjectRoot(projectRoot)
    ? processDecision.decision
    : undefined
}

/** Cache-key fragment for loaders that memoize on trust inputs. */
export function describeProjectTrustOverride(): string {
  return processDecision
    ? `${processDecision.projectRoot}=${processDecision.decision}`
    : ''
}

/** True when the host should ask: untrusted, not explicitly decided, and something is gated. */
export function needsProjectTrustDecision(
  state: ProjectTrustStateView | undefined,
  extra: { hasProjectAgentsOrSkills?: boolean } = {},
): boolean {
  if (!state || state.status === 'trusted') return false
  if (state.reason === 'explicit' || state.reason === 'stored') return false
  return state.gated.length > 0 || extra.hasProjectAgentsOrSkills === true
}

export function formatProjectTrustItems(state: ProjectTrustStateView): string[] {
  return state.gated.map((item) => {
    const relative = path.relative(state.projectRoot, item.filePath)
    const file =
      relative && !relative.startsWith('..') && !path.isAbsolute(relative)
        ? relative
        : item.filePath
    return `${item.summary} (${file})`
  })
}

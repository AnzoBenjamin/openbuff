import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createHostReadPolicy } from '@codebuff/common/util/project-path-containment'

import { getValidChatGptOAuthCredentials, refreshChatGptOAuthToken } from './credentials'
import { CREDENTIAL_ENV_KEYS } from './credential-env-keys'
import { getSystemProcessEnv, getChatGptOAuthTokenFromEnv } from './env'
import { PROJECT_TRUST_ENV_VAR, getProjectTrustOverride } from './project-trust'
import { loadProviderConfigForHost } from './provider-config'

import type { HostReadPolicy } from '@codebuff/common/util/project-path-containment'
import type { ChatGptOAuthCredentials } from './credentials'
import type { ProjectTrustDecision } from './project-trust'
import type { ConfigReadFs, LoadedProviderConfig } from './provider-config'

export type DeepReadonly<T> = T extends (...args: never[]) => unknown ? T :
  T extends readonly (infer V)[] ? readonly DeepReadonly<V>[] :
  T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T

export type HostConfigurationInputs = Readonly<{
  environment: Readonly<Record<string, string | undefined>>
  platform: NodeJS.Platform
  invocationCwd: string
  projectRoot: string
  home: Readonly<{ kind: 'path'; path: string }> | Readonly<{ kind: 'none' }>
  globals: Readonly<{ kind: 'directory'; path: string }> | Readonly<{ kind: 'disabled' }>
  selection: Readonly<{ kind: 'discover' }> | Readonly<{ kind: 'explicit'; path: string; required: true }> | Readonly<{ kind: 'none' }>
  /**
   * projectConfig (N02): explicit host decision for project-scope
   * openbuff.json/openbuff.d. Absent means "use the stored decision for this
   * project path + config hash" (untrusted when none matches).
   */
  trust: Readonly<{ ancestorConfig: boolean; projectReadableRoots: boolean; projectConfig?: ProjectTrustDecision }>
}>

export type HostConfigSnapshot = Readonly<{
  snapshotId: string
  inputs: HostConfigurationInputs
  loaded: DeepReadonly<LoadedProviderConfig>
  sourceBytesIdentity: string
  credentialNames: readonly string[]
  readableRoots: readonly string[]
  /**
   * Opt-in sandbox policy distilled from the loaded `sandbox` block: mode
   * 'unrestricted' (the default — block ABSENT) is fully unrestricted
   * filesystem and terminal access; 'project' re-enables containment.
   * allowPaths is the trust-gated subset of `sandbox.allowPaths` (absolute
   * entries whose declaring file passed the same origin gate readableRoots
   * uses, reusing inputs.trust.projectReadableRoots; the configDir itself is
   * NOT auto-included — that concession is readableRoots-specific).
   */
  sandboxPolicy: Readonly<{ mode: 'unrestricted' | 'project'; allowPaths: readonly string[] }>
  readPolicy: HostReadPolicy
  configDir?: string
  /** Captured canonical declaring file; read/ancestor trust never grants execution trust. */
  executionOrigin?: Readonly<{ filePath: string; trusted: boolean }>
}>

export type SnapshotResult = Readonly<{ status: 'complete'; snapshot: HostConfigSnapshot }> |
  Readonly<{ status: 'unavailable'; cause: string }>

export interface CapturedCredentialPort {
  getValidChatGptOAuthCredentials(): Promise<ChatGptOAuthCredentials | null>
  refreshChatGptOAuthToken?(): Promise<ChatGptOAuthCredentials | null>
}

export type ProviderHostContext = Readonly<{
  snapshot: HostConfigSnapshot
  credentialEnvironment: Readonly<Record<string, string | undefined>>
  credentials: CapturedCredentialPort
}>

const snapshots = new WeakSet<object>()
const providerContexts = new WeakSet<object>()

function freezeCopy<T>(value: T): T {
  if (Array.isArray(value)) return Object.freeze(value.map(freezeCopy)) as T
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = Object.create(null)
    for (const [key, entry] of Object.entries(value)) result[key] = freezeCopy(entry)
    return Object.freeze(result) as T
  }
  return value
}

function absoluteFrom(base: string, candidate: string): string {
  if (!candidate || candidate.includes('\0')) throw new Error('Invalid captured configuration path')
  return path.resolve(base, candidate)
}

/** Ambient reads are confined to this intake wrapper. Child env overrides never reach it. */
export function captureAmbientHostInputs(p: {
  cwd: string
  projectRoot: string
  /** N02: explicit project trust decision from the SDK host. Wins over the process override and env opt-in. */
  projectTrust?: ProjectTrustDecision
}): HostConfigurationInputs {
  const environment = { ...getSystemProcessEnv() }
  const platform = process.platform
  const home = os.homedir()
  const invocationCwd = path.resolve(p.cwd)
  const projectRoot = path.resolve(p.projectRoot)
  const configDir = environment.OPENBUFF_CONFIG_DIR ??
    (platform === 'win32' && environment.APPDATA ? path.join(environment.APPDATA, 'openbuff') : undefined) ??
    (environment.XDG_CONFIG_HOME ? path.join(environment.XDG_CONFIG_HOME, 'openbuff') : path.join(home, '.config', 'openbuff'))
  const projectConfig = p.projectTrust ?? getProjectTrustOverride(projectRoot) ??
    (environment[PROJECT_TRUST_ENV_VAR] === '1' ? 'trusted' as const : undefined)
  return freezeCopy({ environment, platform, invocationCwd, projectRoot,
    home: { kind: 'path', path: home }, globals: { kind: 'directory', path: absoluteFrom(invocationCwd, configDir) },
    selection: environment.OPENBUFF_PROVIDER_CONFIG ? { kind: 'explicit', path: environment.OPENBUFF_PROVIDER_CONFIG, required: true } : { kind: 'discover' },
    trust: { ancestorConfig: environment.OPENBUFF_TRUST_ANCESTOR_CONFIG === '1',
      projectReadableRoots: environment.OPENBUFF_TRUST_PROJECT_READABLE_ROOTS === '1',
      ...(projectConfig ? { projectConfig } : {}) } })
}

export function getConfigDirForContext(inputs: HostConfigurationInputs): string | undefined {
  return inputs.globals.kind === 'disabled' ? undefined : absoluteFrom(inputs.invocationCwd, inputs.globals.path)
}

export function getAncestorProviderConfigPathsForContext(inputs: HostConfigurationInputs): readonly string[] {
  const paths: string[] = []
  let current = inputs.invocationCwd
  const home = inputs.home.kind === 'path' ? absoluteFrom(inputs.invocationCwd, inputs.home.path) : undefined
  for (let depth = 0; depth < (inputs.trust.ancestorConfig ? Number.MAX_SAFE_INTEGER : 10); depth++) {
    paths.push(path.join(current, 'openbuff.json'))
    const parent = path.dirname(current)
    if ((!inputs.trust.ancestorConfig && current === home) || parent === current) break
    current = parent
  }
  return paths
}

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative))
}

export function isTrustedProviderConfigPathForContext(filePath: string, inputs: HostConfigurationInputs): boolean {
  if (inputs.trust.ancestorConfig) return true
  const resolved = absoluteFrom(inputs.invocationCwd, filePath)
  const globalDir = getConfigDirForContext(inputs)
  return inside(inputs.projectRoot, resolved) || (globalDir !== undefined && inside(globalDir, resolved)) ||
    (inputs.selection.kind === 'explicit' && resolved === absoluteFrom(inputs.invocationCwd, inputs.selection.path))
}

export function extractConfiguredCredentialNames(loaded: DeepReadonly<LoadedProviderConfig>): readonly string[] {
  return Object.freeze([...new Set(Object.values(loaded.config.providers).flatMap(provider =>
    'apiKeyEnv' in provider && provider.apiKeyEnv ? [provider.apiKeyEnv] : []))].sort())
}

export const nodeConfigReadFs: ConfigReadFs = Object.freeze({
  readFile: (filePath: string) => new Uint8Array(fs.readFileSync(filePath)),
  stat: (filePath: string) => {
    const stat = fs.statSync(filePath)
    return { kind: stat.isFile() ? 'file' as const : stat.isDirectory() ? 'directory' as const : 'other' as const,
      size: stat.size, revision: `${stat.dev}:${stat.ino}:${stat.mtimeMs}:${stat.ctimeMs}` }
  },
  readDirectory: (directory: string) => fs.readdirSync(directory),
  realpath: (filePath: string) => fs.realpathSync(filePath),
})

/** Strict named-observation consistency checking; this is not filesystem linearizability. */
export function loadHostConfigSnapshot(p: { inputs: HostConfigurationInputs; fs: ConfigReadFs }): SnapshotResult {
  try {
    const input = p.inputs
    if (!input || !path.isAbsolute(input.invocationCwd) || !path.isAbsolute(input.projectRoot) ||
      !input.environment || typeof input.environment !== 'object' || Array.isArray(input.environment) ||
      Object.entries(input.environment).some(([name, entry]) => !name || /[=\0]/.test(name) || (entry !== undefined && (typeof entry !== 'string' || entry.includes('\0')))) ||
      !['win32', 'linux', 'darwin', 'aix', 'freebsd', 'openbsd', 'sunos', 'android', 'haiku', 'cygwin', 'netbsd'].includes(input.platform) ||
      !input.home || !['path', 'none'].includes(input.home.kind) || !input.globals || !['directory', 'disabled'].includes(input.globals.kind) ||
      !input.selection || !['none', 'explicit', 'discover'].includes(input.selection.kind) ||
      (input.selection.kind === 'explicit' && input.selection.required !== true) ||
      typeof input.trust?.ancestorConfig !== 'boolean' || typeof input.trust?.projectReadableRoots !== 'boolean' ||
      (input.trust.projectConfig !== undefined && input.trust.projectConfig !== 'trusted' && input.trust.projectConfig !== 'untrusted'))
      return { status: 'unavailable', cause: 'Invalid explicit host configuration inputs' }
    const inputs = freezeCopy({ ...input, invocationCwd: path.resolve(input.invocationCwd), projectRoot: path.resolve(input.projectRoot) })
    if (inputs.home.kind === 'path') absoluteFrom(inputs.invocationCwd, inputs.home.path)
    const configDir = getConfigDirForContext(inputs)
    const key = randomBytes(32)
    const observations = new Map<string, { identity: string; check: () => string }>()
    const identity = (value: unknown) => createHmac('sha256', key).update(JSON.stringify(value)).digest('hex')
    function observe<T>(operation: string, filePath: string, read: () => T, encode: (result: T) => unknown): T {
      if (!path.isAbsolute(filePath) || filePath.includes('\0')) throw new Error('Config read requires a captured absolute path')
      const observationId = JSON.stringify([operation, filePath])
      const sample = () => {
        try { const result = read(); return { result, identity: identity(['present', encode(result)]) } }
        catch (error) {
          const code = (error as NodeJS.ErrnoException).code
          if ((operation === 'stat' || operation === 'realpath') && (code === 'ENOENT' || code === 'ENOTDIR'))
            return { error, identity: identity(['absent', code]) }
          throw error
        }
      }
      const current = sample()
      const old = observations.get(observationId)
      if (old && old.identity !== current.identity) throw new Error('Configuration changed during capture')
      observations.set(observationId, { identity: current.identity, check: () => sample().identity })
      if ('error' in current) throw current.error
      return current.result
    }
    const reader: ConfigReadFs = {
      readFile: filePath => observe('read', filePath, () => new Uint8Array(p.fs.readFile(filePath)), bytes => [...bytes]),
      stat: filePath => observe('stat', filePath, () => p.fs.stat(filePath), stat => [stat.kind, stat.size, stat.revision]),
      readDirectory: directory => observe('directory', directory, () => [...p.fs.readDirectory(directory)].sort(), names => names),
      realpath: filePath => observe('realpath', filePath, () => p.fs.realpath(filePath), result => result),
    }
    const configPaths = inputs.selection.kind === 'none' ? [] : inputs.selection.kind === 'explicit' ?
      [{ path: absoluteFrom(inputs.invocationCwd, inputs.selection.path), required: true }] :
      [...(configDir ? [path.join(configDir, 'provider-config.json'), path.join(configDir, 'openbuff.json')] : []),
        ...getAncestorProviderConfigPathsForContext(inputs)].map(selected => ({ path: selected, required: false }))
    // Resolve trust roots through the same observed port when they exist.
    const trustedRoot = (candidate: string) => {
      try { return reader.realpath(candidate) }
      catch (error) { const code = (error as NodeJS.ErrnoException).code; if (code === 'ENOENT' || code === 'ENOTDIR') return candidate; throw error }
    }
    const realProjectRoot = trustedRoot(inputs.projectRoot)
    const realConfigDir = configDir ? trustedRoot(configDir) : undefined
    const realExplicit = inputs.selection.kind === 'explicit' ? trustedRoot(absoluteFrom(inputs.invocationCwd, inputs.selection.path)) : undefined
    const isTrusted = (candidate: string) => inputs.trust.ancestorConfig || inside(realProjectRoot, candidate) ||
      (realConfigDir !== undefined && inside(realConfigDir, candidate)) || candidate === realExplicit
    // N02: everything outside the user config dir and the explicit selection is
    // project scope and only tightens policy until the project is trusted.
    const isUserScope = (selectedPath: string) => inputs.selection.kind === 'explicit' ||
      (configDir !== undefined && inside(configDir, selectedPath))
    const loaded = loadProviderConfigForHost({ configPaths, reader, isTrustedPath: isTrusted,
      projectTrust: { projectRoot: realProjectRoot, isUserScope, explicit: inputs.trust.projectConfig,
        storeDir: realConfigDir } })
    const executionFile = loaded.sourceFiles?.execution
    const executionOrigin = executionFile === undefined ? undefined : Object.freeze({
      filePath: executionFile,
      trusted: (realConfigDir !== undefined && inside(realConfigDir, executionFile)) || executionFile === realExplicit,
    })
    const readableRoots = [...new Set([...(configDir ? [configDir] : []), ...loaded.config.readableRoots.filter(root => {
      if (!path.isAbsolute(root)) return false
      const origin = loaded.readableRootsSources?.[root]
      return origin !== undefined && (inputs.trust.projectReadableRoots || (realConfigDir !== undefined && inside(realConfigDir, origin)))
    })])]
    // Opt-in sandbox policy: an absent `sandbox` block is the new default,
    // fully unrestricted filesystem and terminal access, so mode falls back
    // to 'unrestricted'. allowPaths reuse the readableRoots trust rule
    // verbatim (absolute entry + recorded origin + project opt-in or
    // config-dir origin) but WITHOUT auto-including the configDir — no
    // provenance record means the entry is dropped (fail closed).
    const gatedSandboxAllowPaths = (loaded.config.sandbox?.allowPaths ?? []).filter(root => {
      if (!path.isAbsolute(root)) return false
      const origin = loaded.sandboxAllowPathsSources?.[root]
      return origin !== undefined && (inputs.trust.projectReadableRoots || (realConfigDir !== undefined && inside(realConfigDir, origin)))
    })
    const sandboxPolicy = Object.freeze({ mode: loaded.config.sandbox?.mode ?? 'unrestricted', allowPaths: Object.freeze(gatedSandboxAllowPaths) })
    const readPolicy = createHostReadPolicy(inputs.projectRoot, readableRoots, trustedRoot, sandboxPolicy)
    for (const observation of observations.values()) if (observation.check() !== observation.identity)
      throw new Error('Configuration changed during capture')
    const immutableLoaded = freezeCopy(loaded)
    const snapshot: HostConfigSnapshot = Object.freeze({ snapshotId: randomUUID(), inputs,
      loaded: immutableLoaded, configDir, sourceBytesIdentity: identity(['openbuff.config-capture.v1',
        inputs.invocationCwd, inputs.projectRoot, inputs.home, inputs.globals, inputs.selection, inputs.trust,
        [...observations.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([name, record]) => [name, record.identity])]),
      credentialNames: extractConfiguredCredentialNames(immutableLoaded), readableRoots: Object.freeze(readableRoots),
      sandboxPolicy, readPolicy, ...(executionOrigin ? { executionOrigin } : {}) })
    snapshots.add(snapshot)
    return { status: 'complete', snapshot }
  } catch (error) {
    return { status: 'unavailable', cause: error instanceof Error ? error.message : 'Host configuration unavailable' }
  }
}

/** Compatibility read view over the same deeply frozen, authenticated object. */
export function getCapturedProviderConfig(snapshot: HostConfigSnapshot): LoadedProviderConfig {
  if (!snapshots.has(snapshot)) throw new Error('Invalid host configuration snapshot')
  return snapshot.loaded as LoadedProviderConfig
}

export function createProviderHostContext(snapshot: HostConfigSnapshot, credentials?: CapturedCredentialPort): ProviderHostContext {
  getCapturedProviderConfig(snapshot)
  const environment = snapshot.inputs.environment
  const capturedPort: CapturedCredentialPort = credentials ? Object.freeze({
    getValidChatGptOAuthCredentials: credentials.getValidChatGptOAuthCredentials.bind(credentials),
    ...(credentials.refreshChatGptOAuthToken ? { refreshChatGptOAuthToken: credentials.refreshChatGptOAuthToken.bind(credentials) } : {}),
  }) : Object.freeze({ getValidChatGptOAuthCredentials: async () => {
    const token = getChatGptOAuthTokenFromEnv(environment)
    if (token) return { accessToken: token, refreshToken: '', expiresAt: Date.now() + 365 * 24 * 60 * 60 * 1000, connectedAt: Date.now() }
    if (!snapshot.configDir) return null
    return getValidChatGptOAuthCredentials({ ...environment, OPENBUFF_CONFIG_DIR: snapshot.configDir })
  }, refreshChatGptOAuthToken: async () => snapshot.configDir ?
    refreshChatGptOAuthToken({ ...environment, OPENBUFF_CONFIG_DIR: snapshot.configDir }) : null })
  const context = Object.freeze({ snapshot, credentialEnvironment: environment, credentials: capturedPort })
  providerContexts.add(context)
  return context
}

export function assertProviderHostContext(context: ProviderHostContext): void {
  if (!providerContexts.has(context)) throw new Error('Invalid provider host context')
}

export function credentialRoster(snapshot: HostConfigSnapshot): readonly string[] {
  getCapturedProviderConfig(snapshot)
  return Object.freeze([...new Set([...CREDENTIAL_ENV_KEYS, ...snapshot.credentialNames])].sort())
}

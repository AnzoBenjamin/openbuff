import { createHash, randomUUID } from 'node:crypto'
import { constants, createReadStream } from 'node:fs'
import { access, readdir, readFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'

import {
  computeValidationDependencyFingerprint,
  ValidationReceiptSchema,
} from '@codebuff/common/types/memory-playbook'
import micromatch from 'micromatch'

import { getSystemProcessEnv } from '../env'
import { classifyTerminalHarnessAction } from './harness-enforcement'

import type { ExecutionActor } from '@codebuff/common/types/contracts/client'
import type {
  ValidationEvidenceContext,
  ValidationReceipt,
} from '@codebuff/common/types/memory-playbook'

export type ValidationKind =
  | 'ci-local'
  | 'typecheck'
  | 'test'
  | 'lint'
  | 'package-checks'
  | 'file-change-hooks'
export type ValidationReceiptAttempt = Readonly<{ id: string }>

export type ValidationReceiptRegistryOptions = {
  projectRoot: string
  /** The procedural-memory workspace id (coordinator config.projectId). */
  workspaceId: string
  environment?:
    | Readonly<Record<string, string | undefined>>
    | (() => Readonly<Record<string, string | undefined>>)
  toolVersions?: () => Readonly<Record<string, string>>
  clock?: { now(): number }
  maxReceipts?: number
  maxFiles?: number
  maxBytes?: number
  /** Separate streaming budget for executable and validation-package bytes. */
  maxToolBytes?: number
  /** Capture is always capped at three seconds, including filesystem work. */
  maxPreparationMs?: number
}

type Package = {
  directory: string
  name?: string
  scripts: Record<string, string>
  typescript: boolean
  workspaces: string[]
  dependencies: string[]
}
type ToolPlan = { executables: string[]; packages: string[] }
type Snapshot = {
  hashes: Record<string, string>
  fingerprint: string
  packages: Package[]
  verifiedTools: Set<string>
  toolPlan: ToolPlan
}
type Check = {
  kind: Exclude<ValidationKind, 'file-change-hooks'>
  cwd: string
  required: string[]
  executables: string[]
}
type Pending = {
  command: string
  cwd: string
  actor: ExecutionActor
  baseline: Snapshot
  check?: Check
}

const SKIP_DIRECTORIES = new Set([
  '.git',
  '.openbuff',
  '.cache',
  '.next',
  '.turbo',
  '.venv',
  '__pycache__',
  'node_modules',
  'dist',
  'coverage',
  'target',
  'vendor',
])
const INPUT_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mts',
  '.cts',
  '.mjs',
  '.cjs',
  '.json',
  '.jsonc',
  '.yaml',
  '.yml',
  '.toml',
  '.xml',
  '.rs',
  '.go',
  '.py',
  '.pyi',
  '.c',
  '.h',
  '.cc',
  '.cpp',
  '.hpp',
  '.cs',
  '.java',
  '.kt',
  '.kts',
  '.swift',
  '.rb',
  '.php',
  '.r',
  '.sh',
  '.ps1',
  '.bat',
  '.cmd',
  '.sql',
  '.proto',
  '.lock',
  '.lockb',
])
const SCRIPT_KINDS: Record<string, Check['kind']> = {
  'check:ci-local': 'ci-local',
  check: 'typecheck',
  typecheck: 'typecheck',
  'type-check': 'typecheck',
  'check:types': 'typecheck',
  test: 'test',
  'test:unit': 'test',
  'test:ci': 'test',
  lint: 'lint',
}
const digest = (value: string | Uint8Array): string =>
  `sha256:${createHash('sha256').update(value).digest('hex')}`
const canonicalMap = (
  value: Readonly<Record<string, string | undefined>>,
): string => {
  const entries = Object.entries(value)
  if (entries.length > 4_096)
    throw new Error('Host context entry budget exceeded')
  let bytes = 0
  for (const [key, member] of entries) {
    bytes +=
      Buffer.byteLength(key) +
      (member === undefined ? 0 : Buffer.byteLength(member))
    if (bytes > 4 * 1024 * 1024)
      throw new Error('Host context byte budget exceeded')
  }
  return JSON.stringify(
    entries
      .filter(([, member]) => member !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  )
}
const toPosix = (value: string): string => value.split(path.sep).join('/')
const contained = (root: string, directory: string): boolean => {
  const relative = path.relative(root, directory)
  return (
    !path.isAbsolute(relative) &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`)
  )
}
const validActor = (actor: ExecutionActor): boolean =>
  [actor.runId, actor.rootRunId, actor.agentId].every(
    (part) => typeof part === 'string' && part.length > 0 && part.length <= 128,
  )
const quote = (value: string): string => `'${value.replace(/'/g, `'"'"'`)}'`
const spellings = (value: string): string[] => [
  quote(value),
  ...(/^[A-Za-z0-9_./@:-]+$/.test(value) ? [value, `"${value}"`] : []),
]
const isInput = (name: string): boolean =>
  INPUT_EXTENSIONS.has(path.extname(name).toLowerCase()) ||
  !path.extname(name) ||
  name.startsWith('.env') ||
  name.endsWith('.lock')
const skippedPath = (relative: string): boolean =>
  /^\.agents\/(?:sessions|repros|analytics)(?:\/|$)/.test(toPosix(relative)) ||
  /^debug(?:\/|$)/.test(toPosix(relative))

function parsePackage(
  bytes: Uint8Array,
  directory: string,
  includeDevelopment = true,
): Package {
  const value: unknown = JSON.parse(Buffer.from(bytes).toString('utf8'))
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid package manifest')
  const manifest = value as Record<string, unknown>
  const scripts: Record<string, string> = {}
  if (
    manifest.scripts &&
    typeof manifest.scripts === 'object' &&
    !Array.isArray(manifest.scripts)
  ) {
    const entries = Object.entries(manifest.scripts)
    if (entries.length > 128) throw new Error('Package script budget exceeded')
    for (const [name, body] of entries) {
      if (name.length > 256)
        throw new Error('Package script name budget exceeded')
      if (typeof body === 'string' && body.trim() && body.length <= 32_768)
        scripts[name] = body
    }
  }
  const workspaceValue = Array.isArray(manifest.workspaces)
    ? manifest.workspaces
    : manifest.workspaces && typeof manifest.workspaces === 'object'
      ? (manifest.workspaces as Record<string, unknown>).packages
      : []
  const dependencyNames = new Set<string>()
  for (const field of [
    'dependencies',
    ...(includeDevelopment ? ['devDependencies'] : []),
    'optionalDependencies',
    'peerDependencies',
  ]) {
    const value = manifest[field]
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    for (const name of Object.keys(value)) {
      if (
        name !== '.' &&
        name !== '..' &&
        /^(?:@[A-Za-z0-9_.-]+\/)?[A-Za-z0-9_.-]+$/.test(name)
      )
        dependencyNames.add(name)
      else throw new Error('Invalid dependency name')
      if (dependencyNames.size > 256)
        throw new Error('Package dependency budget exceeded')
    }
  }
  if (Array.isArray(workspaceValue) && workspaceValue.length > 128)
    throw new Error('Package workspace budget exceeded')
  return {
    directory,
    scripts,
    typescript: dependencyNames.has('typescript'),
    ...(typeof manifest.name === 'string' ? { name: manifest.name } : {}),
    workspaces: Array.isArray(workspaceValue)
      ? workspaceValue.filter(
          (item): item is string => typeof item === 'string',
        )
      : [],
    dependencies: [...dependencyNames].sort(),
  }
}

const requiredKinds = (pkg: Package): string[] => {
  const declared = new Set(
    Object.keys(pkg.scripts)
      .map((name) => SCRIPT_KINDS[name])
      .filter(Boolean),
  )
  if (pkg.typescript) declared.add('typecheck')
  const required = ['typecheck', 'test'].filter((kind) =>
    declared.has(kind as Check['kind']),
  )
  return required.length ? required : declared.has('lint') ? ['lint'] : []
}

type ValidationCapability = 'typecheck' | 'test' | 'lint'
type ResolvedCapabilities = Set<ValidationCapability> & {
  executables: Set<string>
}
const capabilitiesWithTools = (
  capabilities: Iterable<ValidationCapability>,
  executables: Iterable<string>,
): ResolvedCapabilities =>
  Object.assign(new Set(capabilities), { executables: new Set(executables) })

/**
 * Capability resolution is independent of the label on a script. Only known
 * noninteractive validators and exact references to resolved scripts qualify.
 * Arbitrary wrapper programs and echo/no-op scripts remain unsupported.
 */
function scriptCapabilities(
  name: string,
  pkg: Package,
  visiting = new Set<string>(),
): ResolvedCapabilities | undefined {
  if (visiting.has(name) || visiting.size >= 8) return undefined
  const body = pkg.scripts[name]?.trim()
  if (!body) return undefined
  const next = new Set([...visiting, name])
  const resolve = (
    command: string,
    depth = 0,
  ): ResolvedCapabilities | undefined => {
    if (depth > 16) return undefined
    if (
      /^(?:(?:tsc|vue-tsc) --noEmit(?: -p (?:\.|\.?\/[A-Za-z0-9_./-]+))?|(?:bunx|npx) --no-install (?:tsc|vue-tsc) --noEmit|(?:pnpm|yarn) exec (?:tsc|vue-tsc) --noEmit)$/.test(
        command,
      )
    ) {
      const compiler = command.includes('vue-tsc') ? 'vue-tsc' : 'tsc'
      const launcher = command.split(' ')[0]!
      return capabilitiesWithTools(
        ['typecheck'],
        [
          compiler,
          'node',
          ...(launcher !== compiler
            ? [launcher === 'bunx' ? 'bun' : launcher]
            : []),
        ],
      )
    }
    if (
      /^(?:bun test(?: --isolate)?|vitest run|jest(?: --runInBand)?|pytest(?: -q)?)$/.test(
        command,
      )
    ) {
      const launcher = command.split(' ')[0]!
      return capabilitiesWithTools(
        ['test'],
        launcher === 'bun'
          ? ['bun']
          : [launcher, ...(launcher === 'pytest' ? [] : ['node'])],
      )
    }
    if (/^(?:eslint (?:\.|[A-Za-z0-9_./-]+)|biome check \.)$/.test(command)) {
      const launcher = command.split(' ')[0]!
      return capabilitiesWithTools(
        ['lint'],
        [launcher, ...(launcher === 'eslint' ? ['node'] : [])],
      )
    }
    for (const script of Object.keys(pkg.scripts)) {
      for (const spelling of spellings(script)) {
        if (
          ['bun', 'npm', 'pnpm', 'yarn'].some(
            (runner) => command === `${runner} run ${spelling}`,
          ) ||
          command === `pnpm ${spelling}` ||
          command === `yarn ${spelling}`
        ) {
          const referenced = scriptCapabilities(script, pkg, next)
          return (
            referenced &&
            capabilitiesWithTools(referenced, [
              ...referenced.executables,
              command.split(' ')[0]!,
            ])
          )
        }
      }
    }
    // The only composition accepted here is a conjunction of independently
    // resolved validators; OR, pipes, substitutions and trailing prose fail.
    const conjunction = command.match(/^(.+) && (.+)$/)
    if (!conjunction) return undefined
    const left = resolve(conjunction[1]!, depth + 1)
    const right = resolve(conjunction[2]!, depth + 1)
    return left && right
      ? capabilitiesWithTools(
          [...left, ...right],
          [...left.executables, ...right.executables],
        )
      : undefined
  }
  return resolve(body)
}

/** Exact invocation forms, generated from existing manifests rather than shell parsing. */
function commandMatches(
  command: string,
  basic: string[],
  pkg: Package,
  cwd: string,
  rootPackage: Package | undefined,
): string | undefined {
  if (pkg.directory === cwd && basic.includes(command))
    return command.split(' ')[0]!
  const relative = toPosix(path.relative(cwd, pkg.directory))
  for (const directory of spellings(relative || '.')) {
    for (const invocation of basic) {
      if (
        command === `cd ${directory} && ${invocation}` ||
        command === `(cd ${directory} && ${invocation})`
      )
        return invocation.split(' ')[0]!
    }
  }
  if (
    pkg.name &&
    rootPackage?.directory === cwd &&
    rootPackage.workspaces.length &&
    micromatch.isMatch(
      toPosix(path.relative(cwd, pkg.directory)),
      rootPackage.workspaces,
    )
  ) {
    for (const name of spellings(pkg.name)) {
      for (const invocation of basic.filter((value) =>
        value.startsWith('bun run '),
      )) {
        if (
          command ===
            `bun --filter=${name} run ${invocation.slice('bun run '.length)}` ||
          command ===
            `bun --filter ${name} run ${invocation.slice('bun run '.length)}`
        )
          return 'bun'
      }
    }
  }
  return undefined
}

/** A closed Bun-test recipe: optional isolation plus existing test paths only. */
function bunTestMatches(
  command: string,
  pkg: Package,
  snapshot: Snapshot,
  root: string,
): boolean {
  if (
    !Object.entries(pkg.scripts).some(
      ([name, body]) =>
        SCRIPT_KINDS[name] === 'test' &&
        /^bun test(?: --isolate)?$/.test(body.trim()),
    )
  )
    return false
  if (command === 'bun test' || command === 'bun test --isolate') return true
  if (!command.startsWith('bun test ')) return false
  const remainder = command.slice('bun test '.length)
  const words = [
    ...remainder.matchAll(
      /"([A-Za-z0-9_./@:\- ]+)"|'([A-Za-z0-9_./@:\- ]+)'|([A-Za-z0-9_./@:\-]+)/g,
    ),
  ]
  if (
    !words.length ||
    words.length > 128 ||
    words.map((word) => word[0]).join(' ') !== remainder
  )
    return false
  const tests = Object.keys(snapshot.hashes)
    .filter((key) => /^file:.*(?:\.test|\.spec)\.[cm]?[jt]sx?$/.test(key))
    .map((key) => key.slice('file:'.length))
  let targets = 0
  for (const word of words) {
    const value = word[1] ?? word[2] ?? word[3]!
    if (value === '--isolate') continue
    if (value.startsWith('-')) return false
    const absolute = path.resolve(pkg.directory, value)
    if (!contained(root, absolute)) return false
    const relative = toPosix(path.relative(root, absolute))
    if (
      !tests.some(
        (testPath) =>
          testPath === relative || testPath.startsWith(`${relative}/`),
      )
    )
      return false
    targets++
  }
  return targets > 0
}

function resolveCheck(
  command: string,
  cwd: string,
  snapshot: Snapshot,
  root: string,
): Check | undefined {
  const rootPackage = snapshot.packages.find((pkg) => pkg.directory === root)
  const toolName = (executable: string) =>
    executable === 'bunx' ? 'bun' : executable
  for (const pkg of snapshot.packages) {
    const basicByKind = new Map<
      string,
      Array<{ command: string; executables: string[] }>
    >()
    for (const name of Object.keys(pkg.scripts)) {
      const kind = SCRIPT_KINDS[name]
      if (!kind) continue
      const capabilities = scriptCapabilities(name, pkg)
      if (
        !capabilities ||
        (kind === 'ci-local'
          ? !requiredKinds(pkg).length ||
            !requiredKinds(pkg).every((required) =>
              capabilities.has(required as ValidationCapability),
            )
          : !capabilities.has(kind as ValidationCapability))
      )
        continue
      const forms = spellings(name).flatMap((script) => [
        ...['bun', 'npm', 'pnpm', 'yarn'].map(
          (runner) => `${runner} run ${script}`,
        ),
        `pnpm ${script}`,
        `yarn ${script}`,
        ...(name === 'test' ? [`npm ${script}`] : []),
      ])
      // Native file hooks execute the resolved recipe body directly. This is
      // still a capability-checked validator, not a name/substring assertion.
      forms.push(pkg.scripts[name]!.trim())
      const existing = basicByKind.get(kind) ?? []
      basicByKind.set(kind, [
        ...existing,
        ...forms.map((command) => ({
          command,
          executables: [
            ...capabilities.executables,
            toolName(command.split(' ')[0]!),
          ],
        })),
      ])
      const launcher = commandMatches(command, forms, pkg, cwd, rootPackage)
      if (launcher)
        return {
          kind,
          cwd: pkg.directory,
          required: requiredKinds(pkg),
          executables: [...capabilities.executables, toolName(launcher)],
        }
    }
    if (pkg.directory === cwd && bunTestMatches(command, pkg, snapshot, root))
      return {
        kind: 'test',
        cwd: pkg.directory,
        required: requiredKinds(pkg),
        executables: ['bun'],
      }
    if (pkg.typescript) {
      const forms = [
        'bunx --no-install tsc --noEmit',
        'npx --no-install tsc --noEmit',
        'pnpm exec tsc --noEmit',
        'yarn exec tsc --noEmit',
      ]
      basicByKind.set('typecheck', [
        ...(basicByKind.get('typecheck') ?? []),
        ...forms.map((command) => ({
          command,
          executables: ['tsc', 'node', toolName(command.split(' ')[0]!)],
        })),
      ])
      const launcher = commandMatches(command, forms, pkg, cwd, rootPackage)
      if (launcher)
        return {
          kind: 'typecheck',
          cwd: pkg.directory,
          required: requiredKinds(pkg),
          executables: ['tsc', 'node', launcher === 'bunx' ? 'bun' : launcher],
        }
    }
    const required = requiredKinds(pkg)
    if (required.length > 1 && command.includes(' && ')) {
      const first = basicByKind.get(required[0]!) ?? []
      const second = basicByKind.get(required[1]!) ?? []
      let combinations = 0
      for (const left of first) {
        for (const right of second) {
          if (++combinations > 4_096) return undefined
          const launcher = commandMatches(
            command,
            [`${left.command} && ${right.command}`],
            pkg,
            cwd,
            rootPackage,
          )
          if (launcher)
            return {
              kind: 'package-checks',
              cwd: pkg.directory,
              required,
              executables: [
                ...left.executables,
                ...right.executables,
                toolName(launcher),
              ],
            }
        }
      }
    }
  }
  return undefined
}

/**
 * Host-only, bounded validation registry. Call begin before native dispatch and
 * complete only with its trusted outcome. Tokens are registry-owned objects;
 * model inputs/outputs, serialized tokens and foreign registries cannot mint
 * receipts. The same broad dependency closure is rehashed before, after and
 * when reused, including an input roster to invalidate additions/deletions.
 */
export function createValidationReceiptRegistry(
  options: ValidationReceiptRegistryOptions,
) {
  const limit = (value: number | undefined, fallback: number) =>
    value !== undefined && Number.isFinite(value)
      ? Math.max(1, Math.floor(value))
      : fallback
  const maxReceipts = limit(options.maxReceipts, 64)
  const maxFiles = limit(options.maxFiles, 20_000)
  const maxBytes = limit(options.maxBytes, 128 * 1024 * 1024)
  const maxToolBytes = limit(options.maxToolBytes, 512 * 1024 * 1024)
  const rootPromise = realpath(options.projectRoot).catch(() => undefined)
  const environment = options.environment ?? getSystemProcessEnv
  const versions =
    options.toolVersions ??
    (() =>
      ({ ...process.versions, executable: process.execPath }) as Record<
        string,
        string
      >)
  const now = options.clock?.now.bind(options.clock) ?? Date.now
  const pending = new Map<ValidationReceiptAttempt, Pending>()
  let receipts: ValidationReceipt[] = []
  let closed = false
  const toolHashCache = new Map<string, { identity: string; hash: string }>()
  let observedPlan: ToolPlan = { executables: [], packages: [] }
  const mergePlans = (...plans: ToolPlan[]): ToolPlan => ({
    executables: [...new Set(plans.flatMap((plan) => plan.executables))].sort(),
    packages: [...new Set(plans.flatMap((plan) => plan.packages))].sort(),
  })
  const unchanged = (
    dependencies: Readonly<Record<string, string>>,
    current: Readonly<Record<string, string>>,
  ) =>
    Object.entries(dependencies).every(([key, value]) => current[key] === value)
  const maxPreparationMs = Math.min(
    3_000,
    limit(options.maxPreparationMs, 3_000),
  )
  type CaptureBudget = { signal: AbortSignal; spend(work?: number): void }

  const captureTools = async (
    plan: ToolPlan,
    packages: Package[],
    hashes: Record<string, string>,
    capturedEnvironment: Readonly<Record<string, string | undefined>>,
    budget: CaptureBudget,
  ): Promise<Set<string>> => {
    if (plan.executables.length > 32 || plan.packages.length > 128)
      throw new Error('Tool context budget exceeded')
    const verified = new Set<string>()
    const seenFiles = new Set<string>()
    const packageDirectories = new Map<string, string>()
    const seenModules = new Map<string, string[]>()
    let bytes = 0
    let files = 0
    const hashFile = async (filename: string): Promise<string> => {
      budget.spend()
      const canonical = await realpath(filename)
      const before = await stat(canonical, { bigint: true })
      budget.spend()
      if (!before.isFile()) throw new Error('Tool input is not a file')
      if (!seenFiles.has(canonical)) {
        seenFiles.add(canonical)
        bytes += Number(before.size)
        if (++files > 10_000 || bytes > maxToolBytes)
          throw new Error('Tool input budget exceeded')
      }
      const identity = [
        before.dev,
        before.ino,
        before.mode,
        before.size,
        before.mtimeNs,
        before.ctimeNs,
      ].join(':')
      const cached = toolHashCache.get(canonical)
      if (cached?.identity === identity) return cached.hash
      const hash = createHash('sha256').update(`${before.mode & 0o777n}:`)
      for await (const chunk of createReadStream(canonical, {
        signal: budget.signal,
      })) {
        budget.spend()
        hash.update(chunk)
      }
      const after = await stat(canonical, { bigint: true })
      budget.spend()
      if (
        [
          after.dev,
          after.ino,
          after.mode,
          after.size,
          after.mtimeNs,
          after.ctimeNs,
        ].join(':') !== identity
      )
        throw new Error('Tool input changed during capture')
      const result = `sha256:${hash.digest('hex')}`
      toolHashCache.set(canonical, { identity, hash: result })
      if (toolHashCache.size > 20_000)
        toolHashCache.delete(toolHashCache.keys().next().value!)
      return result
    }
    const exists = async (filename: string): Promise<boolean> => {
      budget.spend()
      try {
        await stat(filename)
        budget.spend()
        return true
      } catch (error) {
        if (
          (error as NodeJS.ErrnoException).code === 'ENOENT' ||
          (error as NodeJS.ErrnoException).code === 'ENOTDIR'
        )
          return false
        throw error
      }
    }
    const modulePaths = async (from: string): Promise<string[]> => {
      const cached = seenModules.get(from)
      if (cached) return cached
      const result: string[] = []
      let directory = from
      for (let depth = 0; depth < 64; depth++) {
        budget.spend()
        const candidate = path.join(directory, 'node_modules')
        if (await exists(candidate)) {
          if (!(await stat(candidate)).isDirectory())
            throw new Error('Invalid installation directory')
          const canonical = await realpath(candidate)
          result.push(candidate)
          const key = `install:${digest(candidate)}`
          if (!Object.hasOwn(hashes, `${key}:roster`)) {
            const children = await readdir(candidate, { withFileTypes: true })
            budget.spend(children.length)
            hashes[`${key}:resolved-path`] = digest(canonical)
            hashes[`${key}:roster`] = digest(
              JSON.stringify(children.map((entry) => entry.name).sort()),
            )
            for (const marker of [
              '.package-lock.json',
              '.modules.yaml',
              '.yarn-state.yml',
              '.pnpm/lock.yaml',
            ]) {
              const filename = path.join(candidate, marker)
              hashes[`${key}:marker:${marker}`] = (await exists(filename))
                ? await hashFile(filename)
                : 'missing'
            }
          }
        }
        const parent = path.dirname(directory)
        if (parent === directory) break
        directory = parent
      }
      seenModules.set(from, result)
      return result
    }
    const pathValue = capturedEnvironment.PATH
    const environmentPath =
      pathValue === undefined ? [] : pathValue.split(path.delimiter)
    if (
      environmentPath.some(
        (directory) => !directory || !path.isAbsolute(directory),
      )
    )
      throw new Error('Empty or relative tool PATH is unsupported')
    const findPackage = async (
      filename: string,
      executable: string,
    ): Promise<string | undefined> => {
      const names: Record<string, string[]> = {
        tsc: ['typescript'],
        'vue-tsc': ['vue-tsc'],
        npx: ['npm'],
        biome: ['@biomejs/biome'],
        jest: ['jest', 'jest-cli'],
        yarn: ['yarn', '@yarnpkg/cli-dist'],
      }
      const acceptedNames = names[executable] ?? [executable]
      let directory = path.dirname(filename)
      for (let depth = 0; depth < 8; depth++) {
        const manifestPath = path.join(directory, 'package.json')
        if (await exists(manifestPath)) {
          if ((await stat(manifestPath)).size > 1_000_000)
            throw new Error('Installed package manifest budget exceeded')
          const value: unknown = JSON.parse(
            await readFile(manifestPath, {
              encoding: 'utf8',
              signal: budget.signal,
            }),
          )
          if (
            value &&
            typeof value === 'object' &&
            acceptedNames.includes(
              (value as Record<string, unknown>).name as string,
            )
          )
            return directory
        }
        const parent = path.dirname(directory)
        if (parent === directory) break
        directory = parent
      }
      return undefined
    }
    for (const scope of plan.packages) {
      const modules = await modulePaths(scope)
      const binaryDirectories = [
        ...modules.map((directory) => path.join(directory, '.bin')),
        ...environmentPath,
      ]
      for (const executable of plan.executables) {
        let qualified = false
        // Bare native commands resolve captured PATH; package script runners
        // prepend local .bin directories. Bind both routes for each used tool
        // name, so the actual runtime cannot change behind a different route.
        for (const [route, directories] of [
          ['environment', environmentPath],
          ['package-script', binaryDirectories],
        ] as const) {
          budget.spend()
          const key = `tool:${executable}:scope:${digest(scope)}:resolution:${route}`
          let located: string | undefined
          for (const directory of directories) {
            for (const suffix of process.platform === 'win32'
              ? ['', '.exe', '.cmd']
              : ['']) {
              const candidate = path.join(directory, `${executable}${suffix}`)
              budget.spend()
              try {
                await access(candidate, constants.X_OK)
                if ((await stat(candidate)).isFile()) {
                  located = await realpath(candidate)
                  break
                }
              } catch (error) {
                if (
                  !['ENOENT', 'ENOTDIR', 'EACCES'].includes(
                    (error as NodeJS.ErrnoException).code ?? '',
                  )
                )
                  throw error
              }
            }
            if (located) break
          }
          if (!located) {
            hashes[`${key}:executable`] = 'missing'
            continue
          }
          hashes[`${key}:executable`] = await hashFile(located)
          hashes[`${key}:resolved-path`] = digest(located)
          // Native Bun and Node binaries are self-contained. Ascending from
          // them could accidentally bind an unrelated user package.json.
          let pkgDirectory = ['bun', 'node'].includes(executable)
            ? undefined
            : await findPackage(located, executable)
          if (
            !pkgDirectory &&
            ['npm', 'npx', 'pnpm', 'yarn'].includes(executable)
          ) {
            const packageName = executable === 'npx' ? 'npm' : executable
            const standard = path.resolve(
              path.dirname(located),
              '../lib/node_modules',
              packageName,
            )
            if (await exists(path.join(standard, 'package.json')))
              pkgDirectory = await realpath(standard)
            if (!pkgDirectory && (await stat(located)).size < 64_000) {
              const shim = await readFile(located, {
                encoding: 'utf8',
                signal: budget.signal,
              })
              const target = shim.match(/^# cmd-shim-target=(.+)$/m)?.[1]
              if (target && path.isAbsolute(target)) {
                const targetPath = await realpath(target)
                hashes[`${key}:shim-target`] = await hashFile(targetPath)
                pkgDirectory = await findPackage(targetPath, executable)
              }
            }
          }
          if (pkgDirectory)
            packageDirectories.set(
              await realpath(pkgDirectory),
              `tool:${executable}:package:${digest(scope)}`,
            )
          if (!pkgDirectory && !['bun', 'node'].includes(executable))
            throw new Error('Tool package context is unavailable')
          qualified = true
        }
        if (qualified) verified.add(`${executable}:${scope}`)
      }
    }
    const capturedPackages = new Set<string>()
    const installedByName = new Map<string, string>()
    const capturePackage = async (directory: string): Promise<void> => {
      budget.spend()
      const canonical = await realpath(directory)
      if (capturedPackages.has(canonical)) return
      if (capturedPackages.size >= 256)
        throw new Error('Installed package budget exceeded')
      capturedPackages.add(canonical)
      const key = `package:${digest(canonical)}`
      const manifestPath = path.join(canonical, 'package.json')
      const manifestSize = await stat(manifestPath)
      if (manifestSize.size > 1_000_000)
        throw new Error('Installed package manifest budget exceeded')
      const manifestBytes = await readFile(manifestPath, {
        signal: budget.signal,
      })
      const pkg = parsePackage(manifestBytes, canonical, false)
      if (pkg.name) installedByName.set(pkg.name, canonical)
      hashes[`${key}:resolved-path`] = digest(canonical)
      const directories = [{ directory: canonical, depth: 0 }]
      const visited = new Set<string>()
      while (directories.length) {
        const current = directories.pop()!
        if (current.depth > 32)
          throw new Error('Installed package depth exceeded')
        const resolved = await realpath(current.directory)
        if (visited.has(resolved))
          throw new Error('Cyclic installed package input')
        visited.add(resolved)
        if (!contained(canonical, resolved))
          throw new Error('Installed input escapes its package')
        const children = await readdir(current.directory, {
          withFileTypes: true,
        })
        budget.spend(children.length)
        for (const entry of children) {
          budget.spend()
          if (entry.name === 'node_modules') continue
          const filename = path.join(current.directory, entry.name)
          const relative = toPosix(path.relative(canonical, filename))
          if (entry.isDirectory())
            directories.push({ directory: filename, depth: current.depth + 1 })
          else if (entry.isFile())
            hashes[`${key}:file:${relative}`] = await hashFile(filename)
          else if (entry.isSymbolicLink()) {
            const target = await realpath(filename)
            hashes[`${key}:symlink:${relative}`] = digest(target)
            if (!contained(canonical, target))
              throw new Error('Installed input escapes its package')
            if ((await stat(filename)).isDirectory())
              directories.push({
                directory: filename,
                depth: current.depth + 1,
              })
            else hashes[`${key}:file:${relative}`] = await hashFile(filename)
          } else throw new Error('Unknown installed package input')
        }
      }
      hashes[`${key}:roster`] = digest(
        JSON.stringify(
          Object.keys(hashes)
            .filter(
              (member) =>
                member.startsWith(`${key}:file:`) ||
                member.startsWith(`${key}:symlink:`),
            )
            .sort(),
        ),
      )
      for (const dependency of pkg.dependencies)
        await captureDependency(dependency, canonical)
    }
    const captureDependency = async (
      name: string,
      from: string,
    ): Promise<void> => {
      budget.spend()
      const key = `dependency:${digest(from)}:${name}`
      const local = packages.find((pkg) => pkg.name === name)
      if (local) {
        hashes[key] = digest(local.directory)
        return
      }
      let located: string | undefined
      for (const directory of await modulePaths(from)) {
        const candidate = path.join(directory, name)
        if (await exists(path.join(candidate, 'package.json'))) {
          located = await realpath(candidate)
          break
        }
      }
      located ??= installedByName.get(name)
      hashes[key] = located ? digest(located) : 'missing'
      if (located) await capturePackage(located)
    }
    // Capture tools first, so an explicitly resolved compiler symlink can
    // satisfy its declared package identity without scanning unrelated installs.
    for (const directory of packageDirectories.keys())
      await capturePackage(directory)
    for (const scope of plan.packages) {
      const pkg = packages.find((candidate) => candidate.directory === scope)
      for (const dependency of pkg?.dependencies ?? [])
        await captureDependency(dependency, scope)
      // TypeScript implicitly reads all enclosing @types packages even when
      // they are not named in dependencies or tsconfig's explicit imports.
      if (
        plan.executables.some(
          (executable) => executable === 'tsc' || executable === 'vue-tsc',
        )
      ) {
        for (const modules of await modulePaths(scope)) {
          const typesDirectory = path.join(modules, '@types')
          if (!(await exists(typesDirectory))) continue
          const children = await readdir(typesDirectory, {
            withFileTypes: true,
          })
          budget.spend(children.length)
          hashes[`types:${digest(typesDirectory)}:roster`] = digest(
            JSON.stringify(children.map((entry) => entry.name).sort()),
          )
          for (const child of children) {
            if (child.isDirectory() || child.isSymbolicLink())
              await capturePackage(path.join(typesDirectory, child.name))
          }
        }
      }
    }
    return verified
  }

  const snapshot = async (
    selectPlan: (view: Snapshot, root: string) => ToolPlan | undefined,
  ): Promise<Snapshot | undefined> => {
    const controller = new AbortController()
    const expiresAt = performance.now() + maxPreparationMs
    let work = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const budget: CaptureBudget = {
      signal: controller.signal,
      spend(count = 1) {
        work += count
        if (
          closed ||
          controller.signal.aborted ||
          performance.now() >= expiresAt ||
          work > 100_000
        )
          throw new Error('Validation capture budget exceeded')
      },
    }
    const capture = async (): Promise<Snapshot | undefined> => {
      const root = await rootPromise
      budget.spend()
      if (!root) return undefined
      const hashes: Record<string, string> = Object.create(null)
      const packages: Package[] = []
      const directories = [{ directory: root, depth: 0 }]
      let files = 0
      let bytes = 0
      let entries = 0
      while (directories.length) {
        budget.spend()
        const { directory, depth } = directories.pop()!
        if (depth > 32) return undefined
        const children = await readdir(directory, { withFileTypes: true })
        budget.spend(children.length)
        entries += children.length
        if (entries > maxFiles * 5) return undefined
        for (const child of children.sort((a, b) =>
          a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
        )) {
          budget.spend()
          const absolute = path.join(directory, child.name)
          const relative = path.relative(root, absolute)
          if (SKIP_DIRECTORIES.has(child.name) || skippedPath(relative))
            continue
          if (child.isDirectory()) {
            directories.push({ directory: absolute, depth: depth + 1 })
            continue
          }
          if (!isInput(child.name)) continue
          if (
            child.isSymbolicLink() &&
            !contained(root, await realpath(absolute))
          )
            return undefined
          const metadata = await stat(absolute)
          budget.spend()
          if (
            !metadata.isFile() ||
            metadata.size > Math.min(maxBytes, 8 * 1024 * 1024)
          )
            return undefined
          if (++files > maxFiles || (bytes += metadata.size) > maxBytes)
            return undefined
          const content = await readFile(absolute, {
            signal: controller.signal,
          })
          budget.spend()
          if (content.byteLength !== metadata.size) return undefined
          hashes[`file:${toPosix(relative)}`] = digest(
            Buffer.concat([Buffer.from(`${metadata.mode & 0o777}:`), content]),
          )
          if (child.name === 'package.json') {
            if (packages.length >= 128) return undefined
            packages.push(parsePackage(content, directory))
          }
        }
      }
      hashes['workspace:input-roster'] = digest(
        JSON.stringify(Object.keys(hashes).sort()),
      )
      const capturedEnvironment =
        typeof environment === 'function' ? environment() : environment
      hashes['host:environment'] = digest(canonicalMap(capturedEnvironment))
      hashes['host:tool-versions'] = digest(canonicalMap(versions()))
      const view: Snapshot = {
        hashes,
        packages,
        verifiedTools: new Set(),
        toolPlan: { executables: [], packages: [] },
        fingerprint: '',
      }
      const plan = selectPlan(view, root)
      if (!plan) return undefined
      view.toolPlan = mergePlans(plan)
      view.verifiedTools = await captureTools(
        view.toolPlan,
        packages,
        hashes,
        capturedEnvironment,
        budget,
      )
      budget.spend()
      view.fingerprint = computeValidationDependencyFingerprint(hashes)
      return view
    }
    try {
      return await Promise.race([
        capture(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort()
            reject(new Error('Validation capture timed out'))
          }, maxPreparationMs)
        }),
      ])
    } catch {
      return undefined
    } finally {
      if (timer) clearTimeout(timer)
      controller.abort()
    }
  }

  const store = (receipt: ValidationReceipt): ValidationReceipt => {
    const valid = ValidationReceiptSchema.parse(receipt)
    receipts.push(valid)
    if (receipts.length > maxReceipts)
      receipts.splice(0, receipts.length - maxReceipts)
    return valid
  }
  const makeReceipt = (
    attempt: Pending,
    check: Check,
    command: string,
    completedAt = now(),
  ): ValidationReceipt =>
    store({
      receiptId: `validation-${randomUUID()}`,
      workspaceId: options.workspaceId,
      rootRunId: attempt.actor.rootRunId,
      checkKind: check.kind,
      command,
      cwd: check.cwd,
      exitCode: 0,
      completedAt,
      producer: { runId: attempt.actor.runId, agentId: attempt.actor.agentId },
      dependencyHashes: { ...attempt.baseline.hashes },
      dependencyFingerprint: attempt.baseline.fingerprint,
    })
  const toolsAvailable = (view: Snapshot, check: Check): boolean =>
    check.executables.every((executable) =>
      view.verifiedTools.has(`${executable}:${check.cwd}`),
    )
  const aggregate = (
    attempt: Pending,
    check: Check,
    current: Snapshot,
  ): ValidationReceipt | undefined => {
    if (
      !check.required.length ||
      check.kind === 'ci-local' ||
      check.kind === 'package-checks'
    )
      return undefined
    const members = check.required.map((kind) =>
      receipts.findLast(
        (receipt) =>
          receipt.rootRunId === attempt.actor.rootRunId &&
          receipt.cwd === check.cwd &&
          receipt.checkKind === kind &&
          unchanged(receipt.dependencyHashes, current.hashes),
      ),
    )
    if (members.some((receipt) => !receipt)) return undefined
    return makeReceipt(
      { ...attempt, baseline: current },
      { ...check, kind: 'package-checks' },
      members.map((receipt) => receipt!.command).join(' && '),
      Math.min(...members.map((receipt) => receipt!.completedAt)),
    )
  }

  return {
    async begin(params: {
      command: string
      cwd: string
      actor: ExecutionActor
      validationKind?: ValidationKind
      nativeHookCommands?: readonly string[]
    }): Promise<ValidationReceiptAttempt | undefined> {
      if (closed || !validActor(params.actor) || pending.size >= 16)
        return undefined
      if (
        params.command.length > 32_768 ||
        (params.nativeHookCommands?.length ?? 0) > 128
      )
        return undefined
      const command = params.command.trim()
      const hooks =
        params.validationKind === 'file-change-hooks' &&
        command === 'run_file_change_hooks'
      if (
        !hooks &&
        !/^(?:bun |bunx |npm |npx |pnpm |yarn |tsc |vue-tsc |eslint |biome |vitest |jest|pytest|cd |\(cd )/.test(
          command,
        )
      )
        return undefined
      const classified = hooks
        ? undefined
        : classifyTerminalHarnessAction(command)
      if (
        classified &&
        (classified.parseStatus !== 'complete' ||
          (classified.effects ?? [classified]).length > 0)
      )
        return undefined
      try {
        const root = await rootPromise
        const cwd = await realpath(params.cwd)
        if (!root || !contained(root, cwd)) return undefined
        let check: Check | undefined
        const baseline = await snapshot((view) => {
          check = hooks ? undefined : resolveCheck(command, cwd, view, root)
          const hookCommands =
            params.nativeHookCommands ??
            view.packages.flatMap((pkg) => Object.values(pkg.scripts))
          const checks = hooks
            ? hookCommands.slice(0, 128).flatMap((command) => {
                const hookCheck = resolveCheck(command.trim(), cwd, view, root)
                return hookCheck ? [hookCheck] : []
              })
            : check
              ? [check]
              : []
          if (
            !checks.length ||
            (!hooks &&
              params.validationKind &&
              params.validationKind !== check?.kind)
          )
            return undefined
          return mergePlans(observedPlan, {
            executables: checks.flatMap((check) => check.executables),
            packages: checks.map((check) => check.cwd),
          })
        })
        if (!baseline) return undefined
        if (!hooks && (!check || !toolsAvailable(baseline, check)))
          return undefined
        if (closed || pending.size >= 16) return undefined
        const token = Object.freeze({
          id: `validation-attempt-${randomUUID()}`,
        })
        observedPlan = baseline.toolPlan
        pending.set(token, {
          command: params.command,
          cwd,
          actor: { ...params.actor },
          baseline,
          check,
        })
        return token
      } catch {
        return undefined
      }
    },
    async complete(
      token: ValidationReceiptAttempt | undefined,
      outcome: { exitCode?: number | null; nativeHooksOutput?: unknown },
    ): Promise<ValidationReceipt | undefined> {
      if (closed || !token) return undefined
      const attempt = pending.get(token)
      if (!attempt) return undefined
      pending.delete(token)
      try {
        const root = await rootPromise
        const checks: Array<{ check: Check; command: string }> = []
        if (attempt.check) {
          if (outcome.exitCode !== 0) return undefined
          checks.push({ check: attempt.check, command: attempt.command })
        } else {
          if (
            !Array.isArray(outcome.nativeHooksOutput) ||
            outcome.nativeHooksOutput.length > 32 ||
            !root
          )
            return undefined
          for (const part of outcome.nativeHooksOutput) {
            if (
              !part ||
              part.type !== 'json' ||
              !Array.isArray(part.value) ||
              part.value.length > 256
            )
              return undefined
            for (const value of part.value) {
              if (
                !value ||
                typeof value !== 'object' ||
                value.errorMessage ||
                value.executionRefusal
              )
                return undefined
              if (value.validationStatus !== undefined) {
                if (
                  value.validationStatus !== 'diagnostic_delta_passed' ||
                  value.diagnosticStatus !== 'passed'
                )
                  return undefined
                continue
              }
              if (
                value.exitCode !== 0 ||
                typeof value.command !== 'string' ||
                value.command.length > 32_768
              )
                return undefined
              if (
                value.processCleanup &&
                value.processCleanup.status !== 'complete'
              )
                return undefined
              const check = resolveCheck(
                value.command.trim(),
                attempt.cwd,
                attempt.baseline,
                root,
              )
              if (check) checks.push({ check, command: value.command })
            }
          }
          if (!checks.length) return undefined
        }
        if (
          checks.some(({ check }) => !toolsAvailable(attempt.baseline, check))
        )
          return undefined
        const after = await snapshot(() =>
          mergePlans(observedPlan, attempt.baseline.toolPlan),
        )
        if (
          closed ||
          !after ||
          !unchanged(attempt.baseline.hashes, after.hashes)
        )
          return undefined
        let result: ValidationReceipt | undefined
        for (const { check, command } of checks) {
          result = makeReceipt(attempt, check, command)
          result = aggregate(attempt, check, after) ?? result
        }
        return result
      } catch {
        return undefined
      }
    },
    async evidence(
      actor: ExecutionActor,
    ): Promise<ValidationEvidenceContext | undefined> {
      if (
        closed ||
        !validActor(actor) ||
        !receipts.some((receipt) => receipt.rootRunId === actor.rootRunId)
      )
        return undefined
      const current = await snapshot(() => observedPlan)
      if (!current) return undefined
      receipts = receipts.filter((receipt) =>
        unchanged(receipt.dependencyHashes, current.hashes),
      )
      const matching = receipts.filter(
        (receipt) => receipt.rootRunId === actor.rootRunId,
      )
      if (!matching.length) return undefined
      return {
        workspaceId: options.workspaceId,
        rootRunId: actor.rootRunId,
        receipts: structuredClone(matching),
        currentDependencyHashes: { ...current.hashes },
      }
    },
    close(): void {
      closed = true
      pending.clear()
      receipts = []
      toolHashCache.clear()
    },
  }
}

export type ValidationReceiptRegistry = ReturnType<
  typeof createValidationReceiptRegistry
>

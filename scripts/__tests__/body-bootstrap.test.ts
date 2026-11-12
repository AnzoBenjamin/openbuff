import { afterEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import {
  captureBootstrapEnvironment,
  defaultBootstrapDependencies,
  parseBootstrapArgs,
  runBootstrapProbe,
  validateBootstrapManifest,
  verifyBootstrap,
} from '../body-bootstrap'
import type {
  BootstrapDependencies,
  BootstrapSelectionManifest,
  ProbeReceipt,
  ProbeRequest,
} from '../body-bootstrap'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true })
})
const digest = (path: string) =>
  createHash('sha256').update(readFileSync(path)).digest('hex')
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'body-bootstrap-'))
  directories.push(root)
  for (const name of ['package.json', 'bun.lock', 'source.ts', '.mise.toml'])
    writeFileSync(
      join(root, name),
      name === 'package.json'
        ? '{"engines":{"node":">=20.3.0"}}'
        : `fixture-${name}`,
    )
  const tool = join(root, 'bun')
  writeFileSync(tool, '#!/bin/sh\nprintf "1.4.4\\n"\n')
  chmodSync(tool, 0o755)
  const seal = (path: string) => ({ path, sha256: digest(join(root, path)) })
  const deps = { ...defaultBootstrapDependencies({ PATH: root }), root }
  const host = `${deps.platform.os}-${deps.platform.arch}`
  const manifest: BootstrapSelectionManifest = {
    schemaVersion: 1,
    type: 'body-bootstrap-selection',
    tools: {
      bun: {
        selector: { kind: 'path-name', name: 'bun' },
        expectedVersion: '1.4.4',
        expectedSha256ByHost: { [host]: digest(tool) },
        selectionEvidence: seal('source.ts'),
        acquisition: 'already-selected',
      },
    },
    cells: {
      bun: {
        boundary: 'bootstrap-prerequisites',
        tools: ['bun'],
        cells: [],
        artifacts: [],
        platform: 'any',
      },
    },
    inputs: {
      packages: [seal('package.json')],
      locks: [seal('bun.lock')],
      sources: [seal('source.ts')],
      configuration: [seal('.mise.toml')],
    },
    artifacts: [],
    capabilities: [
      {
        id: 'native-filesystem-enforcement',
        state: 'unavailable',
        boundary: 'not-verified',
        proof: null,
      },
    ],
  }
  const request = {
    manifestPath: join(root, 'manifest.json'),
    evidenceDir: join(root, 'evidence'),
    requiredCells: ['bun'],
  }
  const persist = () =>
    writeFileSync(request.manifestPath, JSON.stringify(manifest))
  persist()
  return { root, tool, manifest, deps, request, persist, seal, host }
}
function fakeProbe(request: ProbeRequest, output = '1.4.4\n'): ProbeReceipt {
  return {
    argv: [...request.argv],
    cwd: request.cwd,
    environment: { ...request.env },
    startedAtUtc: '2026-11-12T01:00:00.000Z',
    finishedAtUtc: '2026-11-12T01:00:00.001Z',
    elapsedMs: 1,
    pid: 123,
    exitCode: 0,
    signal: null,
    stdout: output,
    stderr: '',
    timedOut: false,
    outputLimitExceeded: false,
    aborted: false,
    error: null,
    cleanup: {
      attemptId: 'injected:1',
      scopeId: 'injected',
      status: 'complete',
      selectedTier: 'injected',
      observedTier: 'injected',
      satisfiesSelectedTier: true,
      trigger: 'normal-leader-exit',
      originalDeadline: { kind: 'unbounded', limitId: 'injected' },
      firstStopAtMs: 0,
      killAtMs: 200,
      observeUntilMs: 1400,
      signals: [],
      finalObservation: {
        sampledAtMs: 1,
        clockDomainId: 'injected',
        leader: 'exited-reaped',
        scopePresence: 'absent',
        members: [],
        membershipComplete: true,
        identity: 'verified',
        streams: { stdin: 'closed', stdout: 'drained', stderr: 'drained' },
      },
      output: {
        stdoutSeenBytes: Buffer.byteLength(output),
        stderrSeenBytes: 0,
        retainedBytes: Buffer.byteLength(output),
        droppedBytes: 0,
        complete: true,
      },
      cleanupAuthorityRetained: false,
      selectedLimitSatisfied: null,
    },
  }
}
const injected = (
  deps: BootstrapDependencies,
  output = '1.4.4\n',
): BootstrapDependencies => ({
  ...deps,
  probe: async (request) => fakeProbe(request, output),
})

test('strict argument parsing rejects missing, duplicate, empty and unknown requests', () => {
  const args = [
    '--manifest',
    'manifest.json',
    '--require',
    'bun,rust',
    '--evidence-dir',
    'out',
  ]
  expect(parseBootstrapArgs(args).requiredCells).toEqual(['bun', 'rust'])
  for (const invalid of [
    [],
    args.slice(0, -1),
    [...args, '--acquire', 'true'],
    [...args, '--require', 'node'],
    ['--manifest', 'm', '--require', '', '--evidence-dir', 'out'],
    ['--manifest', 'm', '--require', 'bun,', '--evidence-dir', 'out'],
  ])
    expect(() => parseBootstrapArgs(invalid)).toThrow()
})

test('environment capture excludes credentials and runtime injection flags', () => {
  expect(
    captureBootstrapEnvironment({
      PATH: '/tools',
      BODY_EVIDENCE: '/evidence',
      OPENAI_API_KEY: 'fixture-secret',
      NODE_OPTIONS: '--inspect',
      HOME: '/private',
    }),
  ).toEqual({ PATH: '/tools', BODY_EVIDENCE: '/evidence' })
})

test.each([
  [
    'unknown field',
    (m: BootstrapSelectionManifest) => {
      Object.assign(m, { acquisitionCommand: 'download' })
    },
  ],
  [
    'empty input category',
    (m: BootstrapSelectionManifest) => {
      m.inputs.locks = []
    },
  ],
  [
    'duplicate input',
    (m: BootstrapSelectionManifest) => {
      m.inputs.sources.push(m.inputs.packages[0])
    },
  ],
  [
    'unknown prerequisite',
    (m: BootstrapSelectionManifest) => {
      m.cells.bun.cells = ['missing']
    },
  ],
  [
    'cyclic prerequisite',
    (m: BootstrapSelectionManifest) => {
      m.cells.bun.cells = ['bun']
    },
  ],
  [
    'empty cell',
    (m: BootstrapSelectionManifest) => {
      m.cells.bun.tools = []
    },
  ],
  [
    'floating version',
    (m: BootstrapSelectionManifest) => {
      m.tools.bun!.expectedVersion = 'latest'
    },
  ],
  [
    'bad checksum',
    (m: BootstrapSelectionManifest) => {
      m.inputs.sources[0].sha256 = 'invented'
    },
  ],
  [
    'escaping source',
    (m: BootstrapSelectionManifest) => {
      m.inputs.sources[0].path = '../outside'
    },
  ],
] as const)('schema refuses %s before any probe', (_name, mutate) => {
  const f = fixture()
  mutate(f.manifest)
  expect(() => validateBootstrapManifest(f.manifest)).toThrow()
})

test('real Bun executable succeeds with actual owned cleanup and sealed observed manifest', async () => {
  const f = fixture()
  f.manifest.tools.bun!.selector = {
    kind: 'absolute-path',
    path: process.execPath,
  }
  f.manifest.tools.bun!.expectedSha256ByHost[f.host] = digest(process.execPath)
  f.persist()
  const result = await verifyBootstrap(f.manifest, f.request, f.deps)
  expect(result.exitCode).toBe(0)
  expect(result.observed.tools[0].version).toBe('1.4.4')
  expect(result.observed.tools[0].command?.cleanup?.output.complete).toBe(true)
  expect(result.observed.tools[0].command?.pid).toBeGreaterThan(0)
  expect(digest(result.receipt.observedManifest.path)).toBe(
    result.receipt.observedManifest.sha256,
  )
  expect(result.receipt.nativeEnforcementApproved).toBe(false)
  expect(result.receipt.B32Accepted).toBe(false)
})

test('PATH symlink preserves selected alias and verified canonical executable', async () => {
  const f = fixture(),
    actual = join(f.root, 'actual-bun')
  writeFileSync(actual, readFileSync(f.tool))
  chmodSync(actual, 0o755)
  rmSync(f.tool)
  symlinkSync(actual, f.tool)
  const result = await verifyBootstrap(f.manifest, f.request, injected(f.deps))
  expect(result.exitCode).toBe(0)
  expect(result.observed.tools[0].selectedPath).toBe(f.tool)
  expect(result.observed.tools[0].resolvedPath).toBe(actual)
})

test('required Rust mismatch cannot silently adopt 1.99.1 or acquire another toolchain', async () => {
  const f = fixture()
  f.manifest.tools.cargo = {
    ...structuredClone(f.manifest.tools.bun!),
    expectedVersion: '1.87.0',
  }
  f.manifest.cells.rust = {
    boundary: 'bootstrap-prerequisites',
    tools: ['cargo'],
    cells: [],
    artifacts: [],
    platform: 'any',
  }
  f.request.requiredCells = ['rust']
  f.persist()
  const calls: readonly string[][] = [],
    mutableCalls = calls as string[][]
  const result = await verifyBootstrap(f.manifest, f.request, {
    ...f.deps,
    probe: async (request) => {
      mutableCalls.push([...request.argv])
      return fakeProbe(request, 'cargo 1.99.1 (fixture)\n')
    },
  })
  expect(result.exitCode).toBe(1)
  expect(result.observed.tools.find((t) => t.id === 'cargo')?.version).toBe(
    '1.99.1',
  )
  expect(mutableCalls).toEqual([[resolve(f.tool), '--version']])
})

test('unrequested unavailable Rust does not fail Bun-only verification', async () => {
  const f = fixture()
  f.manifest.tools.rustc = {
    ...structuredClone(f.manifest.tools.bun!),
    selector: { kind: 'path-name', name: 'absent-rustc' },
    expectedVersion: '1.87.0',
    expectedSha256ByHost: {},
    acquisition: 'separate-required',
  }
  f.manifest.cells.rust = {
    boundary: 'bootstrap-prerequisites',
    tools: ['rustc'],
    cells: [],
    artifacts: [],
    platform: 'any',
  }
  f.persist()
  const result = await verifyBootstrap(f.manifest, f.request, injected(f.deps))
  expect(result.exitCode).toBe(0)
  expect(result.observed.cells.rust.state).toBe('unavailable')
  expect(
    result.observed.tools.find((t) => t.id === 'rustc')?.command,
  ).toBeNull()
})

test.each(['missing', 'nonexecutable', 'corrupt', 'unpinned'] as const)(
  '%s required executable refuses before dispatch',
  async (mode) => {
    const f = fixture()
    if (mode === 'missing') rmSync(f.tool)
    if (mode === 'nonexecutable') chmodSync(f.tool, 0o644)
    if (mode === 'corrupt') writeFileSync(f.tool, 'corrupt bytes')
    if (mode === 'unpinned') f.manifest.tools.bun!.expectedSha256ByHost = {}
    f.persist()
    let calls = 0
    const result = await verifyBootstrap(f.manifest, f.request, {
      ...f.deps,
      probe: async (r) => {
        calls++
        return fakeProbe(r)
      },
    })
    expect(result.exitCode).toBe(1)
    expect(calls).toBe(0)
    expect(result.observed.tools[0].command).toBeNull()
  },
)

test('frozen input mismatch stops all version dispatches', async () => {
  const f = fixture()
  writeFileSync(join(f.root, 'bun.lock'), 'new unreviewed lock')
  let calls = 0
  const result = await verifyBootstrap(f.manifest, f.request, {
    ...f.deps,
    probe: async (r) => {
      calls++
      return fakeProbe(r)
    },
  })
  expect(result.exitCode).toBe(1)
  expect(calls).toBe(0)
  expect(result.receipt.findings.join('\n')).toContain('bun.lock')
})

test('a stale parsed policy cannot acquire credit for a different manifest on disk', async () => {
  const f = fixture(),
    other = structuredClone(f.manifest)
  other.tools.bun!.expectedVersion = '1.99.1'
  writeFileSync(f.request.manifestPath, JSON.stringify(other))
  let calls = 0
  const result = await verifyBootstrap(f.manifest, f.request, {
    ...f.deps,
    probe: async (r) => {
      calls++
      return fakeProbe(r)
    },
  })
  expect(result.exitCode).toBe(2)
  expect(calls).toBe(0)
  expect(result.receipt.findings).toContain(
    'Parsed policy differs from the sealed input manifest',
  )
})

test.each(['source', 'manifest', 'executable'] as const)(
  'detects %s mutation during a probe',
  async (target) => {
    const f = fixture(),
      path =
        target === 'source'
          ? join(f.root, 'source.ts')
          : target === 'manifest'
            ? f.request.manifestPath
            : f.tool
    const result = await verifyBootstrap(f.manifest, f.request, {
      ...f.deps,
      probe: async (r) => {
        writeFileSync(path, 'changed during probe')
        return fakeProbe(r)
      },
    })
    expect(result.exitCode).toBe(1)
    expect(
      result.observed.tools[0].state === 'unavailable' ||
        result.receipt.findings.length > 0,
    ).toBe(true)
  },
)

test.each(['mode-loss', 'missing', 'directory'] as const)(
  'post-probe %s refuses readiness despite successful version output',
  async (change) => {
    const f = fixture()
    const result = await verifyBootstrap(f.manifest, f.request, {
      ...f.deps,
      probe: async (request) => {
        if (change === 'mode-loss') chmodSync(f.tool, 0o644)
        else {
          rmSync(f.tool)
          if (change === 'directory') mkdirSync(f.tool)
        }
        return fakeProbe(request)
      },
    })
    const bun = result.observed.tools[0]
    expect(result.exitCode).toBe(1)
    expect(result.observed.cells.bun.state).toBe('unavailable')
    expect(bun.command?.exitCode).toBe(0)
    expect(bun.state).toBe('unavailable')
    expect(bun.reason).toContain('Post-probe:')
    expect(bun.after?.executable === true && bun.after.isFile === true).toBe(
      false,
    )
    expect(bun.final).not.toBeNull()
  },
)

test.each(['bytes', 'mode', 'replacement', 'alias', 'missing'] as const)(
  'a later probe changing an earlier tool %s is caught by the final sweep',
  async (change) => {
    const f = fixture(),
      node = join(f.root, 'node')
    writeFileSync(node, '#!/bin/sh\nprintf "v26.1.0\\n"\n')
    chmodSync(node, 0o755)
    f.manifest.tools.node = {
      ...structuredClone(f.manifest.tools.bun!),
      selector: { kind: 'absolute-path', path: node },
      expectedVersion: '26.1.0',
      expectedSha256ByHost: { [f.host]: digest(node) },
    }
    f.manifest.cells.node = { ...f.manifest.cells.bun, tools: ['node'] }
    f.request.requiredCells = ['bun', 'node']
    f.persist()
    const original = readFileSync(f.tool)
    if (change === 'alias') {
      const actual = join(f.root, 'actual-bun')
      writeFileSync(actual, original)
      chmodSync(actual, 0o755)
      rmSync(f.tool)
      symlinkSync(actual, f.tool)
    }
    const result = await verifyBootstrap(f.manifest, f.request, {
      ...f.deps,
      probe: async (request) => {
        if (request.argv[0] !== node) return fakeProbe(request)
        if (change === 'bytes') writeFileSync(f.tool, 'changed by later probe')
        if (change === 'mode') chmodSync(f.tool, 0o644)
        if (change === 'replacement') {
          // Keep the original inode live so the filesystem cannot reuse it.
          const held = join(f.root, 'held-original')
          const replacement = join(f.root, 'replacement')
          writeFileSync(replacement, original)
          chmodSync(replacement, 0o755)
          renameSync(f.tool, held)
          renameSync(replacement, f.tool)
        }
        if (change === 'alias') {
          const alternative = join(f.root, 'alternate')
          writeFileSync(alternative, original)
          chmodSync(alternative, 0o755)
          rmSync(f.tool)
          symlinkSync(alternative, f.tool)
        }
        if (change === 'missing') rmSync(f.tool)
        return fakeProbe(request, 'v26.1.0\n')
      },
    })
    const bun = result.observed.tools.find((tool) => tool.id === 'bun')!,
      observedNode = result.observed.tools.find((tool) => tool.id === 'node')!
    expect(result.exitCode).toBe(1)
    expect(bun.after?.sha256).toBe(bun.before?.sha256)
    expect(bun.after?.executable).toBe(true)
    expect(bun.state).toBe('unavailable')
    expect(bun.reason).toContain('Final sweep:')
    expect(bun.final?.canonical).not.toBeNull()
    expect(result.observed.cells.bun.reasons).toContain(`bun: ${bun.reason}`)
    expect(observedNode.state).toBe('available')
    expect(result.observed.cells.node.state).toBe('available')
  },
)

test('final sweep cannot upgrade a failed tool even if a later probe repairs it', async () => {
  const f = fixture(),
    node = join(f.root, 'node')
  writeFileSync(node, '#!/bin/sh\nprintf "v26.1.0\\n"\n')
  chmodSync(node, 0o755)
  f.manifest.tools.node = {
    ...structuredClone(f.manifest.tools.bun!),
    selector: { kind: 'absolute-path', path: node },
    expectedVersion: '26.1.0',
    expectedSha256ByHost: { [f.host]: digest(node) },
  }
  f.manifest.cells.node = { ...f.manifest.cells.bun, tools: ['node'] }
  f.request.requiredCells = ['bun', 'node']
  f.persist()
  const result = await verifyBootstrap(f.manifest, f.request, {
    ...f.deps,
    probe: async (request) => {
      chmodSync(f.tool, request.argv[0] === node ? 0o755 : 0o644)
      return fakeProbe(
        request,
        request.argv[0] === node ? 'v26.1.0\n' : '1.4.4\n',
      )
    },
  })
  const bun = result.observed.tools[0]
  expect(result.exitCode).toBe(1)
  expect(bun.after?.executable).toBe(false)
  expect(bun.final?.canonical?.executable).toBe(true)
  expect(bun.final?.reason).toBeNull()
  expect(bun.state).toBe('unavailable')
  expect(bun.reason).toBe('Post-probe: Executable is nonexecutable')
})

test('a later BODY_BUN-only alias replacement refuses otherwise unchanged Bun readiness', async () => {
  const f = fixture(),
    node = join(f.root, 'node'),
    override = join(f.root, 'body-bun'),
    alternative = join(f.root, 'alternate-bun')
  symlinkSync(f.tool, override)
  writeFileSync(alternative, readFileSync(f.tool))
  chmodSync(alternative, 0o755)
  writeFileSync(node, '#!/bin/sh\nprintf "v26.1.0\\n"\n')
  chmodSync(node, 0o755)
  f.manifest.tools.node = {
    ...structuredClone(f.manifest.tools.bun!),
    selector: { kind: 'absolute-path', path: node },
    expectedVersion: '26.1.0',
    expectedSha256ByHost: { [f.host]: digest(node) },
  }
  f.manifest.cells.node = { ...f.manifest.cells.bun, tools: ['node'] }
  f.request.requiredCells = ['bun', 'node']
  f.persist()
  const result = await verifyBootstrap(f.manifest, f.request, {
    ...f.deps,
    environment: { ...f.deps.environment, BODY_BUN: override },
    probe: async (request) => {
      if (request.argv[0] === node) {
        rmSync(override)
        symlinkSync(alternative, override)
      }
      return fakeProbe(
        request,
        request.argv[0] === node ? 'v26.1.0\n' : '1.4.4\n',
      )
    },
  })
  const bun = result.observed.tools[0]
  expect(result.exitCode).toBe(1)
  expect(bun.final?.canonical?.sha256).toBe(bun.before?.sha256)
  expect(bun.final?.alias?.inode).toBe(bun.before?.inode)
  expect(bun.final?.bodyBun?.path).toBe(override)
  expect(bun.final?.bodyBun?.resolvedPath).toBe(alternative)
  expect(bun.final?.bodyBun?.file.sha256).toBe(bun.before?.sha256)
  expect(bun.state).toBe('unavailable')
  expect(bun.reason).toContain('Final sweep: BODY_BUN:')
  expect(result.observed.cells.bun.state).toBe('unavailable')
})

test.each([
  'nonzero',
  'undrained',
  'cleanup-failed',
  'timeout',
  'quota',
  'cancelled',
  'late',
] as const)('retains %s probe failure', async (mode) => {
  const f = fixture()
  const result = await verifyBootstrap(f.manifest, f.request, {
    ...f.deps,
    probe: async (r) => {
      const p = fakeProbe(r)
      if (mode === 'nonzero') p.exitCode = 3
      if (mode === 'undrained')
        p.cleanup = {
          ...p.cleanup!,
          output: { ...p.cleanup!.output, complete: false },
        }
      if (mode === 'cleanup-failed')
        p.cleanup = {
          ...p.cleanup!,
          status: 'failed',
          satisfiesSelectedTier: false,
        }
      if (mode === 'timeout') p.timedOut = true
      if (mode === 'quota') p.outputLimitExceeded = true
      if (mode === 'cancelled') p.aborted = true
      if (mode === 'late') p.elapsedMs = 10_001
      return p
    },
  })
  expect(result.exitCode).toBe(1)
  expect(result.observed.tools[0].command).not.toBeNull()
})

test('SDK minimum comes from the sealed manifest and refuses unsupported changed expressions', async () => {
  const f = fixture()
  f.manifest.tools.node = {
    ...structuredClone(f.manifest.tools.bun!),
    expectedVersion: '20.2.0',
    versionConstraintSource: {
      file: f.seal('package.json'),
      jsonPointer: '/engines/node',
    },
  }
  f.manifest.cells.node = { ...f.manifest.cells.bun, tools: ['node'] }
  f.request.requiredCells = ['node']
  f.persist()
  const result = await verifyBootstrap(
    f.manifest,
    f.request,
    injected(f.deps, 'v20.2.0\n'),
  )
  expect(result.exitCode).toBe(1)
  expect(result.observed.tools.find((t) => t.id === 'node')?.reason).toContain(
    'SDK minimum',
  )
  writeFileSync(join(f.root, 'package.json'), '{"engines":{"node":"^20.3.0"}}')
  f.manifest.inputs.packages[0] = f.seal('package.json')
  f.manifest.tools.node!.expectedVersion = '26.1.0'
  f.manifest.tools.node!.versionConstraintSource!.file = f.seal('package.json')
  f.request.evidenceDir = join(f.root, 'unsupported')
  f.persist()
  const changed = await verifyBootstrap(
    f.manifest,
    f.request,
    injected(f.deps, 'v26.1.0\n'),
  )
  expect(changed.exitCode).toBe(1)
  expect(changed.observed.tools.find((t) => t.id === 'node')?.reason).toContain(
    'Unsupported SDK minimum',
  )
})

test('tool readiness cannot certify a declared native enforcement capability', async () => {
  const f = fixture()
  f.manifest.capabilities[0] = {
    id: 'seccomp',
    state: 'verified',
    boundary: 'author claim',
    proof: f.seal('source.ts'),
  }
  f.persist()
  const result = await verifyBootstrap(f.manifest, f.request, injected(f.deps))
  expect(result.exitCode).toBe(0)
  expect(result.observed.capabilities[0].state).toBe('unavailable')
  expect(result.receipt.nativeEnforcementApproved).toBe(false)
})

test('checkout bytes cannot satisfy an isolated-installed artifact cell', async () => {
  const f = fixture()
  f.manifest.artifacts.push({
    id: 'sdk-installed',
    path: 'source.ts',
    sha256: digest(join(f.root, 'source.ts')),
    executable: false,
    buildReceipt: f.seal('package.json'),
    boundary: 'isolated-installed',
  })
  f.manifest.cells.installed = {
    boundary: 'bootstrap-prerequisites',
    tools: [],
    cells: [],
    artifacts: ['sdk-installed'],
    platform: 'any',
  }
  f.request.requiredCells = ['installed']
  f.persist()
  const result = await verifyBootstrap(f.manifest, f.request, injected(f.deps))
  expect(result.exitCode).toBe(1)
  expect(result.observed.cells.installed.reasons).toContain(
    'Artifact boundary unverified: sdk-installed',
  )
})

test('an unrelated or stale producer receipt cannot certify current artifact build provenance', async () => {
  const f = fixture()
  f.manifest.artifacts.push({
    id: 'native-bytes',
    path: 'source.ts',
    sha256: digest(join(f.root, 'source.ts')),
    executable: false,
    buildReceipt: f.seal('package.json'),
    boundary: 'native-build',
  })
  f.manifest.cells.native = {
    boundary: 'bootstrap-prerequisites',
    tools: [],
    cells: [],
    artifacts: ['native-bytes'],
    platform: 'any',
  }
  f.request.requiredCells = ['native']
  f.persist()
  const result = await verifyBootstrap(f.manifest, f.request, injected(f.deps))
  expect(result.exitCode).toBe(1)
  expect(result.observed.cells.native.state).toBe('unavailable')
})

test('artifact byte provenance requires the exact current frozen source union and remains separate from enforcement', async () => {
  const f = fixture(),
    proof = join(f.root, 'build-proof.json')
  writeFileSync(
    proof,
    JSON.stringify({
      schemaVersion: 1,
      type: 'body-bootstrap-artifact-build',
      exitCode: 0,
      artifact: {
        path: 'source.ts',
        sha256: digest(join(f.root, 'source.ts')),
      },
      sourceContractHashes: Object.fromEntries(
        f.manifest.inputs.sources.map((s) => [s.path, s.sha256]),
      ),
      contextContractHashes: Object.fromEntries(
        [
          ...f.manifest.inputs.packages,
          ...f.manifest.inputs.locks,
          ...f.manifest.inputs.configuration,
        ].map((s) => [s.path, s.sha256]),
      ),
    }),
  )
  f.manifest.artifacts.push({
    id: 'native-bytes',
    path: 'source.ts',
    sha256: digest(join(f.root, 'source.ts')),
    executable: false,
    buildReceipt: f.seal('build-proof.json'),
    boundary: 'native-build',
  })
  f.manifest.cells.native = {
    boundary: 'bootstrap-prerequisites',
    tools: [],
    cells: [],
    artifacts: ['native-bytes'],
    platform: 'any',
  }
  f.request.requiredCells = ['native']
  f.persist()
  const result = await verifyBootstrap(f.manifest, f.request, injected(f.deps))
  expect(result.exitCode).toBe(0)
  expect(result.receipt.nativeEnforcementApproved).toBe(false)
})

test('artifact drift is retained even when the artifact is unrequested', async () => {
  const f = fixture(),
    artifact = join(f.root, 'artifact')
  writeFileSync(artifact, 'old artifact')
  f.manifest.artifacts.push({
    id: 'optional',
    path: 'artifact',
    sha256: null,
    executable: false,
    buildReceipt: null,
    boundary: 'checkout-build',
  })
  f.persist()
  const result = await verifyBootstrap(f.manifest, f.request, {
    ...f.deps,
    probe: async (r) => {
      writeFileSync(artifact, 'new artifact')
      return fakeProbe(r)
    },
  })
  expect(result.exitCode).toBe(1)
  expect(result.receipt.findings).toContain('Artifact drift: artifact')
})

test('conflicting exported paths fail without any probe, and missing cells cannot pass', async () => {
  const f = fixture()
  const result = await verifyBootstrap(f.manifest, f.request, {
    ...injected(f.deps),
    environment: { BODY_EVIDENCE: '/different-evidence' },
  })
  expect(result.exitCode).toBe(2)
  expect(result.observed.tools).toEqual([])
})

test('evidence collision preserves the original receipt; write failure cannot report success', async () => {
  const f = fixture(),
    deps = injected(f.deps)
  await verifyBootstrap(f.manifest, f.request, deps)
  const before = readFileSync(join(f.request.evidenceDir, 'receipt.json'))
  await expect(verifyBootstrap(f.manifest, f.request, deps)).rejects.toThrow()
  expect(readFileSync(join(f.request.evidenceDir, 'receipt.json'))).toEqual(
    before,
  )
  f.request.evidenceDir = join(f.root, 'failure')
  await expect(
    verifyBootstrap(f.manifest, f.request, {
      ...deps,
      writeEvidence: () => {
        throw new Error('write refused')
      },
    }),
  ).rejects.toThrow('write refused')
})

test('production runner joins split output and physically cleans an actual child', async () => {
  const result = await runBootstrapProbe({
    argv: [
      process.execPath,
      '-e',
      'process.stdout.write("1."); await Bun.sleep(10); process.stdout.write("4.4\\n")',
    ],
    cwd: tmpdir(),
    env: {},
    timeoutMs: 1000,
    maxOutputBytes: 1024,
  })
  expect(result.stdout).toBe('1.4.4\n')
  expect(result.exitCode).toBe(0)
  expect(result.cleanup?.status).toBe('complete')
  expect(result.cleanup?.output.complete).toBe(true)
})

test('production runner kills timeout/quota cases and retains the selected failure', async () => {
  for (const quota of [false, true]) {
    const result = await runBootstrapProbe({
      argv: [
        process.execPath,
        '-e',
        quota
          ? 'process.stdout.write("x".repeat(100000)); await Bun.sleep(10000)'
          : 'await Bun.sleep(10000)',
      ],
      cwd: tmpdir(),
      env: {},
      timeoutMs: 100,
      maxOutputBytes: 128,
    })
    expect(quota ? result.outputLimitExceeded : result.timedOut).toBe(true)
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(128)
    expect(result.cleanup?.status).toBe('complete')
    expect(result.exitCode).not.toBe(0)
    if (quota) {
      expect(result.cleanup?.output.complete).toBe(false)
      expect(result.cleanup?.selectedLimitSatisfied).toBe(false)
    }
  }
})

test('pre-cancelled production probe has no child or fabricated cleanup', async () => {
  const controller = new AbortController()
  controller.abort()
  const result = await runBootstrapProbe({
    argv: [process.execPath, '--version'],
    cwd: tmpdir(),
    env: {},
    timeoutMs: 100,
    maxOutputBytes: 128,
    signal: controller.signal,
  })
  expect(result.pid).toBeNull()
  expect(result.cleanup).toBeNull()
  expect(result.aborted).toBe(true)
})

test('cancellation after actual dispatch joins process cleanup', async () => {
  const controller = new AbortController(),
    timer = setTimeout(() => controller.abort(), 50)
  try {
    const result = await runBootstrapProbe({
      argv: [process.execPath, '-e', 'await Bun.sleep(10000)'],
      cwd: tmpdir(),
      env: {},
      timeoutMs: 1000,
      maxOutputBytes: 128,
      signal: controller.signal,
    })
    expect(result.pid).toBeGreaterThan(0)
    expect(result.aborted).toBe(true)
    expect(result.cleanup?.status).toBe('complete')
    expect(result.cleanup?.trigger).toBe('owner-cancel')
  } finally {
    clearTimeout(timer)
  }
})

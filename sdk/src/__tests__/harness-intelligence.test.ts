import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

import { afterEach, describe, expect, test } from 'bun:test'

import { getOwnedTempRoots } from '@codebuff/common/util/project-path-containment'

import {
  VerifiedKnowledgeService,
  WorkspaceLeaseService,
  __getAsyncDiscoverySyncReadsForTest,
  __getDiscoveryCacheSizeForTest,
  __getInspectPhaseEventsForTest,
  __getOffLoopFilesystemMaxProbesInFlightForTest,
  __getOffLoopFilesystemProbeCountForTest,
  __getWorkspaceOwnershipResolutionCountForTest,
  __resetInspectPhaseEventsForTest,
  __resetOffLoopFilesystemMaxProbesInFlightForTest,
  __resetWorkspaceOwnershipResolutionCountForTest,
  __setToolProbeSpawnForTest,
  analyzeTestImpact,
  analyzeTestImpactAsync,
  classifyConnectorOperation,
  clearHarnessDiscoveryCache,
  clearHarnessToolsCache,
  createContextPacket,
  getAffectedTestTargets,
  getAffectedTestTargetsAsync,
  getBuildTargets,
  getBuildTargetsAsync,
  inspectHarnessEnvironment,
} from '../services/harness-intelligence'
import { LocalHarnessStore } from '../services/local-harness-store'

const roots: string[] = []
const FILESYSTEM_DISCOVERY_TIMEOUT_MS = 15_000
const CROSS_PROCESS_TIMEOUT_MS = 30_000
const CROSS_PROCESS_READY_TIMEOUT_MS = 20_000

// Recorded baseline for the async probe path (see probeToolsAsync): all 14
// `--version` probes are in flight at once, so a probe-cache miss costs one
// probe timeout instead of the sum of 14 serial spawns. This constant pins the
// claim so a future serializing change fails loudly.
const TOOL_PROBE_COUNT = 14
// The width every bounded filesystem fan-out in harness-intelligence.ts uses:
// libuv's default thread pool is four threads and it also serves the render
// loop's own fs work, so the collectors batch at this width like the walks do.
const DISCOVERY_WALK_WIDTH = 8
// Deterministic stand-in for a probe's runtime. Long enough that serial spawns
// would exceed one timeout (14 x 400ms = 5.6s), short enough to stay cheap.
const FAKE_PROBE_LATENCY_MS = 400
// Mirrors discoveryCacheMaxEntries in harness-intelligence.ts: the documented
// bound on the discovery cache, which has to cover the in-flight (pending)
// entries as well as the resolved ones.
const DISCOVERY_CACHE_MAX_ENTRIES = 32

afterEach(() => {
  clearHarnessDiscoveryCache()
  clearHarnessToolsCache()
  __setToolProbeSpawnForTest()
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true })
})

function tempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openbuff-intelligence-'))
  roots.push(root)
  return root
}

describe('harness intelligence services', () => {
  test(
    'inspects package manager, manifests, lockfiles, and tools',
    async () => {
      const root = tempRoot()
      fs.writeFileSync(path.join(root, 'package.json'), '{}')
      fs.writeFileSync(path.join(root, 'bun.lock'), '')
      expect(await inspectHarnessEnvironment(root)).toMatchObject({
        cwd: root,
        packageManager: 'bun',
        manifests: ['package.json'],
        lockfiles: ['bun.lock'],
        tools: { git: { available: true } },
      })
    },
    FILESYSTEM_DISCOVERY_TIMEOUT_MS,
  )

  test(
    'maps source files to existing tests and package build scripts',
    () => {
      const root = tempRoot()
      fs.mkdirSync(path.join(root, 'packages', 'api', 'src'), {
        recursive: true,
      })
      fs.writeFileSync(
        path.join(root, 'packages', 'api', 'package.json'),
        JSON.stringify({ scripts: { typecheck: 'tsc', test: 'bun test' } }),
      )
      fs.writeFileSync(
        path.join(root, 'packages', 'api', 'src', 'user.test.ts'),
        '',
      )
      expect(
        getAffectedTestTargets(root, ['packages/api/src/user.ts'])[0],
      ).toMatchObject({
        candidates: ['packages/api/src/user.test.ts'],
        packageRoot: 'packages/api',
      })
      expect(
        getBuildTargets(root, ['packages/api/src/user.ts'])[0],
      ).toMatchObject({
        packageRoot: 'packages/api',
        scripts: ['typecheck', 'test'],
      })
    },
    FILESYSTEM_DISCOVERY_TIMEOUT_MS,
  )

  test(
    'tiers test impact by convention, injected graph deps, and build tool commands',
    () => {
      const root = tempRoot()
      fs.mkdirSync(path.join(root, 'packages/api/src/__tests__'), {
        recursive: true,
      })
      fs.writeFileSync(
        path.join(root, 'packages/api/package.json'),
        JSON.stringify({
          scripts: { 'test:unit': 'bun test', build: 'tsc' },
        }),
      )
      fs.writeFileSync(
        path.join(root, 'packages/api/src/user.test.ts'),
        '',
      )
      fs.writeFileSync(
        path.join(root, 'packages/api/src/__tests__/user.test.ts'),
        '',
      )

      const [impact] = analyzeTestImpact(
        root,
        ['packages/api/src/user.ts'],
        {
          reverseDeps: (file) =>
            file === 'packages/api/src/user.ts'
              ? [
                  // Duplicate and non-test dependents exercise dedupe + filtering.
                  'packages/api/src/__tests__/user.test.ts',
                  'packages/api/src/__tests__/user.test.ts',
                  'packages/api/src/routes.ts',
                  'packages/api/e2e/user.spec.ts',
                ]
              : [],
        },
      )
      // Convention tier is unchanged: only existing files, same paths the
      // flat getAffectedTestTargets convention candidates report.
      expect(impact.tiers.convention).toEqual(
        getAffectedTestTargets(root, ['packages/api/src/user.ts'])[0]
          .candidates,
      )
      expect(impact.tiers.convention).toEqual([
        'packages/api/src/user.test.ts',
        'packages/api/src/__tests__/user.test.ts',
      ])
      // Graph tier keeps only test-like reverse deps, deduped and sorted.
      expect(impact.tiers.graph).toEqual([
        'packages/api/e2e/user.spec.ts',
        'packages/api/src/__tests__/user.test.ts',
      ])
      // Confirmed nested package: medium-confidence build-tool commands.
      expect(impact.tiers.buildTool).toEqual(['npm run test:unit'])
      // Coverage maps land later; the tier is an honest empty placeholder.
      expect(impact.tiers.coverage).toEqual([])
      // Every candidate is confidence-labelled, and the path seen by both
      // convention and graph tiers keeps the higher-confidence convention one.
      expect(impact.candidates).toEqual([
        {
          path: 'packages/api/src/user.test.ts',
          tier: 'convention',
          confidence: 'high',
        },
        {
          path: 'packages/api/src/__tests__/user.test.ts',
          tier: 'convention',
          confidence: 'high',
        },
        {
          path: 'packages/api/e2e/user.spec.ts',
          tier: 'graph',
          confidence: 'medium',
        },
        {
          path: 'npm run test:unit',
          tier: 'build-tool',
          confidence: 'medium',
        },
      ])
      for (const candidate of impact.candidates) {
        expect(['high', 'medium', 'low']).toContain(candidate.confidence)
      }
    },
    FILESYSTEM_DISCOVERY_TIMEOUT_MS,
  )

  test('build-tool tier falls back to low confidence for unconfirmed owners', () => {
    const root = tempRoot()
    fs.writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ scripts: { test: 'bun test' } }),
    )
    fs.mkdirSync(path.join(root, 'pkg'), { recursive: true })
    fs.writeFileSync(
      path.join(root, 'pkg/package.json'),
      JSON.stringify({ scripts: { test: 'bun test' } }),
    )
    fs.mkdirSync(path.join(root, 'crates', 'core'), { recursive: true })
    fs.writeFileSync(
      path.join(root, 'crates', 'core', 'Cargo.toml'),
      '[package]\nname="core"',
    )

    const [cargoImpact, rootJsImpact, nestedJsImpact] = analyzeTestImpact(root, [
      'crates/core/src/lib.rs',
      'top-level.ts',
      'pkg/widget.ts',
    ])
    // Cargo ownership is manifest-derived, so the command is confirmed...
    expect(cargoImpact.tiers.buildTool).toEqual(['cargo test -p core'])
    expect(cargoImpact.candidates).toEqual([
      { path: 'cargo test -p core', tier: 'build-tool', confidence: 'medium' },
    ])
    // ...while a root package.json only implicitly owns top-level files, so
    // the same command drops to low confidence...
    expect(rootJsImpact.tiers.buildTool).toEqual(['npm run test'])
    expect(rootJsImpact.candidates).toEqual([
      { path: 'npm run test', tier: 'build-tool', confidence: 'low' },
    ])
    // ...and a nested package.json confirms ownership with medium confidence.
    expect(nestedJsImpact.tiers.buildTool).toEqual(['npm run test'])
    expect(nestedJsImpact.candidates).toEqual([
      { path: 'npm run test', tier: 'build-tool', confidence: 'medium' },
    ])
  })

  test(
    'bounds the discovery walk (depth cap) instead of recursing unboundedly',
    async () => {
      // F3 hardening ported from build-graph: the walk must not follow a deep
      // chain forever. MAX_WALK_DEPTH is 12, so a manifest nested deeper than
      // that is simply not discovered (and the walk terminates quickly).
      const root = tempRoot()
      const segments = Array.from({ length: 15 }, (_, i) => `d${i}`)
      const deep = path.join(root, ...segments)
      fs.mkdirSync(deep, { recursive: true })
      fs.writeFileSync(path.join(deep, 'package.json'), '{}')
      const shallowDir = path.join(root, ...segments.slice(0, 5))
      fs.writeFileSync(path.join(shallowDir, 'package.json'), '{}')

      const manifests = (await inspectHarnessEnvironment(root)).manifests
      // Within the cap: found. Beyond MAX_WALK_DEPTH: not fabricated.
      expect(manifests).toEqual([
        `${segments.slice(0, 5).join('/')}/package.json`,
      ])
    },
    FILESYSTEM_DISCOVERY_TIMEOUT_MS,
  )

  test('discovery skips symlinked directories entirely', async () => {
    // Symlinks are skipped during the walk, so a manifest reachable only
    // through a symlink is never reported (symlink loops cannot hang it).
    const root = tempRoot()
    const outside = tempRoot()
    fs.writeFileSync(path.join(outside, 'package.json'), '{}')
    fs.symlinkSync(outside, path.join(root, 'linked'))

    expect((await inspectHarnessEnvironment(root)).manifests).toEqual([])
  })

  test(
    'reads package.json text only when no lockfile in scope names the manager',
    async () => {
      // Fallback branch: with no lockfile anywhere in scope, the manifest's
      // `packageManager` field is the only source of the manager — the one case
      // the async manifest pre-read still has to read the text for.
      const inferredRoot = tempRoot()
      fs.writeFileSync(
        path.join(inferredRoot, 'package.json'),
        JSON.stringify({ packageManager: 'pnpm@9.0.0' }),
      )
      expect(
        (await inspectHarnessEnvironment(inferredRoot)).workspaces,
      ).toEqual([
        expect.objectContaining({ manager: 'pnpm', confidence: 'confirmed' }),
      ])

      // The same declaration beside a lockfile: the lockfile decides, so the
      // manifest text is never consulted (and the pre-read skips reading it).
      const lockfileRoot = tempRoot()
      fs.writeFileSync(
        path.join(lockfileRoot, 'package.json'),
        JSON.stringify({ packageManager: 'pnpm@9.0.0' }),
      )
      fs.writeFileSync(path.join(lockfileRoot, 'bun.lock'), '')
      expect(
        (await inspectHarnessEnvironment(lockfileRoot)).workspaces,
      ).toEqual([
        expect.objectContaining({ manager: 'bun', confidence: 'confirmed' }),
      ])
    },
    FILESYSTEM_DISCOVERY_TIMEOUT_MS,
  )

  test(
    'async discovery never absorbs a blocking manifest read',
    async () => {
      // The async twin exists so the event loop never absorbs a blocking
      // manifest read, and `inferWorkspace` now takes an explicit read mode so
      // that is a property of the READ SITE rather than of which manifests the
      // pre-read happened to cover. Both shapes below reach the manifest-text
      // branch (no lockfile in scope) — one readable, one deleted between the
      // walk and the pre-read — and neither may fall back to `readFileSync`.
      const readableRoot = tempRoot()
      fs.writeFileSync(
        path.join(readableRoot, 'package.json'),
        JSON.stringify({ packageManager: 'pnpm@9.0.0' }),
      )
      expect(
        (await inspectHarnessEnvironment(readableRoot)).workspaces,
      ).toEqual([
        expect.objectContaining({ manager: 'pnpm', confidence: 'confirmed' }),
      ])

      // A manifest the pre-read could not read answers through the existing
      // unknown-confidence parse failure instead of a second, blocking read.
      const unreadableRoot = tempRoot()
      fs.mkdirSync(path.join(unreadableRoot, 'pkg'), { recursive: true })
      fs.writeFileSync(path.join(unreadableRoot, 'package.json'), '{}')
      fs.writeFileSync(path.join(unreadableRoot, 'pkg', 'package.json'), '{}')
      expect(
        (await inspectHarnessEnvironment(unreadableRoot)).workspaces.length,
      ).toBeGreaterThan(0)

      expect(__getAsyncDiscoverySyncReadsForTest()).toBe(0)
    },
    FILESYSTEM_DISCOVERY_TIMEOUT_MS,
  )

  test(
    'off-loop tool paths probe every candidate and manifest off the event loop',
    async () => {
      const root = tempRoot()
      fs.mkdirSync(path.join(root, 'crates', 'core', 'src'), {
        recursive: true,
      })
      fs.writeFileSync(
        path.join(root, 'package.json'),
        JSON.stringify({ scripts: { test: 'bun test' } }),
      )
      fs.writeFileSync(path.join(root, 'app.test.ts'), '')
      fs.writeFileSync(
        path.join(root, 'crates', 'core', 'Cargo.toml'),
        '[package]\nname = "core"\n',
      )
      const files = ['app.ts', 'crates/core/src/lib.rs']

      // Blocking reference results first, so their synchronous probes are not
      // attributed to the async measurements below.
      const syncTargets = getAffectedTestTargets(root, files)
      const syncImpact = analyzeTestImpact(root, files)
      const syncBuildTargets = getBuildTargets(root, files)

      // A fresh discovery walk per async call, so each probe count describes
      // that call alone instead of a warm cache entry.
      const probeCounts: number[] = []
      const measure = async <T>(run: () => Promise<T>): Promise<T> => {
        clearHarnessDiscoveryCache()
        const before = __getOffLoopFilesystemProbeCountForTest()
        const result = await run()
        probeCounts.push(__getOffLoopFilesystemProbeCountForTest() - before)
        return result
      }
      const targets = await measure(() =>
        getAffectedTestTargetsAsync(root, files),
      )
      const impact = await measure(() => analyzeTestImpactAsync(root, files))
      const buildTargets = await measure(() => getBuildTargetsAsync(root, files))

      // The off-loop twins report exactly what the blocking collectors report.
      expect(targets).toEqual(syncTargets)
      expect(impact).toEqual(syncImpact)
      expect(buildTargets).toEqual(syncBuildTargets)

      // ...and every filesystem question goes through the awaited probes: four
      // convention candidates per file for the target and impact collectors,
      // the one manifest read each for the owning javascript and Cargo
      // workspaces, and the javascript manifest read for build targets. A path
      // that went back to existsSync/readFileSync would fall below this
      // baseline, restoring the blocking work on the render loop.
      expect(probeCounts).toEqual([8, 10, 1])
    },
    FILESYSTEM_DISCOVERY_TIMEOUT_MS,
  )

  test(
    'bounds the off-loop collector fan-out for a large caller-supplied file list',
    async () => {
      // `get_affected_tests` accepts an unbounded array of files and issues four
      // convention stats per file, so an unbounded fan-out would queue 4N tasks
      // onto libuv's four-thread pool, which also serves the render loop's own
      // fs work. The collectors therefore batch at the same width the two walks
      // in this module use; this pins that bound with a 500-file input the way
      // the walk bound is pinned.
      const root = tempRoot()
      fs.mkdirSync(path.join(root, 'src'), { recursive: true })
      fs.writeFileSync(
        path.join(root, 'package.json'),
        JSON.stringify({ scripts: { test: 'bun test' } }),
      )
      const files = Array.from(
        { length: 500 },
        (_, index) => `src/file-${index}.ts`,
      )

      const measure = async (run: () => Promise<unknown>): Promise<number> => {
        clearHarnessDiscoveryCache()
        __resetOffLoopFilesystemMaxProbesInFlightForTest()
        await run()
        return __getOffLoopFilesystemMaxProbesInFlightForTest()
      }

      const targetsInFlight = await measure(() =>
        getAffectedTestTargetsAsync(root, files),
      )
      const impactInFlight = await measure(() => analyzeTestImpactAsync(root, files))
      const buildInFlight = await measure(() => getBuildTargetsAsync(root, files))

      // 2,000 candidate stats never sit in flight at once: the widest fan-out
      // any collector reached is the shared walk width.
      expect(targetsInFlight).toBeLessThanOrEqual(DISCOVERY_WALK_WIDTH)
      expect(impactInFlight).toBeLessThanOrEqual(DISCOVERY_WALK_WIDTH)
      expect(buildInFlight).toBeLessThanOrEqual(DISCOVERY_WALK_WIDTH)
      // ...and the bound did not degenerate into a serial loop: more than one
      // probe at a time is what makes the batch a batch.
      expect(targetsInFlight).toBeGreaterThan(1)
      expect(impactInFlight).toBeGreaterThan(1)
    },
    FILESYSTEM_DISCOVERY_TIMEOUT_MS,
  )

  test(
    'reads one manifest per unique manifest, not one per changed file',
    async () => {
      // `get_affected_tests` takes an unbounded caller-supplied file list, so a
      // 500-file request against a single-package repo used to issue 500
      // identical reads of the same package.json and parse each one again. The
      // bound on fan-out width does not reduce total work, so the read count is
      // pinned separately: four convention stats per file plus exactly ONE
      // manifest read.
      const root = tempRoot()
      fs.mkdirSync(path.join(root, 'src'), { recursive: true })
      fs.writeFileSync(
        path.join(root, 'package.json'),
        JSON.stringify({ scripts: { test: 'bun test' } }),
      )
      const files = Array.from(
        { length: 500 },
        (_, index) => `src/file-${index}.ts`,
      )

      clearHarnessDiscoveryCache()
      const before = __getOffLoopFilesystemProbeCountForTest()
      const impact = await analyzeTestImpactAsync(root, files)
      const probes = __getOffLoopFilesystemProbeCountForTest() - before

      expect(probes).toBe(files.length * 4 + 1)
      // Every file still reports the shared package's build-tool commands, so
      // deduping the reads did not drop any file's manifest-derived tier.
      expect(impact).toHaveLength(files.length)
      expect(
        impact.every(
          (entry) =>
            entry.tiers.buildTool.length > 0 &&
            entry.tiers.buildTool[0] === 'npm run test',
        ),
      ).toBe(true)
      // ...and the deduped text still matches the blocking collector.
      expect(impact).toEqual(analyzeTestImpact(root, files))
    },
    FILESYSTEM_DISCOVERY_TIMEOUT_MS,
  )

  test(
    'bounds the discovery cache while many distinct roots are in flight',
    async () => {
      // The cache docblock promises a bounded Map "for long sessions that visit
      // many working directories", and both the resolved publish and the
      // cache-hit refresh go through one eviction helper. The in-flight entry
      // used to be a raw `set`, so concurrent lookups over many distinct roots
      // (the aux gate issues three tools per iteration, each resolving its own
      // root) grew the map past that bound until each pending promise resolved.
      // N > cap roots started in the same tick leave the map AT the cap, and
      // every one of them is still pending here — so the assertion cannot be
      // satisfied by the resolved publishes evicting after the fact.
      const rootCount = DISCOVERY_CACHE_MAX_ENTRIES + 8
      const distinctRoots = Array.from({ length: rootCount }, () => tempRoot())
      clearHarnessDiscoveryCache()

      // Started synchronously and not awaited: `discoverWorkspacesAsync` stores
      // its pending entry before its first await, so the map already holds one
      // entry per root by the time this line returns.
      const inFlight = distinctRoots.map((root) =>
        getAffectedTestTargetsAsync(root, ['src/app.ts']),
      )
      const pendingSize = __getDiscoveryCacheSizeForTest()

      expect(pendingSize).toBe(DISCOVERY_CACHE_MAX_ENTRIES)
      expect(pendingSize).toBeLessThan(rootCount)

      // The bound did not drop work: every root still resolves its own record.
      const resolved = await Promise.all(inFlight)
      expect(resolved).toHaveLength(rootCount)
      expect(__getDiscoveryCacheSizeForTest()).toBeLessThanOrEqual(
        DISCOVERY_CACHE_MAX_ENTRIES,
      )
    },
    FILESYSTEM_DISCOVERY_TIMEOUT_MS,
  )

  test(
    'a discovery cache clear during an in-flight walk is not resurrected',
    async () => {
      // clearHarnessDiscoveryCache() is the escape hatch for a caller that just
      // scaffolded a workspace. An in-flight walk used to publish after two
      // awaits with no identity check, discarding that clear and serving the
      // pre-clear workspace view for another 5s window.
      const root = tempRoot()
      fs.writeFileSync(
        path.join(root, 'package.json'),
        JSON.stringify({ scripts: { test: 'bun test' } }),
      )
      clearHarnessDiscoveryCache()

      // Started, not awaited: the pending entry is written synchronously.
      const inFlight = inspectHarnessEnvironment(root)
      clearHarnessDiscoveryCache()

      // Scaffolded AFTER the clear: the async walk must not publish its
      // pre-clear view back over the invalidated slot.
      fs.mkdirSync(path.join(root, 'packages', 'api'), { recursive: true })
      fs.writeFileSync(
        path.join(root, 'packages', 'api', 'package.json'),
        JSON.stringify({ scripts: { test: 'bun test' } }),
      )
      await inFlight

      // The next inspection re-walks and therefore sees the new manifest; a
      // resurrected pre-clear entry would hide it for the full TTL.
      expect((await inspectHarnessEnvironment(root)).manifests).toEqual([
        'package.json',
        'packages/api/package.json',
      ])
    },
    FILESYSTEM_DISCOVERY_TIMEOUT_MS,
  )

  test(
    'a tool-probe cache clear during an in-flight group is not resurrected',
    async () => {
      // The mirror case on the 60s tools cache: a rejected/cleared slot must not
      // be republished by a probe group that started before the clear.
      const root = tempRoot()
      fs.writeFileSync(path.join(root, 'package.json'), '{}')
      const spawns: string[] = []
      const pendingTimers = new Set<ReturnType<typeof setTimeout>>()

      __setToolProbeSpawnForTest((command) => {
        spawns.push(command)
        let closeListener: ((code: number | null) => void) | undefined
        const timer = setTimeout(() => closeListener?.(0), FAKE_PROBE_LATENCY_MS)
        pendingTimers.add(timer)
        return {
          stdout: {
            on: (_event: 'data', listener: (chunk: Buffer) => void): void => {
              listener(Buffer.from(`${command} 1.0.0\n`))
            },
          },
          stderr: null,
          onError: (): void => {},
          onClose: (listener: (code: number | null) => void): void => {
            closeListener = listener
          },
          kill: (): void => {
            pendingTimers.delete(timer)
            clearTimeout(timer)
          },
        }
      })
      clearHarnessDiscoveryCache()
      clearHarnessToolsCache()

      try {
        const inFlight = inspectHarnessEnvironment(root)
        clearHarnessToolsCache()
        await inFlight
        expect(spawns).toHaveLength(TOOL_PROBE_COUNT)

        // The pre-clear group did not republish itself, so the next call pays
        // for a second group instead of serving the stale record.
        await inspectHarnessEnvironment(root)
        expect(spawns).toHaveLength(TOOL_PROBE_COUNT * 2)
      } finally {
        for (const timer of pendingTimers) clearTimeout(timer)
        __setToolProbeSpawnForTest()
        clearHarnessDiscoveryCache()
        clearHarnessToolsCache()
      }
    },
    FILESYSTEM_DISCOVERY_TIMEOUT_MS,
  )

  test(
    'rejects a cancelled inspection with the signal reason',
    async () => {
      // The discovery walk, the manifest pre-reads and the collector probes all
      // thread the tool signal into the filesystem gate, and an already-aborted
      // call must not start any of that work.
      const root = tempRoot()
      fs.writeFileSync(path.join(root, 'package.json'), '{}')
      clearHarnessDiscoveryCache()
      const controller = new AbortController()
      const reason = new Error('cancelled by the aux gate')
      controller.abort(reason)

      await expect(
        inspectHarnessEnvironment(root, controller.signal),
      ).rejects.toBe(reason)
      await expect(
        getAffectedTestTargetsAsync(root, ['src/app.ts'], controller.signal),
      ).rejects.toBe(reason)
      await expect(
        getBuildTargetsAsync(root, ['src/app.ts'], controller.signal),
      ).rejects.toBe(reason)
      await expect(
        analyzeTestImpactAsync(root, ['src/app.ts'], {}, controller.signal),
      ).rejects.toBe(reason)
    },
    FILESYSTEM_DISCOVERY_TIMEOUT_MS,
  )

  test(
    'resolves workspace ownership exactly once per file in every collector',
    async () => {
      // Ownership runs once per file in each of the three collectors, on the aux
      // gate path where the file list is caller-supplied with no upper bound. A
      // `.filter(...).sort(...)` per call allocated two arrays per file, and the
      // affected-tests collector used to answer the same question twice for the
      // same normalized path. The resolution count is the fixed-workload
      // observable that pins one answer per file.
      const root = tempRoot()
      fs.mkdirSync(path.join(root, 'packages', 'api', 'src'), {
        recursive: true,
      })
      fs.writeFileSync(
        path.join(root, 'package.json'),
        JSON.stringify({ scripts: { test: 'bun test' } }),
      )
      fs.writeFileSync(
        path.join(root, 'packages', 'api', 'package.json'),
        JSON.stringify({ scripts: { test: 'bun test' } }),
      )
      const files = Array.from(
        { length: 40 },
        (_, index) => `packages/api/src/file-${index}.ts`,
      )

      const measure = async (run: () => Promise<unknown>): Promise<number> => {
        clearHarnessDiscoveryCache()
        __resetWorkspaceOwnershipResolutionCountForTest()
        await run()
        return __getWorkspaceOwnershipResolutionCountForTest()
      }

      const targetResolutions = await measure(() =>
        getAffectedTestTargetsAsync(root, files),
      )
      const impactResolutions = await measure(() =>
        analyzeTestImpactAsync(root, files),
      )
      const buildResolutions = await measure(() =>
        getBuildTargetsAsync(root, files),
      )

      // One resolution per file, never two for the same path.
      expect(targetResolutions).toBe(files.length)
      expect(impactResolutions).toBe(files.length)
      expect(buildResolutions).toBe(files.length)
    },
    FILESYSTEM_DISCOVERY_TIMEOUT_MS,
  )

  test(
    'off-loop build targets treat an unparseable manifest as unknown',
    async () => {
      const root = tempRoot()
      fs.writeFileSync(path.join(root, 'package.json'), '{not-json')
      const files = ['src/app.ts']

      const syncTargets = getBuildTargets(root, files)
      clearHarnessDiscoveryCache()
      const asyncTargets = await getBuildTargetsAsync(root, files)

      // Same verdict on both paths: no command is invented for a manifest the
      // off-loop read could not parse into a manager.
      expect(asyncTargets).toEqual(syncTargets)
      expect(asyncTargets).toEqual([
        expect.objectContaining({
          packageRoot: '.',
          manager: 'unknown',
          commands: [],
          confidence: 'unknown',
        }),
      ])
    },
    FILESYSTEM_DISCOVERY_TIMEOUT_MS,
  )

  test(
    'async discovery adopts the sync path record instead of walking twice',
    async () => {
      // The aux gate issues the sync consumers and inspect_environment for the
      // same root in one iteration. The in-flight async traversal must adopt a
      // record the sync path publishes while it is still pending, so a TTL miss
      // costs one tree walk — and the sync record must survive rather than be
      // clobbered by the async one.
      const root = tempRoot()
      fs.writeFileSync(
        path.join(root, 'package.json'),
        JSON.stringify({ scripts: { test: 'bun test' } }),
      )
      fs.writeFileSync(path.join(root, 'bun.lock'), '')

      // Writes the pending entry synchronously, then yields before walking.
      const pendingEnvironment = inspectHarnessEnvironment(root)
      expect(getBuildTargets(root, ['src/app.ts'])).toHaveLength(1)

      // Created AFTER the sync publish: the async path only reports
      // 'package.json' if it adopted the published record instead of walking.
      fs.mkdirSync(path.join(root, 'packages/api'), { recursive: true })
      fs.writeFileSync(
        path.join(root, 'packages/api/package.json'),
        JSON.stringify({ scripts: { test: 'bun test' } }),
      )

      const environment = await pendingEnvironment
      expect(environment.manifests).toEqual(['package.json'])
      // The sync record stayed in place, so the next async read is still cheap.
      expect((await inspectHarnessEnvironment(root)).manifests).toEqual([
        'package.json',
      ])
    },
    FILESYSTEM_DISCOVERY_TIMEOUT_MS,
  )

  test(
    'starts discovery and the tool probes together instead of serially',
    async () => {
      // The docblock claims a cache miss costs the max of the two phases instead
      // of their sum. Both must therefore START before either SETTLES; a change
      // that awaited them in turn would return identical results and keep every
      // other assertion green while restoring the summed latency.
      const root = tempRoot()
      fs.writeFileSync(path.join(root, 'package.json'), '{}')
      clearHarnessDiscoveryCache()
      clearHarnessToolsCache()
      __resetInspectPhaseEventsForTest()

      await inspectHarnessEnvironment(root)

      const events = __getInspectPhaseEventsForTest()
      const firstSettle = events.findIndex((entry) => entry.event === 'settle')
      const started = events
        .slice(0, firstSettle === -1 ? events.length : firstSettle)
        .filter((entry) => entry.event === 'start')
        .map((entry) => entry.phase)

      // Both phases had started before the first of them finished.
      expect(started).toEqual(['discovery', 'toolProbes'])
      expect(events.map((entry) => `${entry.phase}:${entry.event}`)).toEqual(
        expect.arrayContaining([
          'discovery:start',
          'toolProbes:start',
          'discovery:settle',
          'toolProbes:settle',
        ]),
      )
    },
    FILESYSTEM_DISCOVERY_TIMEOUT_MS,
  )

  test(
    'keeps the phase log bounded instead of retaining every inspection',
    async () => {
      // The aux gate calls inspect_environment on every iteration, so this log
      // must not grow with the session: it is test observability that stays
      // wired into the shipped path, and every reader truncates it first.
      const root = tempRoot()
      fs.writeFileSync(path.join(root, 'package.json'), '{}')
      clearHarnessDiscoveryCache()
      clearHarnessToolsCache()
      // Warm both caches so the repeated calls below are cheap; a call is
      // logged whether or not it hits a cache.
      await inspectHarnessEnvironment(root)
      __resetInspectPhaseEventsForTest()

      const calls = 8
      for (let index = 0; index < calls; index += 1) {
        await inspectHarnessEnvironment(root)
      }

      const events = __getInspectPhaseEventsForTest()
      const limit = 16
      // Four entries per call (a start and a settle per phase), so the window
      // always holds whole calls and the ordering assertion above still sees a
      // complete one — here the most recent call's.
      expect(events).toHaveLength(limit)
      const lastCall = events.slice(-4)
      const firstSettle = lastCall.findIndex(
        (entry) => entry.event === 'settle',
      )
      expect(lastCall.slice(0, firstSettle).map((entry) => entry.phase)).toEqual(
        ['discovery', 'toolProbes'],
      )
      // Retention is per retained call, not per inspection ever made.
      expect(
        events.filter(
          (entry) => entry.phase === 'discovery' && entry.event === 'start',
        ),
      ).toHaveLength(limit / 4)
    },
    FILESYSTEM_DISCOVERY_TIMEOUT_MS,
  )

  test('caches the tool probes behind a TTL reset seam', async () => {
    // The async --version probes must not re-run per inspect call.
    // Observable proof of the cache: consecutive inspections return the SAME
    // frozen tools record, and only clearHarnessToolsCache() drops it.
    const root = tempRoot()
    fs.writeFileSync(path.join(root, 'package.json'), '{}')
    const first = await inspectHarnessEnvironment(root)
    const second = await inspectHarnessEnvironment(root)
    expect(second.tools).toBe(first.tools)
    expect(Object.isFrozen(first.tools)).toBe(true)

    clearHarnessToolsCache()
    const third = await inspectHarnessEnvironment(root)
    expect(third.tools).not.toBe(first.tools)
    // The probes stay honest: git is really installed in this environment,
    // and the probe records the version it actually observed (no fabricated
    // availability, and the version string is not invented).
    expect(first.tools.git?.available).toBe(true)
    expect(typeof first.tools.git?.version).toBe('string')
    expect((first.tools.git?.version ?? '').length).toBeGreaterThan(0)
    expect(third.tools.git).toMatchObject({ available: true })
  })

  test(
    'runs all 14 tool probes concurrently and reuses the shared TTL slot',
    async () => {
      const root = tempRoot()
      const spawns: string[] = []
      const pendingTimers = new Set<ReturnType<typeof setTimeout>>()
      let inFlight = 0
      let maxInFlight = 0

      __setToolProbeSpawnForTest((command) => {
        spawns.push(command)
        inFlight += 1
        maxInFlight = Math.max(maxInFlight, inFlight)
        let closeListener: ((code: number | null) => void) | undefined
        const timer = setTimeout(() => {
          inFlight -= 1
          closeListener?.(0)
        }, FAKE_PROBE_LATENCY_MS)
        pendingTimers.add(timer)
        return {
          stdout: {
            on: (_event: 'data', listener: (chunk: Buffer) => void): void => {
              listener(Buffer.from(`${command} 1.0.0\n`))
            },
          },
          stderr: null,
          onError: (): void => {},
          onClose: (listener: (code: number | null) => void): void => {
            closeListener = listener
          },
          kill: (): void => {
            pendingTimers.delete(timer)
            clearTimeout(timer)
          },
        }
      })
      clearHarnessToolsCache()

      try {
        const startedAt = Date.now()
        const first = await inspectHarnessEnvironment(root)
        const elapsed = Date.now() - startedAt

        // Every probe spawned, and all 14 were in flight simultaneously.
        expect(spawns).toHaveLength(TOOL_PROBE_COUNT)
        expect(maxInFlight).toBe(TOOL_PROBE_COUNT)
        // One probe latency, not the sum of 14 serial spawns. The bound is
        // pinned to the fake latency rather than the probe timeout: a 3,000ms
        // budget would still pass a partial serialization (three at a time is
        // ~2.0s, six at a time ~1.2s), leaving only the maxInFlight assertion
        // to catch it. Two fake latencies allows scheduling slop while failing
        // any grouping that cannot fit in roughly one round trip.
        expect(elapsed).toBeLessThan(FAKE_PROBE_LATENCY_MS * 2)
        // Probe contract unchanged: only the first output line is recorded.
        expect(first.tools.git).toEqual({
          available: true,
          version: 'git 1.0.0',
        })

        // The SAME module-level TTL slot serves the next inspection, so the
        // probes are not respawned inside the window.
        const second = await inspectHarnessEnvironment(root)
        expect(second.tools).toBe(first.tools)
        expect(spawns).toHaveLength(TOOL_PROBE_COUNT)
      } finally {
        for (const timer of pendingTimers) clearTimeout(timer)
        __setToolProbeSpawnForTest()
      }
    },
    FILESYSTEM_DISCOVERY_TIMEOUT_MS,
  )

  test(
    'shares one in-flight probe group across concurrent inspections',
    async () => {
      const root = tempRoot()
      const spawns: string[] = []
      const pendingTimers = new Set<ReturnType<typeof setTimeout>>()

      __setToolProbeSpawnForTest((command) => {
        spawns.push(command)
        let closeListener: ((code: number | null) => void) | undefined
        const timer = setTimeout(() => closeListener?.(0), FAKE_PROBE_LATENCY_MS)
        pendingTimers.add(timer)
        return {
          stdout: {
            on: (_event: 'data', listener: (chunk: Buffer) => void): void => {
              listener(Buffer.from(`${command} 1.0.0\n`))
            },
          },
          stderr: null,
          onError: (): void => {},
          onClose: (listener: (code: number | null) => void): void => {
            closeListener = listener
          },
          kill: (): void => {
            pendingTimers.delete(timer)
            clearTimeout(timer)
          },
        }
      })
      clearHarnessToolsCache()

      try {
        // Three callers overlap inside the probe window. Only the first may
        // spawn; the others share the pending group instead of each spawning
        // its own 14 children, which is exactly what the sync version avoided
        // by serialising callers on the event loop.
        const inspections = await Promise.all([
          inspectHarnessEnvironment(root),
          inspectHarnessEnvironment(root),
          inspectHarnessEnvironment(root),
        ])

        expect(spawns).toHaveLength(TOOL_PROBE_COUNT)
        // All three callers observe the SAME frozen record from that one group.
        expect(inspections[1]!.tools).toBe(inspections[0]!.tools)
        expect(inspections[2]!.tools).toBe(inspections[0]!.tools)

        // Once the group settles the slot holds the resolved entry, so a later
        // caller still spawns nothing.
        const later = await inspectHarnessEnvironment(root)
        expect(later.tools).toBe(inspections[0]!.tools)
        expect(spawns).toHaveLength(TOOL_PROBE_COUNT)
      } finally {
        for (const timer of pendingTimers) clearTimeout(timer)
        __setToolProbeSpawnForTest()
      }
    },
    FILESYSTEM_DISCOVERY_TIMEOUT_MS,
  )

  test(
    'an aborting first caller does not poison the shared tools cache',
    async () => {
      // The caller that STARTED the probe group used to have its signal baked
      // into the shared 14-probe group: aborting it mid-flight settled every
      // probe { available: false }, the group resolved, and that fabricated
      // all-unavailable record was published into the 60s TTL slot for every
      // later caller. The group must run un-signalled: a cancelling caller
      // only stops waiting (rejecting with its own reason), and an
      // abort-settled group is never published.
      const root = tempRoot()
      fs.writeFileSync(path.join(root, 'package.json'), '{}')
      const spawns: string[] = []
      const pendingTimers = new Set<ReturnType<typeof setTimeout>>()

      __setToolProbeSpawnForTest((command) => {
        spawns.push(command)
        let closeListener: ((code: number | null) => void) | undefined
        const timer = setTimeout(() => closeListener?.(0), FAKE_PROBE_LATENCY_MS)
        pendingTimers.add(timer)
        return {
          stdout: {
            on: (_event: 'data', listener: (chunk: Buffer) => void): void => {
              listener(Buffer.from(`${command} 9.9.9\n`))
            },
          },
          stderr: null,
          onError: (): void => {},
          onClose: (listener: (code: number | null) => void): void => {
            closeListener = listener
          },
          kill: (): void => {
            pendingTimers.delete(timer)
            clearTimeout(timer)
          },
        }
      })
      clearHarnessDiscoveryCache()
      clearHarnessToolsCache()

      try {
        const controller = new AbortController()
        const reason = new Error('cancelled by the aux gate')
        const first = inspectHarnessEnvironment(root, controller.signal)
        // Abort while the shared probe group is still mid-flight (the fake
        // probes report after FAKE_PROBE_LATENCY_MS, far later than this).
        setTimeout(() => controller.abort(reason), 50)

        // The cancelling caller itself rejects with its own reason instead of
        // resolving with the all-unavailable record its abort fabricated.
        await expect(first).rejects.toBe(reason)

        // A later caller observes REAL probe results: neither the poisoned
        // cached record nor a mid-flight join on a dead group. Every probe
        // answered with the fake version, so every tool must be available.
        const second = await inspectHarnessEnvironment(root)
        expect(second.tools.git).toEqual({ available: true, version: 'git 9.9.9' })
        expect(
          Object.values(second.tools).every((tool) => tool.available),
        ).toBe(true)
      } finally {
        for (const timer of pendingTimers) clearTimeout(timer)
        __setToolProbeSpawnForTest()
      }
    },
    FILESYSTEM_DISCOVERY_TIMEOUT_MS,
  )

  test('cargo test -p uses the Cargo.toml package name, not the directory name', () => {
    // `cargo test -p <dir-basename>` was bogus: -p takes the crate's package
    // id, which lives in Cargo.toml and can differ from the directory name.
    const root = tempRoot()
    fs.mkdirSync(path.join(root, 'crates', 'core'), { recursive: true })
    fs.writeFileSync(
      path.join(root, 'crates', 'core', 'Cargo.toml'),
      '[package]\nname = "core-crate"\n',
    )
    const [impact] = analyzeTestImpact(root, ['crates/core/src/lib.rs'])
    expect(impact.tiers.buildTool).toEqual(['cargo test -p core-crate'])
  })

  test('omits -p when the Cargo.toml package name is unparseable', () => {
    const root = tempRoot()
    fs.mkdirSync(path.join(root, 'crates', 'broken'), { recursive: true })
    fs.writeFileSync(path.join(root, 'crates', 'broken', 'Cargo.toml'), 'nope')
    const [impact] = analyzeTestImpact(root, ['crates/broken/src/lib.rs'])
    expect(impact.tiers.buildTool).toEqual(['cargo test'])
  })

  test('unknown-manager workspaces emit no build-tool command instead of junk', () => {
    // `unknown run <script>` is not a runnable command; an ecosystem whose
    // manager could not be identified yields no build-tool query at all.
    const root = tempRoot()
    fs.writeFileSync(path.join(root, 'package.json'), '{not-json')
    const [impact] = analyzeTestImpact(root, ['src/app.ts'])
    expect(impact.tiers.buildTool).toEqual([])
    expect(impact.candidates).toEqual([])
  })

  test(
    'discovers nested multi-language workspaces and manager-specific targets',
    async () => {
      const root = tempRoot()
      fs.mkdirSync(path.join(root, 'apps/web/src'), { recursive: true })
      fs.writeFileSync(
        path.join(root, 'apps/web/package.json'),
        JSON.stringify({ scripts: { test: 'vitest', build: 'vite build' } }),
      )
      // Nested JS packages inherit the nearest ancestor manager lockfile.
      fs.writeFileSync(path.join(root, 'pnpm-lock.yaml'), '')
      fs.mkdirSync(path.join(root, 'crates/core/src'), { recursive: true })
      fs.writeFileSync(
        path.join(root, 'crates/core/Cargo.toml'),
        '[package]\nname="core"',
      )
      fs.mkdirSync(path.join(root, 'services/api'), { recursive: true })
      fs.writeFileSync(
        path.join(root, 'services/api/pyproject.toml'),
        '[project]\nname="api"',
      )
      fs.writeFileSync(path.join(root, 'services/api/uv.lock'), '')

      const environment = await inspectHarnessEnvironment(root)
      expect(environment.manifests).toEqual([
        'apps/web/package.json',
        'crates/core/Cargo.toml',
        'services/api/pyproject.toml',
      ])
      expect(
        environment.workspaces.map(({ root, manager, confidence }) => ({
          root,
          manager,
          confidence,
        })),
      ).toEqual([
        { root: 'apps/web', manager: 'pnpm', confidence: 'confirmed' },
        { root: 'crates/core', manager: 'cargo', confidence: 'confirmed' },
        { root: 'services/api', manager: 'uv', confidence: 'confirmed' },
      ])
      expect(
        getBuildTargets(root, [
          'apps/web/src/app.ts',
          'crates/core/src/lib.rs',
          'services/api/main.py',
        ]),
      ).toEqual([
        expect.objectContaining({
          manager: 'pnpm',
          commands: ['pnpm run test', 'pnpm run build'],
          confidence: 'confirmed',
        }),
        expect.objectContaining({
          manager: 'cargo',
          commands: [
            'cargo check',
            'cargo test',
            'cargo clippy',
            'cargo build',
          ],
          confidence: 'inferred',
        }),
        expect.objectContaining({
          manager: 'uv',
          commands: ['uv run pytest', 'uv run ruff check .', 'uv build'],
          confidence: 'inferred',
        }),
      ])
    },
    FILESYSTEM_DISCOVERY_TIMEOUT_MS,
  )

  test(
    'infers Go workspaces from go.mod and reports go test/build targets',
    async () => {
      // go.mod/go.sum stay in the discovery lists, so a Go repo must resolve a
      // real workspace (ecosystem/manager 'go'). Losing the inference made
      // every Go repo report 'unknown' and silently dropped go test/vet/build
      // from get_build_targets and the build-tool tier.
      const root = tempRoot()
      fs.mkdirSync(path.join(root, 'svc', 'api'), { recursive: true })
      fs.writeFileSync(path.join(root, 'go.mod'), 'module example.com/demo\n')
      fs.writeFileSync(path.join(root, 'go.sum'), '')
      fs.writeFileSync(path.join(root, 'svc', 'api', 'main.go'), 'package main\n')
      fs.writeFileSync(
        path.join(root, 'svc', 'api', 'main_test.go'),
        'package main\n',
      )

      const environment = await inspectHarnessEnvironment(root)
      expect(environment.workspaces).toEqual([
        expect.objectContaining({
          root: '.',
          ecosystem: 'go',
          manager: 'go',
          manifest: 'go.mod',
          lockfile: 'go.sum',
          confidence: 'confirmed',
        }),
      ])

      // The same go workspace drives the async build-target tool.
      expect(
        await getBuildTargetsAsync(root, ['svc/api/main.go']),
      ).toEqual([
        expect.objectContaining({
          packageRoot: '.',
          manager: 'go',
          commands: ['go test ./...', 'go vet ./...', 'go build ./...'],
          confidence: 'inferred',
        }),
      ])

      // ...and the build-tool tier emits the directory-scoped go test command.
      const [impact] = await analyzeTestImpactAsync(root, ['svc/api/main.go'])
      expect(impact.tiers.buildTool).toEqual(['go test ./svc/api'])
    },
    FILESYSTEM_DISCOVERY_TIMEOUT_MS,
  )

  test('marks unparseable workspace targets as unknown instead of guessing', () => {
    const root = tempRoot()
    fs.mkdirSync(path.join(root, 'broken'), { recursive: true })
    fs.writeFileSync(path.join(root, 'broken/package.json'), '{not-json')
    expect(getBuildTargets(root, ['broken/src.ts'])).toEqual([
      expect.objectContaining({
        packageRoot: 'broken',
        manager: 'unknown',
        commands: [],
        confidence: 'unknown',
      }),
    ])
  })

  test(
    'reuses the per-cwd workspace discovery walk across calls until cleared',
    async () => {
      // The aux gate calls inspect_environment + get_affected_tests +
      // get_build_targets per iteration; each one used to redo the full-tree
      // walk. Observable proof of the cache: a workspace created AFTER the
      // first discovery is not reported until the cache is cleared.
      const root = tempRoot()
      fs.writeFileSync(
        path.join(root, 'package.json'),
        JSON.stringify({ scripts: { test: 'bun test' } }),
      )
      fs.writeFileSync(path.join(root, 'bun.lock'), '')
      expect(
        getBuildTargets(root, ['src/app.ts']).map(
          (target) => target.packageRoot,
        ),
      ).toEqual(['.'])

      fs.mkdirSync(path.join(root, 'packages/api/src'), { recursive: true })
      fs.writeFileSync(
        path.join(root, 'packages/api/package.json'),
        JSON.stringify({ scripts: { test: 'bun test' } }),
      )
      // Cached discovery: the new nested manifest is not visible yet, so the
      // nested source still routes to the root workspace.
      expect(
        getBuildTargets(root, ['packages/api/src/user.ts']).map(
          (target) => target.packageRoot,
        ),
      ).toEqual(['.'])

      clearHarnessDiscoveryCache()
      expect(
        getBuildTargets(root, ['packages/api/src/user.ts']).map(
          (target) => target.packageRoot,
        ),
      ).toEqual(['packages/api'])
      // inspect_environment shares the same cache entry, so it sees the
      // re-discovered manifests too.
      expect((await inspectHarnessEnvironment(root)).manifests).toEqual([
        'package.json',
        'packages/api/package.json',
      ])
    },
    FILESYSTEM_DISCOVERY_TIMEOUT_MS,
  )

  test('rejects traversal, absolute, and symlink-escaping source paths', () => {
    const root = tempRoot()
    const outside = tempRoot()
    fs.writeFileSync(
      path.join(outside, 'package.json'),
      JSON.stringify({ scripts: { test: 'outside test' } }),
    )
    fs.symlinkSync(outside, path.join(root, 'outside-link'))

    const unsafe = [
      '../package.json',
      path.join(outside, 'source.ts'),
      'outside-link/source.ts',
    ]
    expect(getAffectedTestTargets(root, unsafe)).toEqual([])
    expect(getBuildTargets(root, unsafe)).toEqual([])
  })

  test(
    'rejects owned-temp absolute sources even when a root workspace matches',
    () => {
      const root = tempRoot()
      fs.writeFileSync(
        path.join(root, 'package.json'),
        JSON.stringify({ scripts: { test: 'bun test' } }),
      )
      // Sanity check: the fixture really does discover a '.' workspace, so the
      // rejection below is load-bearing rather than vacuous.
      expect(getBuildTargets(root, ['src/app.ts'])).toEqual([
        expect.objectContaining({ packageRoot: '.', scripts: ['test'] }),
      ])

      // Named from `getOwnedTempRoots()[0]` instead of a literal `/tmp` because
      // on macOS the OS temp dir is a symlinked `/var/folders/...` path, and
      // spelled out here rather than via `tempRoot()` so the owned-temp shape is
      // explicit. Without the `scope === 'project'` gate this absolute path
      // would match the `'.'` workspace and emit a bogus target.
      const ownedTempSource = path.join(
        getOwnedTempRoots()[0],
        `openbuff-build-targets-${process.pid}`,
        'source.ts',
      )
      expect(getBuildTargets(root, [ownedTempSource])).toEqual([])
      expect(getAffectedTestTargets(root, [ownedTempSource])).toEqual([])
    },
    FILESYSTEM_DISCOVERY_TIMEOUT_MS,
  )

  test('context packets are content-addressed', () => {
    const input = {
      objective: 'fix auth',
      acceptanceCriteria: ['sign-in works'],
      items: [
        {
          path: 'src/auth.ts',
          symbols: ['signIn'],
          reason: 'direct implementation',
          confidence: 'confirmed' as const,
        },
      ],
      excluded: ['docs/'],
    }
    expect(createContextPacket(input).id).toBe(createContextPacket(input).id)
  })

  test('knowledge expires and workspace leases enforce ownership', () => {
    const store = new LocalHarnessStore(tempRoot())
    const knowledge = new VerifiedKnowledgeService(store)
    knowledge.record({
      repositoryId: 'repo',
      workspaceId: 'workspace',
      runId: 'run',
      snapshotId: 'snapshot',
      statement: 'Use bun',
      source: 'AGENTS.md',
      sourceHash: 'hash',
      verifiedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })
    expect(knowledge.listFresh('repo')).toHaveLength(1)

    const leases = new WorkspaceLeaseService(store)
    const lease = leases.acquire({
      repositoryId: 'repo',
      workspaceId: 'workspace',
      runId: 'run',
      snapshotId: 'snapshot',
      taskId: 'task',
      path: '/tmp/workspace',
    })
    expect(() =>
      leases.acquire({
        repositoryId: 'repo',
        workspaceId: 'workspace',
        runId: 'other',
        snapshotId: 'snapshot',
        taskId: 'task-2',
        path: '/tmp/workspace',
      }),
    ).toThrow('already leased')
    expect(leases.release('repo', lease.id, lease.ownershipToken).status).toBe(
      'released',
    )
  })

  test('renews, releases, and reacquires leases with unique generations', () => {
    let now = 1_000
    const leases = new WorkspaceLeaseService(
      new LocalHarnessStore(tempRoot()),
      { now: () => now, leaseDurationMs: 100 },
    )
    const first = leases.acquire({
      repositoryId: 'repo',
      workspaceId: 'workspace',
      runId: 'run-1',
      snapshotId: 'snapshot-1',
      taskId: 'task-1',
      path: '/tmp/workspace',
    })
    expect(first).toMatchObject({ generation: 1, status: 'active' })

    now = 1_050
    const renewed = leases.heartbeat('repo', first.id, first.ownershipToken)
    expect(Date.parse(renewed.expiresAt)).toBe(1_150)
    expect(() => leases.renew('repo', first.id, 'wrong-token')).toThrow(
      'ownership token',
    )
    const released = leases.release('repo', renewed.id, renewed.ownershipToken)
    expect(released.status).toBe('released')

    const second = leases.acquire({
      repositoryId: 'repo',
      workspaceId: 'workspace',
      runId: 'run-2',
      snapshotId: 'snapshot-2',
      taskId: 'task-2',
      path: '/tmp/workspace',
    })
    expect(second.generation).toBe(2)
    expect(second.ownershipToken).not.toBe(first.ownershipToken)
    expect(second.revision).toBe(released.revision + 1)
  })

  test('expires, reclaims, and reacquires abandoned leases', () => {
    let now = 2_000
    const leases = new WorkspaceLeaseService(
      new LocalHarnessStore(tempRoot()),
      { now: () => now, leaseDurationMs: 100 },
    )
    const first = leases.acquire({
      repositoryId: 'repo',
      workspaceId: 'workspace',
      runId: 'run-1',
      snapshotId: 'snapshot-1',
      taskId: 'task-1',
      path: '/tmp/workspace',
    })
    now = 2_101
    expect(() => leases.renew('repo', first.id, first.ownershipToken)).toThrow(
      'expired',
    )
    expect(leases.reclaimExpired('repo')).toMatchObject([
      { id: first.id, generation: 1, status: 'abandoned' },
    ])

    const second = leases.acquire({
      repositoryId: 'repo',
      workspaceId: 'workspace',
      runId: 'run-2',
      snapshotId: 'snapshot-2',
      taskId: 'task-2',
      path: '/tmp/workspace',
    })
    expect(second).toMatchObject({ generation: 2, status: 'active' })
  })

  test(
    'serializes conflicting workspace acquisition across processes',
    async () => {
      const root = tempRoot()
      const gate = path.join(root, 'gate')
      const servicePath = path.resolve(
        import.meta.dir,
        '..',
        'services',
        'harness-intelligence.ts',
      )
      const storePath = path.resolve(
        import.meta.dir,
        '..',
        'services',
        'local-harness-store.ts',
      )

      const startChild = (name: string) => {
        const ready = path.join(root, `ready-${name}`)
        const code = `
        import fs from 'node:fs';
        import { WorkspaceLeaseService } from ${JSON.stringify(servicePath)};
        import { LocalHarnessStore } from ${JSON.stringify(storePath)};
        const leases = new WorkspaceLeaseService(new LocalHarnessStore(${JSON.stringify(root)}));
        fs.writeFileSync(${JSON.stringify(ready)}, 'ready');
        const wait = new Int32Array(new SharedArrayBuffer(4));
        while (!fs.existsSync(${JSON.stringify(gate)})) Atomics.wait(wait, 0, 0, 5);
        try {
          leases.acquire({
            repositoryId: 'repo',
            workspaceId: ${JSON.stringify(`workspace-${name}`)},
            runId: ${JSON.stringify(`run-${name}`)},
            snapshotId: 'snapshot',
            taskId: ${JSON.stringify(`task-${name}`)},
            path: '/tmp/shared-workspace',
          });
          console.log('ok');
        } catch (error) {
          console.log(error instanceof Error ? error.message : String(error));
        }
      `
        const child = spawn(process.execPath, ['-e', code], {
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        let stdout = ''
        let stderr = ''
        child.stdout.on('data', (chunk) => (stdout += String(chunk)))
        child.stderr.on('data', (chunk) => (stderr += String(chunk)))
        const completed = new Promise<string>((resolve, reject) => {
          child.on('error', reject)
          child.on('close', (exitCode) => {
            if (exitCode === 0) resolve(stdout.trim())
            else reject(new Error(stderr || `child exited ${exitCode}`))
          })
        })
        return { ready, completed }
      }

      const first = startChild('first')
      const second = startChild('second')
      const wait = new Int32Array(new SharedArrayBuffer(4))
      const deadline = Date.now() + CROSS_PROCESS_READY_TIMEOUT_MS
      while (
        (!fs.existsSync(first.ready) || !fs.existsSync(second.ready)) &&
        Date.now() < deadline
      ) {
        Atomics.wait(wait, 0, 0, 5)
      }
      expect(fs.existsSync(first.ready)).toBe(true)
      expect(fs.existsSync(second.ready)).toBe(true)
      fs.writeFileSync(gate, 'go')

      const outcomes = await Promise.all([first.completed, second.completed])
      expect(outcomes.filter((outcome) => outcome === 'ok')).toHaveLength(1)
      expect(
        outcomes.filter((outcome) => outcome.includes('already leased')),
      ).toHaveLength(1)
    },
    CROSS_PROCESS_TIMEOUT_MS,
  )

  test('external connector mutations require approval', () => {
    expect(
      classifyConnectorOperation({ connector: 'github', operation: 'get_pr' }),
    ).toEqual({ kind: 'read', approvalRequired: false })
    expect(
      classifyConnectorOperation({
        connector: 'github',
        operation: 'merge_pr',
      }),
    ).toEqual({ kind: 'mutation', approvalRequired: true })
  })
})

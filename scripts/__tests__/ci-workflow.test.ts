import { describe, expect, test, afterEach } from 'bun:test'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const repoRoot = join(import.meta.dir, '..', '..')

const CI_WORKFLOW = readFileSync(
  join(repoRoot, '.github', 'workflows', 'ci.yml'),
  'utf8',
)

/** The exact per-package test discovery command from the CI workflow. */
const CI_FIND_COMMAND =
  "find . \\( -path ./node_modules -o -path ./.git -o -path ./dist \\) -prune -o -type f \\( -name '*.test.ts' -o -name '*.test.tsx' \\) ! -name '*.integration.test.ts' -print"

let tmpRoot: string

afterEach(() => {
  if (tmpRoot && existsSync(tmpRoot)) {
    rmSync(tmpRoot, { recursive: true, force: true })
  }
})

describe('CI test-job truth (M4-T3)', () => {
  test('test discovery scans the whole package, not just src/ (M1-T6 holds)', () => {
    // Regression guard for the audit's vacuous-green finding: the command must
    // not regress to `find src`, which found zero files in scripts/.
    expect(CI_WORKFLOW).not.toContain('find src')
    expect(CI_WORKFLOW).toContain(CI_FIND_COMMAND)
  })

  test('CI find glob positively enumerates the scripts suites', () => {
    // Prove the glob actually collects scripts/__tests__/*.test.ts — the
    // acceptance criterion for the M1-T6 fix.
    const result = spawnSync('bash', ['-c', CI_FIND_COMMAND], {
      cwd: join(repoRoot, 'scripts'),
      encoding: 'utf8',
    })
    expect(result.status).toBe(0)
    const files = result.stdout.split('\n').filter(Boolean)
    expect(files.length).toBeGreaterThan(0)
    expect(
      files.some(
        (file) => file.startsWith('./__tests__/') && file.endsWith('.test.ts'),
      ),
    ).toBe(true)
  })

  test('a deliberately broken scripts test fails bun test (CI would go red)', () => {
    // With the glob fixed, an empty/disabled suite can no longer pass; this
    // proves a real failing test in scripts/ propagates a non-zero exit —
    // i.e. the CI job runs the files it discovers rather than skipping them.
    tmpRoot = mkdtempSync(join(tmpdir(), 'ci-truth-'))
    const brokenTest = join(tmpRoot, 'deliberately-broken.test.ts')
    writeFileSync(
      brokenTest,
      "import { expect, test } from 'bun:test'\n\ntest('deliberately broken', () => {\n  expect(1).toBe(2)\n})\n",
      'utf8',
    )
    const result = spawnSync('bun', ['test', '--isolate', brokenTest], {
      cwd: join(repoRoot, 'scripts'),
      encoding: 'utf8',
    })
    expect(result.status).not.toBe(0)
  })

  test('empty test-discovery result fails the job instead of passing', () => {
    // The old empty branch echoed "No tests found" and exited 0 (vacuous
    // green). It must exit 1 now.
    expect(CI_WORKFLOW).toMatch(/No tests found in .+\n[^`]*exit 1/s)
  })
})

describe('CI gate-helpers drift gate (M4-T3)', () => {
  test('build-and-check runs generate-gate-helpers --check on the tracked region', () => {
    expect(CI_WORKFLOW).toContain(
      'bun run scripts/generate-gate-helpers.ts --check agents/base2/base2.ts',
    )
    expect(CI_WORKFLOW).toContain('Check generated gate helpers are current')
  })

  test('--check exits 0 for the tracked region (the command CI runs)', () => {
    const result = spawnSync(
      'bun',
      [
        'run',
        'scripts/generate-gate-helpers.ts',
        '--check',
        'agents/base2/base2.ts',
      ],
      { cwd: repoRoot, encoding: 'utf8' },
    )
    expect(result.status).toBe(0)
  })

  test('--check exits 1 when the marker region drifted', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'gate-helpers-check-'))
    const staleTarget = join(tmpRoot, 'base2.ts')
    writeFileSync(
      staleTarget,
      [
        '// <gate-helpers-generated> DO NOT EDIT — regenerate via: bun run scripts/generate-gate-helpers.ts',
        'function driftedHelper() {\n  return 1\n}',
        '// </gate-helpers-generated>',
        '',
      ].join('\n'),
      'utf8',
    )
    const result = spawnSync(
      'bun',
      ['run', 'scripts/generate-gate-helpers.ts', '--check', staleTarget],
      { cwd: repoRoot, encoding: 'utf8' },
    )
    expect(result.status).toBe(1)
  })

  test('--check exits 1 when markers are missing or a path is required', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'gate-helpers-check-'))
    const noMarkers = join(tmpRoot, 'no-markers.ts')
    writeFileSync(noMarkers, 'export const x = 1\n', 'utf8')
    const missing = spawnSync(
      'bun',
      ['run', 'scripts/generate-gate-helpers.ts', '--check', noMarkers],
      { cwd: repoRoot, encoding: 'utf8' },
    )
    expect(missing.status).toBe(1)

    const noPath = spawnSync(
      'bun',
      ['run', 'scripts/generate-gate-helpers.ts', '--check'],
      { cwd: repoRoot, encoding: 'utf8' },
    )
    expect(noPath.status).toBe(1)
  })
})

describe('CI project-root guard gate', () => {
  test('build-and-check runs the project-root guard', () => {
    // The guard tripwire must run in an automated gate, not only exist as a
    // `guard:project-root` script in scripts/package.json.
    const ciLines = CI_WORKFLOW.split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
    expect(ciLines).toContain('bun --cwd=scripts run guard:project-root')
  })

  test('build-and-check runs the byok-wording guard', () => {
    const ciLines = CI_WORKFLOW.split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
    expect(ciLines).toContain('bun --cwd=scripts run guard:byok-wording')
  })

  test('build-and-check runs the dependency-provenance guard', () => {
    // Provenance reconciliation is only a real gate if CI runs it; a guard
    // that exists solely as a `guard:dependency-provenance` script in
    // scripts/package.json never blocks a merge.
    const ciLines = CI_WORKFLOW.split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
    expect(ciLines).toContain(
      'bun --cwd=scripts run guard:dependency-provenance',
    )
  })

  test('build-and-check runs the types-declaration guard', () => {
    // The co-declaration invariant (an untyped runtime dependency must declare
    // its @types sibling in the same manifest) only blocks a merge if CI runs
    // it; a lone `guard:types-declaration` script in scripts/package.json
    // never fails a build. Invoked through the script like its sibling guards,
    // so the guard's own package manifest stays the single source of the
    // command.
    expect(CI_WORKFLOW).toContain(
      'run: bun --cwd=scripts run guard:types-declaration',
    )
  })

  test('build-and-check fails an unreviewed provenance-record diff', () => {
    // The offline gate proves the record agrees with bun.lock, not that either
    // matches upstream, so the reviewed record diff is the independent anchor.
    // The comparison MUST name a base ref: after the shallow checkout the
    // working tree equals HEAD, so a plain `git diff HEAD` is always empty —
    // the no-op form of this anchor. The step therefore fetches the base
    // (PR base branch, or the pushed commit's parent) and diffs by
    // name-status: a pure ADDITION (the PR that first lands the record, which
    // is itself its review) passes, any modification or deletion fails.
    const ciLines = CI_WORKFLOW.split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
    expect(ciLines).toContain(
      'changes=$(git diff --name-status "$base" HEAD -- scripts/dependency-provenance.json)',
    )
    expect(ciLines).toContain(`if echo "$changes" | grep -qv '^A'; then`)
    expect(ciLines).toContain(
      'git fetch --no-tags --depth=1 origin "${{ github.base_ref }}"',
    )
    expect(ciLines).toContain('git fetch --no-tags --deepen=1 origin')
  })
})

describe('CI flake ledger wiring (M4-T3)', () => {
  test('retry step records total_attempts into the checked-in ledger', () => {
    expect(CI_WORKFLOW).toContain('id: tests')
    expect(CI_WORKFLOW).toContain('steps.tests.outputs.total_attempts')
    expect(CI_WORKFLOW).toContain('scripts/flake-ledger.json')
  })
})

describe('CI bun toolchain alignment', () => {
  test('setup-bun installs the version engines/packageManager declare', () => {
    // The reproducibility fields promise the toolchain CI executes; the
    // provenance and declaration guards are only valid when both agree.
    // Every manifest declaring a bun engine must declare the CI toolchain;
    // only the root also carries the `packageManager` corepack-style field.
    const manifests = ['package.json', 'cli/package.json', 'scripts/package.json']
    for (const manifest of manifests) {
      const parsed = JSON.parse(readFileSync(join(repoRoot, manifest), 'utf8')) as {
        engines?: { bun?: string }
        packageManager?: string
      }
      expect(parsed.engines?.bun).toBe('1.3.5')
      if (parsed.packageManager !== undefined) {
        expect(manifest).toBe('package.json')
        expect(parsed.packageManager).toBe('bun@1.3.5')
      }
    }

    // Every setup-bun step in the workflow must pin the declared toolchain.
    const ciVersions = [...CI_WORKFLOW.matchAll(/bun-version:\s*'([^']+)'/g)].map(
      (match) => match[1]!,
    )
    expect(ciVersions.length).toBeGreaterThan(0)
    expect(new Set(ciVersions)).toEqual(new Set(['1.3.5']))
  })
})

describe('CI sdk dist build gating', () => {
  test('sdk dist is built only for the cli matrix entries, not every package', () => {
    // CLI tests import @openbuff/sdk through the ESM import condition, which
    // resolves the dist bundle; every other package job must skip the sdk
    // build instead of paying its cost across the whole matrix.
    const lines = CI_WORKFLOW.split('\n')
    const buildIndexes = lines
      .map((line, index) =>
        line.trim() === 'run: cd sdk && bun run build' ? index : -1,
      )
      .filter((index) => index !== -1)
    // Exactly one gated build per test job: `test` and `test-integration`.
    expect(buildIndexes.length).toBe(2)
    for (const index of buildIndexes) {
      const stepLines = lines.slice(index - 2, index)
      expect(
        stepLines.some((line) => line.trim() === "if: matrix.package == 'cli'"),
      ).toBe(true)
      expect(
        stepLines.some((line) =>
          line.includes(
            'Build sdk dist (cli tests import @openbuff/sdk through the ESM import condition)',
          ),
        ),
      ).toBe(true)
    }
  })
})

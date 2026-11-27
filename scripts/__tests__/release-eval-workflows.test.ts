/**
 * Structural guards for the N09 release packaging and N10 eval gate
 * workflows. These read the workflow YAML as text: they pin the wiring the
 * product audit found broken (no .scm in tarballs, nightly on a nonexistent
 * agent with no artifact or baseline, code-map missing from the CI matrix).
 */
import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'

const repoRoot = join(import.meta.dir, '..', '..')
const workflowsDir = join(repoRoot, '.github', 'workflows')
const read = (name: string) => readFileSync(join(workflowsDir, name), 'utf8')

/** Text of one `- name: <step>` block, up to the next step. */
function stepBlocks(workflow: string, name: string): string[] {
  const parts = workflow.split(/\n(?=\s+- name: )/)
  return parts.filter((part) => part.trim().startsWith(`- name: ${name}`))
}

describe('CI test matrix', () => {
  test('lists packages/code-map and every package with tests', () => {
    const ci = read('ci.yml')
    const matrix = ci.match(/package:\s*\n\s*\[([^\]]+)\]/)?.[1] ?? ''
    const entries = matrix
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
    expect(entries).toContain('packages/code-map')
    for (const dir of readdirSync(join(repoRoot, 'packages'))) {
      const pkgDir = join(repoRoot, 'packages', dir)
      const hasTests =
        spawnSync(
          'bash',
          [
            '-c',
            "find . -path ./node_modules -prune -o -name '*.test.ts' -print | head -1",
          ],
          {
            cwd: pkgDir,
            encoding: 'utf8',
          },
        ).stdout.trim() !== ''
      if (hasTests) expect(entries).toContain(`packages/${dir}`)
    }
  })
})

describe('release tarball (N09)', () => {
  const release = read('cli-release-build.yml')

  test('every tarball step uses the shared file list and checks the query count', () => {
    const steps = stepBlocks(release, 'Create tarball')
    expect(steps).toHaveLength(2)
    for (const step of steps) {
      expect(step).toContain('cli/scripts/release-tarball-files.sh')
      expect(step).toContain('tree-sitter-queries/')
      expect(step).toContain('test "$QUERY_COUNT" -eq "$EXPECTED"')
    }
  })

  test('smoke steps run the extracted tarball, after it is created', () => {
    const smokes = [
      ...stepBlocks(release, 'Smoke test binary'),
      ...stepBlocks(release, 'Smoke test Linux ARM64 binary'),
    ]
    expect(smokes).toHaveLength(3)
    for (const smoke of smokes) {
      expect(smoke).toContain('tar -xzf')
      expect(smoke).not.toContain('cp cli/bin/tree-sitter')
    }
    const firstTar = release.indexOf('- name: Create tarball')
    const firstSmoke = release.indexOf('- name: Smoke test binary')
    expect(firstTar).toBeGreaterThan(0)
    expect(firstTar).toBeLessThan(firstSmoke)
  })

  test('the smoke script requires the code-map probe', () => {
    const smoke = readFileSync(
      join(repoRoot, 'cli/scripts/smoke-binary.ts'),
      'utf8',
    )
    expect(smoke).toContain("'--smoke-code-map'")
    expect(smoke).toContain('/code-map smoke ok/')
  })

  test('the file list includes every query and refuses a bin dir without them', () => {
    const dir = mkdtempSync(join(tmpdir(), 'release-files-'))
    try {
      writeFileSync(join(dir, 'openbuff'), 'bin')
      writeFileSync(join(dir, 'tree-sitter.wasm'), 'w')
      writeFileSync(join(dir, 'tree-sitter-manifest.json'), '{}')
      const script = join(repoRoot, 'cli/scripts/release-tarball-files.sh')
      const missing = spawnSync('bash', [script, dir, 'openbuff'], {
        encoding: 'utf8',
      })
      expect(missing.status).toBe(1)
      expect(missing.stderr).toContain('no tree-sitter-queries/*.scm')

      const queriesSrc = join(
        repoRoot,
        'packages/code-map/src/tree-sitter-queries',
      )
      const queries = readdirSync(queriesSrc).filter((f) => f.endsWith('.scm'))
      mkdirSync(join(dir, 'tree-sitter-queries'))
      for (const q of queries)
        copyFileSync(join(queriesSrc, q), join(dir, 'tree-sitter-queries', q))
      const ok = spawnSync('bash', [script, dir, 'openbuff'], {
        encoding: 'utf8',
      })
      expect(ok.status).toBe(0)
      const listed = ok.stdout.split('\n').filter((l) => l.endsWith('.scm'))
      expect(listed.sort()).toEqual(
        queries.map((q) => `tree-sitter-queries/${q}`).sort(),
      )

      const legacy = spawnSync(
        'bash',
        [script, dir, 'openbuff', '--legacy-macos'],
        { encoding: 'utf8' },
      )
      expect(legacy.status).toBe(1)
      expect(legacy.stderr).toContain('missing libopentui.dylib')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('eval gate workflows (N10)', () => {
  test('the [buffbench] commit-tag workflow is gone', () => {
    expect(existsSync(join(workflowsDir, 'evals.yml'))).toBe(false)
    for (const file of readdirSync(workflowsDir)) {
      expect(read(file)).not.toContain('run-eval-set')
    }
  })

  test('nightly runs base2, uploads results and gates on the last green run', () => {
    const nightly = read('nightly-evals.yml')
    expect(nightly).not.toContain('base2-free')
    expect(nightly).toContain('bun run-buffbench-nightly --dry-run')
    expect(nightly).toContain('bun run-buffbench-nightly "${ARGS[@]}"')
    expect(nightly).toContain('actions/upload-artifact')
    expect(nightly).toContain('name: buffbench-nightly-results')
    expect(nightly).toContain('--status success')
    expect(nightly).toContain('bun eval-gate')
    expect(nightly).toContain('exit $STATUS')
    const main = readFileSync(
      join(repoRoot, 'evals/buffbench/main-nightly.ts'),
      'utf8',
    )
    expect(main).toContain("DEFAULT_AGENT = 'base2'")
  })

  test('the PR subset runs on agent, tool-param and system-prompt changes', () => {
    const pr = read('eval-pr-subset.yml')
    for (const path of [
      'agents/**',
      'common/src/tools/params/**',
      'packages/agent-runtime/src/system-prompt/**',
    ]) {
      expect(pr).toContain(`- '${path}'`)
    }
    expect(pr).toContain('bun run-buffbench-pr-subset --dry-run')
    expect(pr).toContain('bun eval-gate')
    expect(pr).toContain('name: buffbench-pr-subset-results')
    expect(pr).toContain('--branch main --event push')
  })
})

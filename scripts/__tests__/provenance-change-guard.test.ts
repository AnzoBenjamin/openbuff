import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  checkProvenanceCommitPaths,
  checkProvenanceChanges,
  selectProvenanceRange,
} from '../provenance-change-guard'
import {
  canonicalTarball,
  PROVENANCE_RECORD_PATH,
  REGISTRY_ORIGIN,
} from '../dependency-provenance-guard'
import type {
  ProvenanceEntry,
  ProvenanceRecord,
} from '../dependency-provenance-guard'

const repoRoot = join(import.meta.dir, '../..')
const zero = '0'.repeat(40)
const ajv: ProvenanceEntry = {
  integrity:
    'sha512-j3fVLgvTo527anyYyJOGTYJbG+vnnQYvE0m5mmkc1TK+nxAppkCLMIL0aZ4dblVCNoGShhm+kzE4ZUykBoMg4g==',
  license: 'MIT',
  tarball: 'https://registry.npmjs.org/ajv/-/ajv-6.12.6.tgz',
  deprecated: false,
}
const old: ProvenanceEntry = {
  integrity: `sha512-${Buffer.alloc(64, 3).toString('base64')}`,
  license: 'MIT',
  tarball: canonicalTarball('fixture-old', '1.0.0'),
  deprecated: false,
}
const extra: ProvenanceEntry = {
  integrity: `sha512-${Buffer.alloc(64, 4).toString('base64')}`,
  license: 'ISC',
  tarball: canonicalTarball('fixture-extra', '1.0.0'),
  deprecated: false,
}
const baseline = (): ProvenanceRecord => ({
  source: REGISTRY_ORIGIN,
  verifiedAt: '2026-11-06T00:00:00.000Z',
  packages: { 'fixture-old@1.0.0': old },
})
const addition = (): ProvenanceRecord => ({
  ...baseline(),
  verifiedAt: '2026-11-07T00:00:00.000Z',
  packages: { ...baseline().packages, 'ajv@6.12.6': ajv },
})
const lock = (entries: Record<string, ProvenanceEntry>) => `{
  "packages": {
${Object.entries(entries)
  .map(
    ([spec, entry]) =>
      `    ${JSON.stringify(spec)}: [${JSON.stringify(spec)}, "", {}, ${JSON.stringify(entry.integrity)}],`,
  )
  .join('\n')}
  }
}`

function git(root: string, ...args: string[]) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  if (result.status !== 0)
    throw new Error(`${args.join(' ')}: ${result.stderr}`)
  return result.stdout.trim()
}
function write(root: string, path: string, text: string) {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), text)
}
function record(root: string, value: ProvenanceRecord) {
  write(root, PROVENANCE_RECORD_PATH, JSON.stringify(value, null, 2) + '\n')
}
function commit(root: string, message: string) {
  git(root, 'add', '.')
  git(root, '-c', 'commit.gpgsign=false', 'commit', '-qm', message)
  return git(root, 'rev-parse', 'HEAD')
}
function withRepo(
  body: (root: string, base: string) => void,
  initial = baseline(),
  lockText = lock({ ...addition().packages, 'fixture-extra@1.0.0': extra }),
) {
  const root = mkdtempSync(join(tmpdir(), 'provenance-range-'))
  try {
    git(root, 'init', '-q', '-b', 'main')
    git(root, 'config', 'user.name', 'Provenance fixture')
    git(root, 'config', 'user.email', 'fixture@example.invalid')
    write(root, 'bun.lock', lockText)
    write(root, 'source.ts', 'export const value = 1\n')
    // Historical baseline is deliberately mixed; new-branch policy must not
    // audit unrelated root history in place of the declared default merge-base.
    record(root, initial)
    const base = commit(root, 'historical baseline')
    body(root, base)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('only exact pre-policy commits receive the visible mixed-path exception', () => {
  const legacyCommits = [
    '3448c3d014c09f28923e16fa09d9d1b07e20d9f4',
    '49e79403e8aaa91406db53498edade08cf7027f4',
  ]
  const mixedPaths = [[PROVENANCE_RECORD_PATH, 'source.ts']]
  for (const sha of legacyCommits) {
    expect(checkProvenanceCommitPaths(sha, mixedPaths, false)).toEqual({
      findings: [],
      legacyMixedCommit: true,
    })
    for (const unpinned of [
      sha.slice(0, -1),
      `${sha.slice(0, -1)}0`,
      sha.toUpperCase(),
      '1'.repeat(64),
    ]) {
      const result = checkProvenanceCommitPaths(unpinned, mixedPaths, false)
      expect(result.findings).toHaveLength(1)
      expect(result.findings[0]).toContain('dedicated record-only commit')
      expect(result.legacyMixedCommit).toBeUndefined()
    }
    // A record-only commit or an inherited merge does not apply the exception.
    expect(
      checkProvenanceCommitPaths(sha, [[PROVENANCE_RECORD_PATH]], false),
    ).toEqual({ findings: [] })
    expect(checkProvenanceCommitPaths(sha, mixedPaths, true)).toEqual({
      findings: [],
    })
  }
})

test('Git replacement refs cannot give new content a pinned legacy identity', () =>
  withRepo((root, base) => {
    record(root, addition())
    write(root, 'source.ts', 'export const value = 2\n')
    const mixed = commit(root, 'new mixed introduction')
    const legacy = '3448c3d014c09f28923e16fa09d9d1b07e20d9f4'
    git(root, 'update-ref', `refs/replace/${legacy}`, mixed)
    expect(() =>
      checkProvenanceChanges(root, {
        eventName: 'push',
        before: base,
        head: legacy,
      }),
    ).toThrow('git rev-parse failed')
  }))

test('the exact reviewed Ajv addition passes in its own commit across the whole push/PR range', () => {
  const current = JSON.parse(
    readFileSync(join(repoRoot, PROVENANCE_RECORD_PATH), 'utf8'),
  ) as ProvenanceRecord
  expect(current.packages['ajv@6.12.6']).toEqual(ajv)
  const { ['ajv@6.12.6']: _ajv, ...previous } = current.packages
  const before = { ...current, packages: previous }
  withRepo(
    (root, base) => {
      record(root, current)
      const provenanceCommit = commit(
        root,
        'append independently reviewed Ajv release',
      )
      write(root, 'source.ts', 'export const value = 2\n')
      const head = commit(root, 'source implementation after provenance')
      for (const event of [
        { eventName: 'push' as const, before: base, head },
        { eventName: 'pull_request' as const, base, head },
      ]) {
        const result = checkProvenanceChanges(root, event)
        expect(result.findings).toEqual([])
        expect(result.checkedCommits).toEqual([
          {
            commit: provenanceCommit,
            parents: [base],
            added: ['ajv@6.12.6'],
            inheritedMerge: false,
          },
        ])
      }
      const cli = spawnSync(
        process.execPath,
        [
          join(repoRoot, 'scripts/provenance-change-guard.ts'),
          '--event',
          'push',
          '--before',
          base,
          '--head',
          head,
        ],
        { cwd: root, encoding: 'utf8' },
      )
      expect(cli.status).toBe(0)
      expect(cli.stdout).toContain(
        'diff --git a/scripts/dependency-provenance.json',
      )
      expect(cli.stdout).toContain('+    "ajv@6.12.6"')
    },
    before,
    readFileSync(join(repoRoot, 'bun.lock'), 'utf8'),
  )
})

test('dedicated timestamp-only updates are allowed', () =>
  withRepo((root, base) => {
    record(root, { ...baseline(), verifiedAt: '2026-11-07T00:00:00.000Z' })
    const head = commit(root, 'timestamp refresh')
    expect(
      checkProvenanceChanges(root, { eventName: 'push', before: base, head })
        .findings,
    ).toEqual([])
  }))

test('a superseded release remains verified against its introduction lock', () =>
  withRepo((root, base) => {
    record(root, addition())
    commit(root, 'record the currently locked release')
    const upgraded: ProvenanceEntry = {
      ...ajv,
      integrity: `sha512-${Buffer.alloc(64, 5).toString('base64')}`,
      tarball: canonicalTarball('ajv', '6.12.7'),
    }
    record(root, {
      ...addition(),
      packages: { ...addition().packages, 'ajv@6.12.7': upgraded },
    })
    commit(root, 'record the upgrade before changing dependencies')
    write(
      root,
      'bun.lock',
      lock({ ...baseline().packages, 'ajv@6.12.7': upgraded }),
    )
    const head = commit(root, 'upgrade the dependency and its lock')
    const result = checkProvenanceChanges(root, {
      eventName: 'pull_request',
      base,
      head,
    })
    expect(result.findings).toEqual([])
    expect(result.checkedCommits.flatMap((item) => item.added)).toEqual([
      'ajv@6.12.6',
      'ajv@6.12.7',
    ])
  }))

test('a retired release with an unverified introduction still fails', () =>
  withRepo((root, base) => {
    record(root, {
      ...baseline(),
      packages: {
        ...baseline().packages,
        'ajv@6.12.6': { ...ajv, integrity: extra.integrity },
      },
    })
    const introduced = commit(root, 'record an incorrect release checksum')
    write(root, 'bun.lock', lock(baseline().packages))
    const head = commit(root, 'remove the release from the final lock')
    const result = checkProvenanceChanges(root, {
      eventName: 'push',
      before: base,
      head,
    })
    expect(result.findings).toContainEqual({
      commit: introduced,
      message:
        'ajv@6.12.6: integrity does not reconcile with the introduction lockfile.',
    })
  }))

test('old release identity rewrites and deletions fail even when restored before the range head', () => {
  for (const mutate of [
    (value: ProvenanceRecord) => {
      value.packages['fixture-old@1.0.0']!.integrity = ajv.integrity
    },
    (value: ProvenanceRecord) => {
      delete value.packages['fixture-old@1.0.0']
    },
  ])
    withRepo((root, base) => {
      const value = structuredClone(baseline())
      mutate(value)
      record(root, value)
      const badCommit = commit(root, 'historical identity mutation')
      record(root, baseline())
      const head = commit(root, 'restore original identity')
      const result = checkProvenanceChanges(root, {
        eventName: 'push',
        before: base,
        head,
      })
      expect(
        result.findings.some(
          (finding) =>
            finding.commit === badCommit &&
            /deleted|rewritten/.test(finding.message),
        ),
      ).toBe(true)
    })
})

test('source/schema identity mutation and invalid timestamps fail', () => {
  for (const mutate of [
    (value: ProvenanceRecord) => {
      value.source = 'https://mirror.example.invalid'
    },
    (value: ProvenanceRecord) => {
      Object.assign(value, { schemaVersion: 2 })
    },
    (value: ProvenanceRecord) => {
      value.verifiedAt = 'not-a-timestamp'
    },
  ])
    withRepo((root, base) => {
      const value = addition()
      mutate(value)
      record(root, value)
      const head = commit(root, 'invalid record metadata')
      expect(
        checkProvenanceChanges(root, { eventName: 'push', before: base, head })
          .findings.length,
      ).toBeGreaterThan(0)
    })
})

test('new entries require canonical registry URL, allowed license/deprecation, valid integrity and head lock agreement', () => {
  for (const mutate of [
    (value: ProvenanceEntry) => {
      value.tarball = 'https://mirror.example.invalid/ajv.tgz'
    },
    (value: ProvenanceEntry) => {
      value.license = 'GPL-3.0-only'
    },
    (value: ProvenanceEntry) => {
      value.deprecated = true
    },
    (value: ProvenanceEntry) => {
      value.integrity = 'sha512-bad'
    },
    (value: ProvenanceEntry) => {
      value.integrity = old.integrity
    },
  ])
    withRepo((root, base) => {
      const value = structuredClone(addition())
      mutate(value.packages['ajv@6.12.6']!)
      record(root, value)
      const head = commit(root, 'invalid appended release')
      expect(
        checkProvenanceChanges(root, { eventName: 'pull_request', base, head })
          .findings.length,
      ).toBeGreaterThan(0)
    })
})

test('a mixed source/provenance commit fails even with a later source-only head', () =>
  withRepo((root, base) => {
    record(root, addition())
    write(root, 'source.ts', 'export const value = 2\n')
    const badCommit = commit(root, 'mixed introduction')
    write(root, 'later.ts', 'export const later = true\n')
    const head = commit(root, 'later source-only work')
    const result = checkProvenanceChanges(root, {
      eventName: 'push',
      before: base,
      head,
    })
    expect(result.findings).toContainEqual({
      commit: badCommit,
      message:
        'Provenance introductions/updates require a dedicated record-only commit; source or other files changed in the same commit.',
    })
    const cli = spawnSync(
      process.execPath,
      [
        join(repoRoot, 'scripts/provenance-change-guard.ts'),
        '--event',
        'push',
        '--before',
        base,
        '--head',
        head,
      ],
      { cwd: root, encoding: 'utf8' },
    )
    expect(cli.status).toBe(1)
  }))

test('zero-before new branches use the declared default-branch merge-base and exclude unrelated history', () =>
  withRepo((root, base) => {
    git(root, 'checkout', '-qb', 'feature')
    record(root, addition())
    commit(root, 'dedicated feature introduction')
    write(root, 'feature.ts', 'export const feature = true\n')
    const head = commit(root, 'feature source')
    git(root, 'checkout', '-q', 'main')
    write(root, 'main.ts', 'export const main = true\n')
    const defaultBase = commit(root, 'default branch advanced')
    const event = {
      eventName: 'push' as const,
      before: zero,
      head,
      defaultBase,
    }
    expect(selectProvenanceRange(root, event)).toEqual({
      base,
      head,
      mode: 'new_branch',
    })
    expect(checkProvenanceChanges(root, event).findings).toEqual([])
    expect(() =>
      selectProvenanceRange(root, { eventName: 'push', before: zero, head }),
    ).toThrow('nonzero full commit SHA')
    expect(() =>
      selectProvenanceRange(root, { eventName: 'push', head }),
    ).toThrow('before SHA')
  }))

test('a whitespace-only source filename cannot disappear from the dedicated-commit check', () =>
  withRepo((root, base) => {
    record(root, addition())
    write(root, ' ', 'source content\n')
    const head = commit(root, 'mixed whitespace path')
    expect(
      checkProvenanceChanges(root, {
        eventName: 'push',
        before: base,
        head,
      }).findings.some((finding) => finding.message.includes('dedicated')),
    ).toBe(true)
  }))

test('an unrelated new branch cannot substitute a guessed parent for the declared default merge-base', () =>
  withRepo((root, defaultBase) => {
    git(root, 'checkout', '--orphan', 'unrelated')
    write(root, 'source.ts', 'export const unrelated = true\n')
    const head = commit(root, 'unrelated root')
    expect(() =>
      selectProvenanceRange(root, {
        eventName: 'push',
        before: zero,
        head,
        defaultBase,
      }),
    ).toThrow('no merge-base')
  }))

function withMerge(
  body: (root: string, base: string, feature: string) => void,
) {
  withRepo((root) => {
    git(root, 'checkout', '-qb', 'feature')
    record(root, addition())
    commit(root, 'dedicated introduction')
    write(root, 'feature.ts', 'export const feature = true\n')
    const feature = commit(root, 'feature source')
    git(root, 'checkout', '-q', 'main')
    write(root, 'main.ts', 'export const main = true\n')
    const base = commit(root, 'main source')
    body(root, base, feature)
  })
}

test('merges inherit reviewed additions intact without treating their first-parent source diff as a new introduction', () =>
  withMerge((root, base, feature) => {
    git(
      root,
      '-c',
      'commit.gpgsign=false',
      'merge',
      '--no-ff',
      '-qm',
      'merge reviewed addition',
      feature,
    )
    const head = git(root, 'rev-parse', 'HEAD')
    const result = checkProvenanceChanges(root, {
      eventName: 'push',
      before: base,
      head,
    })
    expect(result.findings).toEqual([])
    expect(
      result.checkedCommits.find((item) => item.commit === head),
    ).toMatchObject({ inheritedMerge: true, added: [] })
  }))

test('merges reject new unreviewable introductions and deletion/rewrite of any parent identity', () => {
  for (const mutate of [
    (value: ProvenanceRecord) => {
      value.packages['fixture-extra@1.0.0'] = extra
    },
    (value: ProvenanceRecord) => {
      delete value.packages['ajv@6.12.6']
    },
    (value: ProvenanceRecord) => {
      value.packages['ajv@6.12.6']!.integrity = old.integrity
    },
  ])
    withMerge((root, base, feature) => {
      git(
        root,
        '-c',
        'commit.gpgsign=false',
        'merge',
        '--no-ff',
        '--no-commit',
        feature,
      )
      const value = structuredClone(addition())
      mutate(value)
      record(root, value)
      const head = commit(root, 'merge with novel provenance edit')
      expect(
        checkProvenanceChanges(root, {
          eventName: 'push',
          before: base,
          head,
        }).findings.some((finding) => finding.commit === head),
      ).toBe(true)
    })
})

test('empty initial history is explicit and still requires dedicated introductions', () => {
  withRepo((root, head) => {
    expect(() =>
      selectProvenanceRange(root, { eventName: 'push', before: zero, head }),
    ).toThrow()
    expect(
      checkProvenanceChanges(root, {
        eventName: 'push',
        before: zero,
        head,
        initialHistory: true,
      }).findings.some((finding) => finding.message.includes('dedicated')),
    ).toBe(true)
    expect(() =>
      selectProvenanceRange(root, {
        eventName: 'push',
        before: head,
        head,
        initialHistory: true,
      }),
    ).toThrow('zero-before')
  })
  const root = mkdtempSync(join(tmpdir(), 'provenance-initial-'))
  try {
    git(root, 'init', '-q', '-b', 'main')
    git(root, 'config', 'user.name', 'Fixture')
    git(root, 'config', 'user.email', 'fixture@example.invalid')
    write(root, 'bun.lock', lock(addition().packages))
    commit(root, 'initial source/lock')
    record(root, addition())
    const head = commit(root, 'initial dedicated provenance')
    expect(
      checkProvenanceChanges(root, {
        eventName: 'push',
        before: zero,
        head,
        initialHistory: true,
      }).findings,
    ).toEqual([])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

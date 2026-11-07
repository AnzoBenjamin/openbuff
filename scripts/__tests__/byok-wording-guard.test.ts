import { afterEach, beforeEach, expect, test } from 'bun:test'
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
  findByokWordingViolations,
  formatByokWordingViolations,
} from '../byok-wording-guard'

let fixtureRoot: string

beforeEach(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'byok-wording-guard-'))
})

afterEach(() => {
  rmSync(fixtureRoot, { recursive: true, force: true })
})

test('retained markdown avoids unallowlisted hosted-product wording', () => {
  const violations = findByokWordingViolations()

  expect(formatByokWordingViolations(violations)).toBe(
    'Focused BYOK wording guard passed: no unallowlisted hosted-product wording found.',
  )
  expect(violations).toEqual([])
})

test('local workflow captures and the exact raw B30 archive are excluded without relaxing active wording', () => {
  const archive =
    'docs/execution/body-roadmap/evidence/B30/independent-review/source-snapshot'
  const excludedPaths = [
    '.omx/drafts/example/captures/README.md',
    '.omx/drafts/example/findings/providers.md',
    `${archive}/docs/architecture.md`,
  ]
  const activePaths = [
    'docs/session-state.md',
    'common/provider.knowledge.md',
    'docs/execution/body-roadmap/evidence/B30/independent-review/README.md',
    `${archive}-active/docs/architecture.md`,
    'docs/execution/body-roadmap/evidence/B31/independent-review/source-snapshot/docs/architecture.md',
    'docs/.omx/notes.md',
    'docs/.omx-active/notes.md',
  ]
  // Copied BYOK text is allowed only at its canonical product-doc path.
  const copiedText = 'BYOK with no hosted backend.\n'
  for (const path of [
    'docs/architecture.md',
    'common/knowledge.md',
    ...excludedPaths,
    ...activePaths,
  ]) {
    mkdirSync(dirname(join(fixtureRoot, path)), { recursive: true })
    writeFileSync(join(fixtureRoot, path), copiedText)
  }
  expect(
    findByokWordingViolations(fixtureRoot)
      .map((violation) => violation.path)
      .sort(),
  ).toEqual([...activePaths].sort())
  for (const path of excludedPaths) {
    expect(readFileSync(join(fixtureRoot, path), 'utf8')).toBe(copiedText)
  }
})

test('canonical product and knowledge documents still reject positive hosted-product claims', () => {
  const paths = [
    'docs/architecture.md',
    'docs/session-state.md',
    'common/knowledge.md',
  ]
  for (const path of paths) {
    mkdirSync(dirname(join(fixtureRoot, path)), { recursive: true })
    writeFileSync(join(fixtureRoot, path), 'Use the hosted backend.\n')
  }
  expect(
    findByokWordingViolations(fixtureRoot)
      .map((violation) => violation.path)
      .sort(),
  ).toEqual([...paths].sort())
})

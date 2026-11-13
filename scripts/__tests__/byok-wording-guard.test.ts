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

test('B05 document preimages retain their bytes while adjacent documents remain checked', () => {
  const evidence = 'docs/execution/body-roadmap/evidence'
  const excludedPaths = [
    `${evidence}/B05/implementation/description-preimages-1/docs/architecture.md`,
    `${evidence}/B05/implementation/description-preimages-2/source/docs/request-flow.md`,
    `${evidence}/B05/root-development/format-root-01/preimages/docs/architecture.md`,
    `${evidence}/B05/root-development/format-root-02/preimages/docs/request-flow.md`,
    `${evidence}/B05/root-development/format-root-03/preimages/docs/architecture.md`,
    `${evidence}/B05/resume-20261108/root-repair-preimages/common/knowledge.md`,
  ]
  const activePaths = [
    `${evidence}/B05/implementation/REVIEW.md`,
    `${evidence}/B05/implementation/description-preimages-3/docs/architecture.md`,
    `${evidence}/B05/implementation/description-preimages-2-active/docs/architecture.md`,
    `${evidence}/B05/root-development/format-root-03/preimages-active/docs/architecture.md`,
    `${evidence}/B05/resume-20261108/root-repair-preimages-active/common/knowledge.md`,
    `${evidence}/B06/implementation/description-preimages-1/docs/architecture.md`,
    'docs/preimages/docs/architecture.md',
  ]
  const text = 'Use the hosted backend.\n'
  for (const path of [...excludedPaths, ...activePaths]) {
    mkdirSync(dirname(join(fixtureRoot, path)), { recursive: true })
    writeFileSync(join(fixtureRoot, path), text)
  }
  expect(
    findByokWordingViolations(fixtureRoot)
      .map((violation) => violation.path)
      .sort(),
  ).toEqual([...activePaths].sort())
  for (const path of excludedPaths) {
    expect(readFileSync(join(fixtureRoot, path), 'utf8')).toBe(text)
  }
})

test('B19 copied design inputs are excluded while neighboring and memory-only historical documents remain checked', () => {
  const evidence = 'docs/execution/body-roadmap/evidence'
  const archive = `${evidence}/B19/implementation/design-input-preimages`
  const excludedPaths = [
    `${archive}/docs/agents-and-tools.md`,
    `${archive}/docs/request-flow.md`,
    `${archive}/docs/local-mode.md`,
    `${archive}/docs/architecture.md`,
  ]
  const activePaths = [
    `${evidence}/B19/implementation/REVIEW.md`,
    `${archive}-active/docs/architecture.md`,
    `${archive}-newer/docs/architecture.md`,
    `${archive}-2/docs/architecture.md`,
    `${archive}.md`,
    `${evidence}/B20/implementation/design-input-preimages/docs/architecture.md`,
    `${evidence}/B19/design-20261108/DESIGN.md`,
    `${evidence}/B19/design-review-20261108/review-r1.md`,
    `${evidence}/B19/design-review-20261108/r2/review.md`,
    `${evidence}/B19/implementation/checkpoints/state-before-preflight-11.md`,
    `${evidence}/B19/implementation/independent-architecture-20261109/r3-preflight-11-v2/precheck.md`,
  ]
  const text = 'Use the hosted backend.\n'
  for (const path of [...excludedPaths, ...activePaths]) {
    mkdirSync(dirname(join(fixtureRoot, path)), { recursive: true })
    writeFileSync(join(fixtureRoot, path), text)
  }
  expect(
    findByokWordingViolations(fixtureRoot)
      .map((violation) => violation.path)
      .sort(),
  ).toEqual([...activePaths].sort())
  for (const path of excludedPaths) {
    expect(readFileSync(join(fixtureRoot, path), 'utf8')).toBe(text)
  }
})

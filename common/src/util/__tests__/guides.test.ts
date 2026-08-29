import fs from 'fs'
import os from 'os'
import path from 'path'

import { test, expect } from 'bun:test'

import {
  BROAD_AUDIT_FALLBACK_SECTIONS,
  FALLBACK_GUIDES,
  GUIDE_FALLBACK_SECTIONS,
  findMissingGuides,
  formatGuideFallbackSection,
} from '../guides'

/** common/src/util/__tests__ -> repo root. */
const REPO_ROOT = path.join(__dirname, '..', '..', '..', '..')

const GUIDE_PATHS = Object.keys(GUIDE_FALLBACK_SECTIONS)

function makeTempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'guides-test-'))
}

test('findMissingGuides returns [] for the repo root (every guide exists)', () => {
  // Vacuity guard: an emptied table would make the expectation below trivial.
  expect(GUIDE_PATHS.length).toBeGreaterThan(0)
  expect(findMissingGuides(REPO_ROOT)).toEqual([])
})

test('findMissingGuides returns every guide for a root with no agents/guides/', () => {
  const tmpDir = makeTempRoot()
  try {
    expect(findMissingGuides(tmpDir)).toEqual(GUIDE_PATHS)
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('findMissingGuides returns only the absent subset for a partial agents/guides/', () => {
  const tmpDir = makeTempRoot()
  try {
    const present = GUIDE_PATHS.slice(0, 2)
    for (const guide of present) {
      const target = path.join(tmpDir, guide)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, '# guide\n')
    }
    expect(findMissingGuides(tmpDir)).toEqual(
      GUIDE_PATHS.filter((guide) => !present.includes(guide)),
    )
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('findMissingGuides returns [] for an empty or non-string project root', () => {
  // Never emit fallbacks on an unknown root: nothing can be concluded missing.
  expect(findMissingGuides('')).toEqual([])
  expect(findMissingGuides(undefined as unknown as string)).toEqual([])
  expect(findMissingGuides(42 as unknown as string)).toEqual([])
})

test('formatGuideFallbackSection returns empty string when the guide is present', () => {
  expect(
    formatGuideFallbackSection({
      missing: [],
      guide: FALLBACK_GUIDES.gitDiscipline,
    }),
  ).toBe('')
})

test('formatGuideFallbackSection inlines exactly the one requested body', () => {
  const requested = FALLBACK_GUIDES.preReviewSelfCheck
  const out = formatGuideFallbackSection({
    // Everything is missing, so only the `guide` argument may decide what is
    // recovered: this is the per-pointer contract that keeps a mode's omitted
    // section (plan mode's git-discipline) out of the recovered surface.
    missing: GUIDE_PATHS,
    guide: requested,
  })
  expect(out).toContain(
    `## On-demand guide body (\`${requested}\` unavailable in this workspace)`,
  )
  expect(out).toContain('read_files')
  for (const guide of GUIDE_PATHS) {
    const body = GUIDE_FALLBACK_SECTIONS[guide]
    const shouldContain = guide === requested
    // Labelled so a failure names the offending guide instead of dumping
    // multi-kilobyte strings.
    expect(
      out.includes(body) === shouldContain
        ? 'expected'
        : shouldContain
          ? `${guide} body is missing from the fallback block`
          : `${guide} body leaked into the ${requested} fallback block`,
    ).toBe('expected')
  }
})

test('formatGuideFallbackSection ignores unknown keys', () => {
  expect(
    formatGuideFallbackSection({
      missing: ['agents/guides/nope.md'],
      guide: 'agents/guides/nope.md',
    }),
  ).toBe('')
})

test('formatGuideFallbackSection recovers the requested broad-audit clause body', () => {
  // The broad-audit body is the one clause-parameterized section. Recovering
  // the implementation variant on the plan surface would contradict plan mode's
  // "do not implement" pointer tail, so the caller passes the clause body and
  // the table default must not win.
  const implBody =
    BROAD_AUDIT_FALLBACK_SECTIONS['proceed to implementation or the answer']
  const planBody =
    BROAD_AUDIT_FALLBACK_SECTIONS[
      'translate the findings into the durable plan packet below'
    ]
  expect(implBody).not.toBe(planBody)

  const planOut = formatGuideFallbackSection({
    missing: GUIDE_PATHS,
    guide: FALLBACK_GUIDES.broadAudit,
    body: planBody,
  })
  expect(planOut).toContain(planBody)
  expect(planOut).not.toContain(implBody)

  const implOut = formatGuideFallbackSection({
    missing: GUIDE_PATHS,
    guide: FALLBACK_GUIDES.broadAudit,
    body: implBody,
  })
  expect(implOut).toContain(implBody)
  expect(implOut).not.toContain(planBody)
  // Default (no `body`) is the implementation variant the guide documents.
  expect(
    formatGuideFallbackSection({
      missing: GUIDE_PATHS,
      guide: FALLBACK_GUIDES.broadAudit,
    }),
  ).toBe(implOut)
})

test('FALLBACK_GUIDES covers exactly the fallback table keys', () => {
  expect(Object.values(FALLBACK_GUIDES).sort()).toEqual(GUIDE_PATHS.sort())
})

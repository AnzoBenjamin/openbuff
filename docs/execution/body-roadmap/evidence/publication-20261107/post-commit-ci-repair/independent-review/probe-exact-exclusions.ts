import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const modulePath = process.argv[2]
if (!modulePath) throw new Error('Expected guard module path')
const guard = await import(pathToFileURL(modulePath).href)
const root = mkdtempSync(join(tmpdir(), 'openbuff-independent-exclusions-'))
const archived = [
  'docs/execution/body-roadmap/evidence/RWEB/planning-review/initial-addendum.md',
  'docs/execution/body-roadmap/evidence/RWEB/feasibility/commands-reference.md',
  'docs/execution/body-roadmap/evidence/RWEB/feasibility/session-management-reference.md',
  'docs/execution/body-roadmap/evidence/RWEB/feasibility/trust-boundaries-reference.md',
]
const active = [
  'docs/execution/body-roadmap/researcher-web-agent-browser.md',
  'docs/execution/body-roadmap/evidence/RWEB/feasibility/FEASIBILITY.md',
  'docs/execution/body-roadmap/evidence/RWEB/feasibility-independent-review/REVIEW.md',
  'docs/execution/body-roadmap/evidence/RWEB/planning-review/initial-addendum-active.md',
  'docs/execution/body-roadmap/evidence/RWEB/feasibility/commands-reference-active.md',
  'docs/execution/body-roadmap/evidence/RWEB/feasibility/commands-reference.md.backup.md',
  'docs/unrelated/commands-reference.md',
  'common/knowledge.md',
]
for (const path of [...archived, ...active]) {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), 'See `src/missing.ts` and [gone](./gone.md).\nTODO: unresolved\n')
}
const snapshot = guard.buildMarkdownSnapshot(root)
const observations = []
for (const [mode, supplied] of [['direct', undefined], ['snapshot', snapshot]] as const) {
  for (const checker of ['checkPath', 'checkCrossFile', 'checkBrokenLink', 'checkTodoFixme']) {
    const actual = guard[checker](root, supplied).map((finding: { path: string }) => finding.path).sort()
    observations.push({ mode, checker, paths: actual })
  }
}
const expected = [...active].sort()
const passed = observations.every(({ paths }) => JSON.stringify(paths) === JSON.stringify(expected))
console.log(JSON.stringify({ modulePath, root, archivedPaths: archived, activePaths: active, observations, passed }))
if (!passed) process.exit(1)

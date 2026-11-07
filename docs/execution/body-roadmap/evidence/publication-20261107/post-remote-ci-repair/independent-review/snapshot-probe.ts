import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { buildMarkdownSnapshot, checkPath, runMemoryDriftGuard } from '../../../../../../../scripts/memory-drift-guard'

const root = path.resolve(import.meta.dir, '../../../../../../..')
const source = path.join(root, 'scripts/memory-drift-guard.ts')
const sha = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex')
const before = sha(source)
const fixture = mkdtempSync(path.join(tmpdir(), 'openbuff-remote-review-'))
const outputs = ['cli/src/agents/bundled-agents.generated.ts', 'sdk/dist/index.mjs', 'sdk/dist/index.d.ts']
const neighbors = ['cli/src/agents/unknown.generated.ts', 'sdk/dist/unknown.mjs', 'sdk/src/missing.ts']
const producers = ['cli/scripts/prebuild-agents.ts', 'sdk/scripts/build.ts']
const cases: unknown[] = []
const observe = (name: string, expected: string[]) => {
  const direct = checkPath(fixture)
  const snapshot = checkPath(fixture, buildMarkdownSnapshot(fixture))
  const full = runMemoryDriftGuard(fixture).checkers.find(checker => checker.name === 'path')!.findings
  assert.deepEqual(snapshot, direct)
  assert.deepEqual(full, direct)
  assert.deepEqual(direct.map(row => row.message), expected.map(file => `referenced path \`${file}\` does not exist`))
  cases.push({ name, direct, sharedSnapshot: snapshot, fullGuardPath: full })
}
try {
  mkdirSync(path.join(fixture, 'docs'), { recursive: true })
  writeFileSync(path.join(fixture, 'docs/references.md'), [...outputs, ...neighbors].map(file => `See \`${file}\`.`).join('\n'))
  observe('absent-producers', [...outputs, ...neighbors])
  for (const producer of producers) mkdirSync(path.join(fixture, producer), { recursive: true })
  observe('directory-producers', [...outputs, ...neighbors])
  for (const producer of producers) {
    rmSync(path.join(fixture, producer), { recursive: true })
    writeFileSync(path.join(fixture, producer), '// synthetic producer fixture\n')
  }
  observe('regular-producers-with-missing-neighbors', neighbors)
  assert.ok(outputs.every(file => !existsSync(path.join(fixture, file))))
  // A markdown snapshot does not turn producer presence into a stale cache.
  const captured = buildMarkdownSnapshot(fixture)
  for (const producer of producers) rmSync(path.join(fixture, producer))
  assert.deepEqual(checkPath(fixture, captured), checkPath(fixture))
  assert.equal(checkPath(fixture, captured).length, outputs.length + neighbors.length)
  cases.push({ name: 'removed-producers-after-markdown-snapshot', findingCount: checkPath(fixture, captured).length })
  for (const output of outputs) {
    mkdirSync(path.dirname(path.join(fixture, output)), { recursive: true })
    writeFileSync(path.join(fixture, output), '// existing generated output\n')
  }
  observe('existing-outputs-with-absent-producers', neighbors)
} finally {
  rmSync(fixture, { recursive: true, force: true })
}
assert.equal(sha(source), before)
const report = { schemaVersion: 1, type: 'independent-shared-snapshot-path-probe', reviewer: '/root/b04_lock_cas', source: { path: 'scripts/memory-drift-guard.ts', sha256: before }, cases, sourceUnchanged: true, allPassed: true, scope: 'Synthetic temporary documentation fixture only; no build-output generation or roadmap acceptance.' }
writeFileSync(path.join(import.meta.dir, 'snapshot-probe.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
console.log(JSON.stringify({ cases: cases.length, allPassed: true, sourceUnchanged: true }))

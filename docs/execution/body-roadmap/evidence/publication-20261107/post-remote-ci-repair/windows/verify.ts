import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const out = import.meta.dir
let root = out
while (!existsSync(path.join(root, '.github/workflows/rust-workspace.yml'))) {
  const parent = path.dirname(root)
  assert.notEqual(parent, root)
  root = parent
}
const source = path.join(root, '.github/workflows/rust-workspace.yml')
const previous = path.join(out, 'rust-workspace.before.yml')
const original: any = Bun.YAML.parse(readFileSync(previous, 'utf8'))
const current: any = Bun.YAML.parse(readFileSync(source, 'utf8'))
const job = current.jobs['build-targets']
assert.equal(job.defaults.run['working-directory'], 'rust')
const checkout = job.steps.findIndex((step: any) => step.uses?.startsWith('actions/checkout@'))
assert.equal(checkout, 1)
assert.deepEqual(job.steps[0], {
  name: 'Enable long paths on Windows',
  if: "runner.os == 'Windows'",
  'working-directory': '${{ runner.temp }}',
  run: 'git config --global core.longpaths true',
})
assert.equal(job.steps.filter((step: any) => step.run?.includes('core.longpaths')).length, 1)
const testStep = job.steps.find((step: any) => step.run === 'cargo test --workspace')
const smokeStep = job.steps.find((step: any) => step.name === 'Smoke test openbuff-native')
assert.equal(testStep.if, 'matrix.runs-tests')
assert.equal(smokeStep.if, 'matrix.runs-smoke')
const rows = job.strategy.matrix.include
for (const row of rows) {
  assert.equal(typeof row['runs-tests'], 'boolean')
  assert.equal(typeof row['runs-smoke'], 'boolean')
}
assert.deepEqual(rows.map((row: any) => row.target), [
  'x86_64-unknown-linux-gnu', 'x86_64-unknown-linux-musl',
  'aarch64-unknown-linux-gnu', 'x86_64-pc-windows-msvc',
  'x86_64-apple-darwin',
])
assert.deepEqual(rows.filter((row: any) => row['runs-tests']).map((row: any) => row.target), [
  'x86_64-unknown-linux-gnu', 'x86_64-pc-windows-msvc', 'x86_64-apple-darwin',
])
assert.deepEqual(rows.filter((row: any) => row['runs-smoke']).map((row: any) => row.target), [
  'x86_64-unknown-linux-gnu', 'x86_64-apple-darwin',
])
// The entire parsed workflow must equal its before-image after reversing only
// the three authorized edits: one preparation step and two boolean conditions.
const reversed = structuredClone(current)
const reversedSteps = reversed.jobs['build-targets'].steps
reversedSteps.splice(0, 1)
reversedSteps.find((step: any) => step.run === 'cargo test --workspace').if = "matrix.runs-tests == 'true'"
reversedSteps.find((step: any) => step.name === 'Smoke test openbuff-native').if = "matrix.runs-smoke == 'true'"
assert.deepEqual(reversed, original)
const sha = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex')
const rawLog = path.join(out, 'run-42317166029-failed.log')
const logLines = readFileSync(rawLog, 'utf8').split('\n')
const errors = logLines.filter((line) => line.includes('Filename too long'))
assert.ok(errors.length > 0)
assert.ok(errors.every((line) => line.startsWith('build-target-x86_64-pc-windows-msvc\tRun actions/checkout@v4')))
const report = {
  schemaVersion: 1, reviewer: '/root/b02_runtime_outcomes',
  source: { path: path.relative(root, source), sha256: sha(source) },
  before: { path: path.relative(root, previous), sha256: sha(previous) },
  originalFailure: { runId: '42317166029', checkoutFilenameTooLongErrors: errors.length, log: { path: path.relative(root, rawLog), sha256: sha(rawLog) } },
  controls: {
    yamlParsedWithPinnedBun: true, windowsOnlyPreparationBeforeCheckout: true,
    preCheckoutWorkingDirectoryUsesRunnerTemp: true,
    booleanMatrixFlagsAndDirectConditions: true, exactFiveTargetRosterPreserved: true,
    allOtherParsedWorkflowValuesPreserved: true,
  },
  targetConditions: rows.map((row: any) => ({ target: row.target, os: row.os, cargoTestsSelected: row['runs-tests'], smokeSelected: row['runs-smoke'] })),
  allPassed: true,
  executionScope: 'Linux YAML/ordering/condition structure checks only. No Windows checkout, Rust build, cargo test or target smoke execution is claimed. Real GitHub rerun is required.',
}
writeFileSync(path.join(out, 'verification.json'), JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify(report))

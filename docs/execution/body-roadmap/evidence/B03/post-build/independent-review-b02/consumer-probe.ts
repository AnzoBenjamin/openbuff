import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

globalThis.fetch = Object.assign(async () => { throw new Error('Independent current-source probe refuses fetch') }, globalThis.fetch)
const root = path.resolve(import.meta.dirname, '../../../../../../..')
const { committedMutationFixture } = await import(path.join(root, 'common/src/testing/fixtures/file-mutation.ts'))
const { commitReceiptV1Schema, buildFileMutationResultFromReceiptV1, fileMutationResultV1Schema, getConfirmedAppliedActionsV1 } = await import(path.join(root, 'common/src/tools/results/filesystem.ts'))
const { classifyActionOutput } = await import(path.join(root, 'common/src/util/action-outcomes.ts'))
const { actionOutcomeSchema } = await import(path.join(root, 'common/src/types/run-outcome.ts'))
const { getConfirmedMutationActionsFromOutput, getMutationOutcome } = await import(path.join(root, 'cli/src/utils/tool-result-normalizer.ts'))
const { outcomeForTool } = await import(path.join(root, 'cli/src/utils/output-outcome.ts'))
const { computeCompletionSummary } = await import(path.join(root, 'cli/src/utils/completion-summary.ts'))
const { getFileStatsFromBlocks, buildActivityTimeline } = await import(path.join(root, 'cli/src/utils/implementor-helpers.ts'))
const { printModeToSessionUpdates, projectOutcomesForWire } = await import(path.join(root, 'sdk/src/serve/event-bridge.ts'))
const ctx = { sessionId: 'independent', runId: 'independent-run', eventsMode: 'acp', projectRoot: '/fixture', toolKind: () => 'edit' }
const base = committedMutationFixture([{ path: '.env', content: 'B03_SYNTHETIC_VALUE=after\r\n' }])
const { authorityReceipt: removed, ...unbacked } = base
assert(fileMutationResultV1Schema.safeParse(unbacked).success)
const unbackedOutput = [{ type: 'json', value: unbacked }]
const classified = classifyActionOutput('write_file', unbackedOutput)
assert.equal(classified.outcome, 'uncertain')
assert.notEqual(classified.effect.status, 'confirmed')
assert.deepEqual(classified.effect.confirmedPaths, [])
assert.deepEqual(getConfirmedAppliedActionsV1(unbacked), [])
assert.deepEqual(getConfirmedMutationActionsFromOutput(unbackedOutput), [])
assert.equal(getMutationOutcome(unbackedOutput), 'unconfirmed')
const cliStatus = outcomeForTool({ toolName: 'write_file', lifecycle: 'succeeded', outputRaw: unbackedOutput })
assert.equal(cliStatus.label, 'unconfirmed')
assert.equal(cliStatus.tone, 'warn')
const block = { type: 'tool', toolName: 'edit_transaction', toolCallId: 'raw', input: {}, outputRaw: unbackedOutput, lifecycle: 'succeeded' }
const summary = computeCompletionSummary([block])
assert.equal(summary.filesEdited, 0)
assert.deepEqual(getFileStatsFromBlocks([block]), [])
assert.deepEqual(buildActivityTimeline([block]), [])
const rawUpdate = printModeToSessionUpdates({ type: 'tool_result', toolCallId: 'raw', toolName: 'write_file', output: unbackedOutput }, ctx)[0]
assert.equal(rawUpdate.status, 'failed')
assert(!rawUpdate.content.some((part) => part.type === 'diff' || part.text === '[sensitive file changed: .env]'))

const receipts = [
  { name: 'confirmed', receipt: removed, confirmation: 1 },
  { name: 'refused-rollback', receipt: { ...removed, status: 'rollback_incomplete', actions: removed.actions.map(a => ({ ...a, status: 'rollback_failed', forward: { outcome: 'not_applied', afterHashes: { '.env': a.afterHash } } })) }, confirmation: 0 },
  { name: 'uncertain-rollback', receipt: { ...removed, status: 'rollback_incomplete', actions: removed.actions.map(a => ({ ...a, status: 'rollback_failed', forward: { outcome: 'unconfirmed', afterHashes: { '.env': a.afterHash } } })) }, confirmation: 0 },
  { name: 'confirmed-delete', receipt: { ...removed, actions: removed.actions.map(a => ({ ...a, action: 'delete', afterHash: null, forward: { outcome: 'applied', afterHashes: { '.env': null } } })), finalHashes: { '.env': null } }, confirmation: 1 },
]
const cases = receipts.map(({ name, receipt, confirmation }) => {
  const parsed = commitReceiptV1Schema.parse(receipt)
  const mutation = name === 'confirmed' ? base : buildFileMutationResultFromReceiptV1(parsed)
  const output = [{ type: 'json', value: mutation }]
  assert.equal(getConfirmedAppliedActionsV1(mutation).length, confirmation)
  const actionOutcome = actionOutcomeSchema.parse({ actionId: name, attemptId: name, runId: 'independent-run', toolName: 'write_file', basis: { inputHash: 'sha256:synthetic-input-identity' }, ...classifyActionOutput('write_file', output) })
  const update = printModeToSessionUpdates({ type: 'tool_result', toolCallId: name, toolName: 'write_file', output, actionOutcome }, ctx)[0]
  const terminal = projectOutcomesForWire({ runOutcome: { termination: 'completed' }, actionOutcomes: [actionOutcome] })
  const text = JSON.stringify({ update, terminal })
  assert(!text.includes('B03_SYNTHETIC_VALUE'))
  assert(!text.includes('sha256:synthetic-input-identity'))
  for (const hash of [parsed.actions[0].beforeHash, parsed.actions[0].afterHash]) if (hash) assert(!text.includes(hash))
  const envelope = update._meta['openbuff.dev'].receipt
  assert.equal(envelope.mutation.actions[0].beforeHash, 'sha256:redacted')
  assert.equal(envelope.mutation.actions[0].afterHash, parsed.actions[0].afterHash === null ? null : 'sha256:redacted')
  assert.equal(envelope.mutation.authorityReceipt.finalHashes['.env'], parsed.finalHashes['.env'] === null ? null : 'sha256:redacted')
  assert.equal(update.content.filter(p => p.text === '[sensitive file changed: .env]').length, confirmation)
  assert(!update.content.some(p => p.type === 'diff'))
  assert.equal(terminal.actionOutcomes[0].basis.inputHash, 'sha256:redacted')
  return { name, mutation, confirmation, actionOutcome, update, terminal }
})
fs.writeFileSync(path.join(import.meta.dirname, 'consumer-probe.json'), JSON.stringify({ rawUnbacked: { classified, cliOutcome: getMutationOutcome(unbackedOutput), summary, acp: rawUpdate }, cases }, null, 2) + '\n')
console.log('Independent raw-unbacked consumer and four canonical sensitive receipt cases passed.')

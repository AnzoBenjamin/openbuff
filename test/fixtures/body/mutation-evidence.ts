import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createMockFs } from '@codebuff/common/testing/mocks/filesystem'
import {
  getContentHash,
  getExactContentHash,
} from '@codebuff/common/util/content-hash'
import {
  fileMutationResultV1Schema,
  getConfirmedAppliedActionsV1,
  buildFileMutationResultFromReceiptV1,
} from '@codebuff/common/tools/results/filesystem'
import { getConfirmedMutationActions } from '../../../cli/src/utils/tool-result-normalizer'
import { computeCompletionSummary } from '../../../cli/src/utils/completion-summary'
import { outcomeForTool } from '../../../cli/src/utils/output-outcome'
import { classifyActionOutput } from '@codebuff/common/util/action-outcomes'
import { withEvaluationEnvironment } from '../../../evals/buffbench/evaluation-environment'

function insist(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

async function worker(outputRoot: string) {
  fs.mkdirSync(outputRoot, { recursive: true })
  const fetch = { attempted: 0, forwarded: 0 }
  globalThis.fetch = Object.assign(async () => {
    fetch.attempted++
    throw new Error('B03 fixture refuses network dispatch')
  }, globalThis.fetch)
  const { OpenbuffClient } = await import('../../../sdk/src/client')
  const records: unknown[] = []
  for (const mode of [
    'rejected-then-recovered',
    'thrown-partial',
    'retained-partial-forward',
    'successful-edit',
  ]) {
    const before = { '/repo/a.txt': 'a-before\n', '/repo/b.txt': 'b-before\n' }
    const source = createMockFs({ files: before })
    const baseCommit = source.conditionalCommit!.bind(source)
    const adapterReturns: unknown[] = []
    let calls = 0
    source.conditionalCommit = async (file, data, options) => {
      calls++
      let result: Awaited<ReturnType<typeof baseCommit>>
      if (mode === 'rejected-then-recovered' && calls === 1) {
        await source.writeFile('/repo/a.txt', 'foreign\r\n')
        result = {
          applied: false,
          actualHash: getExactContentHash('foreign\r\n'),
        }
      } else if (
        (mode === 'thrown-partial' || mode === 'retained-partial-forward') &&
        String(file) === '/repo/b.txt'
      ) {
        await source.writeFile('/repo/b.txt', 'partial\n')
        if (String(data) === 'b-after\n') {
          adapterReturns.push({
            path: String(file),
            threw: 'partial write failure',
            observedHash: getExactContentHash('partial\n'),
          })
          throw new Error('partial write failure')
        }
        result = {
          applied: false,
          actualHash: getExactContentHash('partial\n'),
        }
      } else if (
        mode === 'retained-partial-forward' &&
        String(data) === 'a-before\n'
      ) {
        result = {
          applied: false,
          actualHash: getExactContentHash('a-after\n'),
        }
      } else result = await baseCommit(file, data, options)
      adapterReturns.push({
        path: String(file),
        requested: String(data),
        result,
      })
      return result
    }
    const edits =
      mode === 'thrown-partial'
        ? [[{ type: 'file', path: 'b.txt', content: 'b-after\n' }]]
        : mode === 'retained-partial-forward'
          ? [
              [
                { type: 'file', path: 'a.txt', content: 'a-after\n' },
                { type: 'file', path: 'b.txt', content: 'b-after\n' },
              ],
            ]
          : mode === 'rejected-then-recovered'
            ? [
                [
                  {
                    type: 'file',
                    path: 'a.txt',
                    content: 'a-after\n',
                    expectedHash: getContentHash('a-before\n'),
                  },
                ],
                [
                  {
                    type: 'file',
                    path: 'a.txt',
                    content: 'recovered\n',
                    expectedHash: getContentHash('foreign\r\n'),
                  },
                ],
              ]
            : [
                [
                  {
                    type: 'file',
                    path: 'a.txt',
                    content: 'a-after\n',
                    expectedHash: getContentHash('a-before\n'),
                  },
                ],
              ]
    const events: any[] = []
    const observers: unknown[] = []
    const canonicalEdits = edits.map((group, index) =>
      group.map((edit) => ({
        type: 'str_replace',
        path: edit.path,
        replacements: [
          {
            oldString:
              mode === 'rejected-then-recovered' && index === 1
                ? 'foreign\r\n'
                : before[('/repo/' + edit.path) as keyof typeof before],
            newString: edit.content,
          },
        ],
      })),
    )
    const harness = path.join(outputRoot, mode, 'harness')
    const client = new OpenbuffClient({
      cwd: '/repo',
      fsSource: source,
      projectFiles: {},
      harnessStateDir: harness,
      onFilesystemMutation: (event) => observers.push(event),
    })
    const result = await client.run({
      agent: 'b03-fixture',
      prompt: 'Fixed local mutation evidence fixture',
      agentDefinitions: [
        {
          id: 'b03-fixture',
          displayName: 'Mutation fixture',
          model: 'openai/gpt-4.1',
          toolNames: ['edit_transaction', 'set_output'],
          outputMode: 'structured_output',
          handleSteps: `function* () { for (const input of ${JSON.stringify(canonicalEdits)}) yield {toolName:'edit_transaction',input:{edits:input}}; yield {toolName:'set_output',input:{done:true}}; }`,
        },
      ],
      inheritEnv: false,
      handleEvent: (event) => events.push(event),
    })
    const mutations = events
      .filter(
        (event) =>
          event.type === 'tool_result' && event.toolName === 'edit_transaction',
      )
      .map((event) => fileMutationResultV1Schema.parse(event.output[0].value))
    fs.mkdirSync(path.join(outputRoot, mode), { recursive: true })
    fs.writeFileSync(
      path.join(outputRoot, mode, 'sdk-output.json'),
      JSON.stringify(
        {
          output: result.output,
          runOutcome: result.runOutcome,
          events,
          observers,
        },
        null,
        2,
      ),
    )
    insist(
      mutations.length === edits.length,
      mode + ': missing actual SDK result',
    )
    const projections = mutations.map((mutation) => {
      const block: any = {
        type: 'tool',
        toolName: 'edit_transaction',
        toolCallId: mutation.operationId,
        input: {},
        outputRaw: [{ type: 'json', value: mutation }],
        lifecycle: 'succeeded',
      }
      const json = JSON.parse(JSON.stringify(mutation))
      const confirmed = getConfirmedAppliedActionsV1(json)
      const cliConfirmed = getConfirmedMutationActions(block)
      insist(
        cliConfirmed.length === confirmed.length,
        mode + ': CLI authority diverged',
      )
      return {
        mutation: json,
        confirmed,
        cliConfirmed,
        cliOutcome: outcomeForTool(block),
        summary: computeCompletionSummary([block]),
        headlessAction: classifyActionOutput(
          'edit_transaction',
          block.outputRaw,
        ),
      }
    })
    const after = Object.fromEntries(
      await Promise.all(
        Object.keys(before).map(async (file) => [
          file,
          await source.readFile(file, 'utf8'),
        ]),
      ),
    )
    if (mode === 'rejected-then-recovered') {
      insist(
        projections[0]!.confirmed.length === 0 &&
          projections[1]!.confirmed.length === 1,
        'Refused edit became confirmed or recovery disappeared',
      )
      insist(
        observers.length === 1 && after['/repo/a.txt'] === 'recovered\r\n',
        'Refused edit incorrectly reached observers',
      )
      insist(
        mutations[0]!.authorityReceipt?.finalHashes['a.txt'] ===
          getExactContentHash('foreign\r\n'),
        'Foreign bytes were not preserved in refused receipt',
      )
    } else if (mode === 'thrown-partial') {
      insist(
        projections[0]!.confirmed.length === 0 &&
          observers.length === 0 &&
          after['/repo/b.txt'] === 'partial\n',
        'Uncertain partial effect became confirmed',
      )
    } else if (mode === 'retained-partial-forward') {
      insist(
        projections[0]!.confirmed.length === 1 &&
          projections[0]!.confirmed[0]!.path === 'a.txt' &&
          observers.length === 1,
        'Genuine surviving forward effect was lost or uncertain work promoted',
      )
      insist(
        after['/repo/a.txt'] === 'a-after\n' &&
          after['/repo/b.txt'] === 'partial\n',
        'Partial bytes changed unexpectedly',
      )
    } else
      insist(
        projections[0]!.confirmed.length === 1 &&
          observers.length === 1 &&
          after['/repo/a.txt'] === 'a-after\n',
        'Successful conditional edit failed',
      )
    records.push({
      mode,
      before: Object.fromEntries(
        Object.entries(before).map(([f, v]) => [
          f,
          {
            utf8: v,
            base64: Buffer.from(v).toString('base64'),
            hash: getExactContentHash(v),
          },
        ]),
      ),
      after: Object.fromEntries(
        Object.entries(after).map(([f, v]) => [
          f,
          {
            utf8: v,
            base64: Buffer.from(v).toString('base64'),
            hash: getExactContentHash(v),
          },
        ]),
      ),
      adapterReturns,
      projections,
      observers,
      events,
      runOutcome: result.runOutcome,
      output: result.output,
    })
  }
  const legacy = buildFileMutationResultFromReceiptV1({
    kind: 'commit_receipt',
    version: 1,
    receiptId: 'legacy-refused',
    operationId: 'legacy-refused',
    callId: 'legacy-refused',
    authorityTier: 'conditional_commit',
    status: 'rollback_incomplete',
    actions: [
      {
        actionId: 'legacy-action',
        index: 0,
        action: 'update',
        path: 'a.txt',
        status: 'rollback_failed',
        beforeHash: 'before',
        afterHash: 'foreign',
        forward: {
          outcome: 'not_applied',
          afterHashes: { 'a.txt': 'foreign' },
        },
        rollback: { attempted: true, succeeded: false },
      },
    ],
    finalHashes: { 'a.txt': 'foreign' },
  })
  insist(
    getConfirmedAppliedActionsV1(legacy).length === 0,
    'Historical rollback failure manufactured forward authority',
  )
  insist(fetch.attempted === 0, 'Unexpected provider/network dispatch attempt')
  const codingFetch = { ...fetch }
  const fetchGuardClient = new OpenbuffClient({
    cwd: process.cwd(),
    projectFiles: {},
    harnessStateDir: path.join(outputRoot, 'fetch-guard-harness'),
  })
  const fetchGuardResult = await fetchGuardClient.run({
    agent: 'b03-fetch-guard',
    prompt: 'Fixed local fetch observation control',
    agentDefinitions: [
      {
        id: 'b03-fetch-guard',
        displayName: 'Fetch observation control',
        model: 'openai/gpt-4.1',
        toolNames: ['set_output'],
        outputMode: 'structured_output',
        handleSteps: `function* () { fetch('https://b03-provider.invalid/guard-control').catch(() => {}); yield {toolName:'set_output',input:{initiated:true}}; }`,
      },
    ],
  })
  insist(
    fetchGuardResult.output.type === 'structuredOutput' &&
      fetchGuardResult.output.value?.initiated === true &&
      fetch.attempted === 1 &&
      fetch.forwarded === 0,
    'Fetch observer positive control failed',
  )
  const report = {
    scope:
      'Actual source SDK generator/dispatch with injected filesystem faults, JSON headless/CLI authority consumers and retained journals; no provider calls, OS/CAS/native/installed-package claim',
    environment: {
      home: os.homedir(),
      cwd: process.cwd(),
      credentialNames: Object.keys(process.env).filter((name) =>
        /API_KEY|ACCESS_TOKEN/.test(name),
      ),
    },
    fetch: codingFetch,
    fetchGuardControl: {
      attempted: fetch.attempted,
      forwarded: fetch.forwarded,
      refused: fetch.attempted,
      output: fetchGuardResult.output,
      scope: 'SDK global fetch only; no OS/network confinement',
    },
    records,
    legacyRefusedRollback: legacy,
  }
  fs.writeFileSync(
    path.join(outputRoot, 'mutation-report.json'),
    JSON.stringify(report, null, 2),
  )
}

if (import.meta.main) {
  const outputRoot = path.resolve(process.argv[2]!)
  insist(process.argv[2], 'Provide an owned evidence directory')
  if (process.argv[3] === '--worker') await worker(outputRoot)
  else
    await withEvaluationEnvironment(
      'key_free_environment',
      undefined,
      async (env) => {
        const child = spawnSync(
          process.execPath,
          ['--no-env-file', import.meta.path, outputRoot, '--worker'],
          { cwd: path.dirname(env.HOME!), env, stdio: 'inherit' },
        )
        insist(
          child.status === 0,
          `Mutation fixture child failed: ${child.status}`,
        )
      },
    )
}

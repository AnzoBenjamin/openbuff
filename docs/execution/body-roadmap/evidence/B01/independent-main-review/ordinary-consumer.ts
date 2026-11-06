import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'

let fetchAttempted = 0
globalThis.fetch = Object.assign(
  async () => {
    fetchAttempted++
    throw new Error('B01 ordinary consumer refuses fetch')
  },
  { preconnect() {} },
) as typeof fetch
const { createBase2 } = await import('../../../../../../agents/base2/base2')
const { editReceipt } =
  await import('../../../../../../agents/__tests__/helpers/base2-step-fixtures')
const sha = (bytes: Uint8Array | string) =>
  createHash('sha256').update(bytes).digest('hex')
const originalCwd = process.cwd()
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'b01-ordinary-consumer-'))
const reports = []
const wrap = (value: unknown) => ({ toolResult: [{ type: 'json', value }] })
try {
  for (const kind of [
    'complete',
    'empty-requirements',
    'empty-dimensions',
    'obsolete-basis',
  ]) {
    const cwd = path.join(root, kind)
    fs.mkdirSync(path.join(cwd, 'src'), { recursive: true })
    const file = path.join(cwd, 'src/a.ts')
    const before = 'export const answer = 1\n'
    const after = 'export const answer = 2\n'
    fs.writeFileSync(file, before)
    process.chdir(cwd)
    const agentState: any = { agentId: 'base2' }
    const generator = createBase2('default').handleSteps!({
      agentState,
      prompt: 'Make the requested change now please',
      params: {},
    } as any)
    let next: any = generator.next()
    let sawStep = false
    let reviewerSpawns = 0
    const calls: Array<Record<string, unknown>> = []
    const observations: Array<Record<string, unknown>> = []
    let currentFingerprint = ''
    for (let index = 0; index < 150 && !next.done; index++) {
      const call = next.value
      if (
        agentState.base2ActiveWork?.reviewerProtocolAttestationFailed ||
        agentState.base2ActiveWork?.currentPhase === 'final_response_allowed'
      )
        break
      if (call === 'STEP') {
        if (!sawStep) {
          sawStep = true
          fs.writeFileSync(file, after)
          next = generator.next({
            ...wrap(editReceipt('src/a.ts')),
            stepsComplete: true,
          } as any)
        } else {
          next = generator.next({ ...wrap({}), stepsComplete: true } as any)
        }
        continue
      }
      calls.push({
        toolName: call?.toolName,
        agentTypes: call?.input?.agents?.map((agent: any) => agent.agent_type),
      })
      if (call?.toolName === 'git_status') {
        next = generator.next(
          wrap({ status: sawStep ? ' M src/a.ts' : '' }) as any,
        )
      } else if (call?.toolName === 'run_file_change_hooks') {
        next = generator.next(
          wrap([
            { command: 'fixture-pass', hookName: 'fixture', exitCode: 0 },
          ]) as any,
        )
      } else if (call?.toolName === 'get_change_review_bundle') {
        next = generator.next(
          wrap({
            snapshotId: 'evidence-only-fixture',
            files: ['src/a.ts'],
            diff: '',
            ownership: [],
            validation: [],
            findings: [],
          }) as any,
        )
      } else if (
        call?.toolName === 'spawn_agents' &&
        call?.input?.agents?.some(
          (agent: any) => agent.agent_type === 'code-reviewer',
        )
      ) {
        reviewerSpawns++
        const prompt = String(
          call.input.agents.find(
            (agent: any) => agent.agent_type === 'code-reviewer',
          ).prompt,
        )
        currentFingerprint =
          prompt.match(
            /Snapshot fingerprint \(echo exactly\): ([^\n]+)/,
          )?.[1] ?? ''
        assert(currentFingerprint.startsWith('v3:'))
        const files =
          prompt
            .match(/Gate-scope changed files: ([^\n]+)/)?.[1]
            ?.split(',')
            .map((item) => item.trim()) ?? []
        const obsolete = `v3:${sha(`files-v4\nsrc/a.ts\tsha256:${sha(before)}:${Buffer.byteLength(before)}\n--\n`)}`
        const receipt = {
          schemaVersion: 1,
          family: 'reviewer',
          verdict: 'LOOKS_GOOD',
          findings: [],
          coverage: 'covered',
          reviewedFiles: files,
          snapshotFingerprint:
            kind === 'obsolete-basis' ? obsolete : currentFingerprint,
          dimensions:
            kind === 'empty-dimensions'
              ? {}
              : {
                  correctness: 'pass: final bytes read',
                  security: 'pass: no external inputs',
                  tests: 'pass: fixture assertion observed',
                  apiCompatibility: 'pass: export unchanged',
                  performance: 'pass: constant expression',
                },
          requirementCoverage:
            kind === 'empty-requirements'
              ? []
              : [
                  {
                    requirement: 'Set answer to 2',
                    status: 'satisfied',
                    evidence: ['src/a.ts:answer = 2'],
                  },
                ],
        }
        observations.push({
          reviewerSpawns,
          receipt,
          actualContentSha256: sha(fs.readFileSync(file)),
        })
        next = generator.next(wrap([receipt]) as any)
      } else if (call?.toolName === 'add_message') {
        if (typeof call.input?.content === 'string')
          observations.push({ message: call.input.content })
        next = generator.next(wrap({}) as any)
      } else {
        next = generator.next(wrap({}) as any)
      }
    }
    const work = agentState.base2ActiveWork
    const report = {
      kind,
      beforeBytesSha256: sha(before),
      afterBytesSha256: sha(after),
      reviewerSpawns,
      currentFingerprint,
      phase: work?.currentPhase,
      protocolFailed: work?.reviewerProtocolAttestationFailed ?? false,
      openBlockers: work?.openReviewerBlockers ?? [],
      gatePassedFiles: work?.gatePassedFiles ?? [],
      reviewerVerdict: work?.gatePassedReviewerVerdict,
      reviewReceipts: work?.reviewReceipts ?? [],
      calls,
      observations,
    }
    reports.push(report)
    if (kind === 'complete') {
      assert.equal(report.protocolFailed, false)
      assert.equal(report.phase, 'final_response_allowed')
      assert.equal(report.reviewerSpawns, 1)
    } else {
      assert.equal(report.protocolFailed, true)
      assert.equal(report.phase, 'blocked')
      assert.equal(report.reviewerSpawns, 2)
      assert(
        report.openBlockers.some((item: string) =>
          item.includes(
            kind === 'obsolete-basis'
              ? 'fingerprint did not match'
              : kind === 'empty-dimensions'
                ? 'did not assess correctness'
                : 'nonempty requirement evidence',
          ),
        ),
      )
      assert.equal(report.reviewReceipts.length, 0)
    }
    generator.return(undefined)
  }
  assert.equal(fetchAttempted, 0)
  fs.writeFileSync(
    path.join(import.meta.dir, 'ordinary-consumer-report.json'),
    JSON.stringify(
      {
        createdAt: new Date().toISOString(),
        allAssertionsPassed: true,
        runtime: { executable: process.execPath, bun: Bun.version },
        reports,
        codingFetch: { attempted: fetchAttempted, forwarded: 0 },
        boundary:
          'Actual source base2 handleSteps and real file markers; injected model/reviewer/tool feeds. No model/provider request and no approval of tail/store implementations.',
      },
      null,
      2,
    ) + '\n',
  )
  console.log(
    JSON.stringify({
      allAssertionsPassed: true,
      cases: reports.map((item) => ({
        kind: item.kind,
        phase: item.phase,
        reviewerSpawns: item.reviewerSpawns,
      })),
      fetchAttempted,
    }),
  )
} finally {
  process.chdir(originalCwd)
  fs.rmSync(root, { recursive: true, force: true })
}

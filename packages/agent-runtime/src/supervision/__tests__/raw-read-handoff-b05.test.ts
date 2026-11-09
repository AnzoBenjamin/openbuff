import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import {
  captureTextDocument,
  getRawLineSpan,
  getRawReadBasis,
} from '@codebuff/common/util/byte-text'
import {
  decodeReadCapabilityToken,
  encodeReadCapabilityToken,
  getContentHash,
} from '@codebuff/common/util/content-hash'
import { readFilesResultV1Schema } from '@codebuff/common/tools/results/filesystem'
import {
  buildSupervisedBridgeHandlers,
  startParentBridgeServer,
} from '../parent-bridge-server'
import { buildBridgedChildDeps } from '../child-bridge-client'
import { authenticateReadFilesItem } from '../../util/authenticated-read-source'

import type {
  ReadFilesItemV1,
  ReadFilesResultV1,
} from '@codebuff/common/tools/results/filesystem'
import type { ReadCapabilityIssuer } from '@codebuff/common/util/content-hash'
import type { RequestFilesFn } from '@codebuff/common/types/contracts/client'
import type { SupervisedBridgeHandlerDeps } from '../parent-bridge-server'
import type { ChildBridgeClient } from '../child-bridge-client'
import type { ParentValidatedReadFilesResponse } from '../bridge-protocol'

const issuer = { projectId: '/b05-project', runId: 'host-run' }
const bridgeNonce = 'owned-b05-bridge-nonce'
const rawSource = '\uFEFFfirst😀\r\n\uFEFFselected\r\ntail\n'
const params = {
  filePaths: ['file.ts'],
  ranges: [{ path: 'file.ts', startLine: 2, endLine: 2 }],
  capabilityIssuer: issuer,
}
type Item = Extract<
  ReadFilesItemV1,
  { selector: 'file' | 'range'; status: 'ok' | 'partial' }
>

function makeItems(owner = issuer): Item[] {
  const document = captureTextDocument(rawSource, {
    view: 'descriptor',
    coherence: 'checked',
    generation: 'actual-test-generation',
  })
  const span = getRawLineSpan(document, 2, 2)
  const sourceContent = document.observation.slice(
    span.startObservationOffset,
    span.endObservationOffset,
  )
  const anchor = (
    startLine: number,
    endLine: number,
    hash: string,
    scope: 'whole' | 'lines',
  ) => {
    const rawBasis = getRawReadBasis(document, startLine, endLine, scope)
    return {
      startLine,
      endLine,
      contentHash: hash,
      rawBasis,
      readCapability: encodeReadCapabilityToken({
        startLine,
        endLine,
        hash,
        rawBasis,
        scope: { ...owner, path: 'file.ts' },
      }),
    }
  }
  const wholeAnchor = anchor(
    1,
    document.maxCapabilityLine,
    document.observationHash,
    'whole',
  )
  const rangeAnchor = anchor(2, 2, getContentHash(sourceContent), 'lines')
  return [
    {
      selector: 'file',
      requestIndex: 0,
      path: 'file.ts',
      status: 'ok',
      complete: true,
      metadataComplete: true,
      template: false,
      content: document.observation,
      rawSourceContent: rawSource,
      editAnchor: wholeAnchor,
    },
    {
      selector: 'range',
      requestIndex: 1,
      path: 'file.ts',
      status: 'ok',
      complete: true,
      metadataComplete: true,
      startLine: 2,
      endLine: 2,
      totalLines: document.visibleLineCount,
      sourceContent,
      content: `[RANGE_BLOCK lines 2-2; readCapability=${rangeAnchor.readCapability}; readCapability: "${rangeAnchor.readCapability}"; basedOnRead="${rangeAnchor.readCapability}"]\n2: ${sourceContent}`,
      editAnchor: rangeAnchor,
    },
  ]
}

function makeResult(items: ReadFilesItemV1[] = makeItems()): ReadFilesResultV1 {
  return {
    kind: 'read_files_result',
    version: 1,
    status: 'ok',
    summary: {
      requested: items.length,
      ok: items.length,
      partial: 0,
      failed: 0,
      uniquePaths: 1,
    },
    results: items,
  }
}

function hostTable(
  read: RequestFilesFn = async () => makeResult(),
  options: Parameters<typeof buildSupervisedBridgeHandlers>[1] = {
    bridgeNonce,
    readCapabilityIssuer: issuer,
  },
  start: SupervisedBridgeHandlerDeps['startAgentRun'] = async () =>
    issuer.runId,
) {
  const table = buildSupervisedBridgeHandlers(
    {
      requestFiles: read,
      startAgentRun: start,
      apiKey: '',
    } as SupervisedBridgeHandlerDeps,
    options,
  )
  // The production dispatcher intentionally erases JSON params to `never`.
  // These tests invoke that exact dispatcher with owned serialized inputs.
  return table as unknown as Omit<
    typeof table,
    'requestFiles' | 'startAgentRun'
  > & {
    requestFiles: (
      request: unknown,
    ) => Promise<ParentValidatedReadFilesResponse>
    startAgentRun: (request: unknown) => Promise<string | null>
  }
}

function childFor(reply: unknown, nonce: string | undefined = bridgeNonce) {
  return buildBridgedChildDeps(
    {
      call: async () => structuredClone(reply),
      notify: () => {},
      close: () => {},
      onClose: () => {},
    },
    { bridgeNonce: nonce },
  )
}

async function wrapped(
  items = makeItems(),
  request = params,
): Promise<ParentValidatedReadFilesResponse> {
  return (await hostTable(async () => makeResult(items)).requestFiles!(
    request,
  )) as ParentValidatedReadFilesResponse
}

function expectDisplayOnly(result: ReadFilesResultV1) {
  for (const item of result.results) {
    expect('editAnchor' in item && item.editAnchor).toBeFalsy()
    expect('rawSourceContent' in item && item.rawSourceContent).toBeFalsy()
    if (item.selector === 'range' && item.status !== 'error')
      expect(item.content).not.toContain('cap.v')
  }
}

describe('B05 parent-authenticated raw reads and child-local v4 handoff', () => {
  test('parent transports validated facts without its token; child restores complete whole/range observations and header copies', async () => {
    const items = makeItems()
    const reply = await wrapped(items)
    expect(reply.validatedAnchors).toHaveLength(2)
    for (const item of items)
      expect(JSON.stringify(reply)).not.toContain(
        item.editAnchor!.readCapability,
      )
    const compact = reply.result.results[0]
    expect('content' in compact && compact.content).toBeUndefined()
    expect('rawSourceContent' in compact && compact.rawSourceContent).toBe(
      rawSource,
    )
    const restored = await childFor(reply).requestFiles(params)
    expect(readFilesResultV1Schema.safeParse(restored).success).toBe(true)
    for (let index = 0; index < restored.results.length; index++) {
      const item = restored.results[index] as Item
      expect(authenticateReadFilesItem(item, issuer)).toBeDefined()
      expect(item.editAnchor!.rawBasis).toEqual(
        items[index]!.editAnchor!.rawBasis,
      )
      if (item.selector === 'file')
        expect(item.rawSourceContent).toBe(rawSource)
      else {
        expect(item.sourceContent).toBe('\uFEFFselected')
        expect(
          item.content!.split(item.editAnchor!.readCapability),
        ).toHaveLength(4)
        expect(item.content!.split('\n').slice(1).join('\n')).toBe(
          items[index]!.content!.split('\n').slice(1).join('\n'),
        )
      }
    }
  })

  const badObservations: [string, (item: Item) => void][] = [
    [
      'missing anchor',
      (item) => {
        delete item.editAnchor
      },
    ],
    [
      'legacy authenticated v3 plus unsigned basis',
      (item) => {
        const a = item.editAnchor!
        a.readCapability = encodeReadCapabilityToken({
          startLine: a.startLine,
          endLine: a.endLine,
          hash: a.contentHash,
          scope: { ...issuer, path: item.path },
        })
      },
    ],
    [
      'unsigned token',
      (item) => {
        item.editAnchor!.readCapability = 'cap.v4.unsigned.unsigned'
      },
    ],
    [
      'wrong issuer',
      (item) => {
        item.editAnchor = makeItems({ ...issuer, runId: 'sibling-run' })[
          item.requestIndex
        ]!.editAnchor
      },
    ],
    [
      'wrong path',
      (item) => {
        item.path = 'other.ts'
      },
    ],
    [
      'wrong normalized hash',
      (item) => {
        item.editAnchor!.contentHash = getContentHash('drift')
      },
    ],
    [
      'wrong bounds',
      (item) => {
        item.editAnchor!.endLine++
      },
    ],
    [
      'unsigned basis drift',
      (item) => {
        item.editAnchor!.rawBasis = {
          ...item.editAnchor!.rawBasis!,
          generation: 'forged-generation',
        }
      },
    ],
    [
      'partial status',
      (item) => {
        item.status = 'partial'
      },
    ],
    [
      'incomplete source',
      (item) => {
        item.complete = false
      },
    ],
    [
      'metadata incomplete',
      (item) => {
        item.metadataComplete = false
      },
    ],
    [
      'wrong request index',
      (item) => {
        item.requestIndex += 4
      },
    ],
    [
      'source drift',
      (item) => {
        if (item.selector === 'file') item.rawSourceContent += 'drift'
        else item.sourceContent += 'drift'
      },
    ],
    [
      'missing raw source',
      (item) => {
        if (item.selector === 'file') delete item.rawSourceContent
        else delete item.sourceContent
      },
    ],
  ]
  for (const [name, mutate] of badObservations) {
    test(`parent refuses ${name} on whole and range reads`, async () => {
      const items = makeItems()
      items.forEach(mutate)
      const reply = await wrapped(items)
      expect(reply.validatedAnchors).toHaveLength(0)
      expectDisplayOnly(await childFor(reply).requestFiles(params))
    })
  }

  test('returned range bounds must correlate to the requested range', async () => {
    const wrongRequest = {
      ...params,
      ranges: [{ path: 'file.ts', startLine: 1, endLine: 1 }],
    }
    const reply = await wrapped(makeItems(), wrongRequest)
    expect(reply.validatedAnchors.map((proof) => proof.itemIndex)).toEqual([0])
    const forged = await wrapped()
    const result = await childFor(forged).requestFiles(wrongRequest)
    expect(
      'editAnchor' in result.results[1]! && result.results[1]!.editAnchor,
    ).toBeFalsy()
  })

  test('no project pin, unissued run IDs, empty host run IDs and sibling tables grant no authority', async () => {
    for (const options of [
      { bridgeNonce },
      { bridgeNonce, readCapabilityProjectId: issuer.projectId },
    ]) {
      const table = hostTable(undefined, options)
      const reply = (await table.requestFiles!(
        params,
      )) as ParentValidatedReadFilesResponse
      expect(reply.validatedAnchors).toHaveLength(0)
      expectDisplayOnly(await childFor(reply).requestFiles(params))
    }
    const table = hostTable(
      undefined,
      { bridgeNonce, readCapabilityProjectId: issuer.projectId },
      async () => '',
    )
    await table.startAgentRun!({})
    expect(
      ((await table.requestFiles!(params)) as ParentValidatedReadFilesResponse)
        .validatedAnchors,
    ).toHaveLength(0)
    const sibling = hostTable(undefined, {
      bridgeNonce,
      readCapabilityProjectId: issuer.projectId,
    })
    await sibling.startAgentRun!({})
    const unstarted = hostTable(undefined, {
      bridgeNonce,
      readCapabilityProjectId: issuer.projectId,
    })
    expect(
      (
        (await unstarted.requestFiles!(
          params,
        )) as ParentValidatedReadFilesResponse
      ).validatedAnchors,
    ).toHaveLength(0)
  })

  test('host-returned run IDs enable reads for their pinned project and descendants', async () => {
    let starts = 0
    const table = hostTable(
      async (request) => makeResult(makeItems(request.capabilityIssuer!)),
      { bridgeNonce, readCapabilityProjectId: issuer.projectId },
      async () => `host-start-${++starts}`,
    )
    for (let index = 1; index <= 2; index++) {
      const runId = await table.startAgentRun!({ agentId: `agent-${index}` })
      expect(runId).toBe(`host-start-${index}`)
      const request = {
        ...params,
        capabilityIssuer: { ...issuer, runId: runId as string },
      }
      expect(
        (
          (await table.requestFiles!(
            request,
          )) as ParentValidatedReadFilesResponse
        ).validatedAnchors,
      ).toHaveLength(2)
      const wrongProject = {
        ...request,
        capabilityIssuer: {
          ...request.capabilityIssuer,
          projectId: '/other-project',
        },
      }
      expect(
        (
          (await table.requestFiles!(
            wrongProject,
          )) as ParentValidatedReadFilesResponse
        ).validatedAnchors,
      ).toHaveLength(0)
    }
  })

  const badWrappers: [
    string,
    (reply: ParentValidatedReadFilesResponse) => unknown,
  ][] = [
    ['nonce mismatch', (reply) => ({ ...reply, bridgeNonce: 'foreign' })],
    [
      'issuer mismatch',
      (reply) => ({ ...reply, issuer: { ...issuer, runId: 'foreign' } }),
    ],
    [
      'extra wrapper claims',
      (reply) => ({ ...reply, readCapability: 'foreign' }),
    ],
    [
      'duplicate proofs',
      (reply) => ({
        ...reply,
        validatedAnchors: [
          ...reply.validatedAnchors,
          ...reply.validatedAnchors,
        ],
      }),
    ],
    ['null proof', (reply) => ({ ...reply, validatedAnchors: [null] })],
    [
      'malformed proof',
      (reply) => ({ ...reply, validatedAnchors: [{ itemIndex: '0' }] }),
    ],
    [
      'extra proof field',
      (reply) => ({
        ...reply,
        validatedAnchors: reply.validatedAnchors.map((proof) => ({
          ...proof,
          readCapability: 'foreign',
        })),
      }),
    ],
    [
      'extra anchor field',
      (reply) => ({
        ...reply,
        validatedAnchors: reply.validatedAnchors.map((proof) => ({
          ...proof,
          anchor: { ...proof.anchor, readCapability: 'foreign' },
        })),
      }),
    ],
    [
      'tampered raw basis',
      (reply) => ({
        ...reply,
        validatedAnchors: reply.validatedAnchors.map((proof) => ({
          ...proof,
          anchor: {
            ...proof.anchor,
            rawBasis: { ...proof.anchor.rawBasis, version: 3 },
          },
        })),
      }),
    ],
    [
      'tampered transported source',
      (reply) => {
        const whole = reply.result.results[0] as Item
        if (whole.selector === 'file') whole.rawSourceContent += '!'
        const range = reply.result.results[1] as Item
        if (range.selector === 'range') range.sourceContent += '!'
        return reply
      },
    ],
  ]
  for (const [name, tamper] of badWrappers) {
    test(`child refuses ${name} without failing read-only display`, async () => {
      const result = await childFor(tamper(await wrapped())).requestFiles(
        params,
      )
      expectDisplayOnly(result)
      expect(
        'content' in result.results[0]! && typeof result.results[0]!.content,
      ).toBe('string')
    })
  }

  test('raw/legacy replies and missing child nonce remain display-only, including unsigned header copies', async () => {
    const raw = makeResult()
    const range = raw.results[1] as Item
    if (range.selector === 'range')
      range.content =
        '[RANGE_BLOCK readCapability=unsigned; readCapability: "unsigned"; basedOnRead="unsigned"]\nsource'
    expectDisplayOnly(await childFor(raw).requestFiles(params))
    // Explicitly omit options: a missing child-owned nonce must fail closed.
    const client = {
      call: async () => wrapped(),
    } as unknown as ChildBridgeClient
    expectDisplayOnly(await buildBridgedChildDeps(client).requestFiles(params))
  })

  test('separate child process rejects parent HMACs, remints local v4 scopes and preserves raw provenance', async () => {
    // Unix socket paths have a small platform limit; the evidence-owned TMPDIR
    // is intentionally deep, so use a fresh short owned directory for this RPC.
    const dir = mkdtempSync('/tmp/b05-raw-bridge-')
    let starts = 0
    const table = hostTable(
      async (request) => makeResult(makeItems(request.capabilityIssuer!)),
      { bridgeNonce, readCapabilityProjectId: issuer.projectId },
      async () => `host-process-${++starts}`,
    )
    const server = startParentBridgeServer(table, join(dir, 'rpc.sock'))
    await server.ready
    const base = join(import.meta.dir, 'fixtures')
    const parentTokens = makeItems().map(
      (item) => item.editAnchor!.readCapability,
    )
    const childArgv = [
      process.execPath,
      '--no-env-file',
      '--preload',
      join(base, 'b05-child-network-guard.ts'),
      join(base, 'b05-child-read-worker.ts'),
      join(dir, 'rpc.sock'),
      bridgeNonce,
      issuer.projectId,
      JSON.stringify(parentTokens),
    ]
    const child = Bun.spawn(childArgv, {
      env: {
        ...process.env,
        B05_BRIDGE_NETWORK_TRACE:
          process.env.B05_BRIDGE_NETWORK_TRACE ?? join(dir, 'network'),
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const timer = setTimeout(() => child.kill(), 10_000)
    try {
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      const trace = process.env.B05_BRIDGE_NETWORK_TRACE
      if (trace) {
        const artifact = `${trace}.child-${child.pid}`
        writeFileSync(`${artifact}.stdout.log`, stdout, { flag: 'wx' })
        writeFileSync(`${artifact}.stderr.log`, stderr, { flag: 'wx' })
        writeFileSync(
          `${artifact}.execution.json`,
          JSON.stringify(
            {
              argv: childArgv,
              cwd: process.cwd(),
              processId: child.pid,
              exitCode: code,
              stdout: `${artifact}.stdout.log`,
              stderr: `${artifact}.stderr.log`,
              sourceBinding:
                'Parent command sourceBefore/sourceAfter includes this child worker and all imported source.',
              accepted: false,
              independentApproval: false,
            },
            null,
            2,
          ) + '\n',
          { flag: 'wx' },
        )
      }
      expect({ code, stderr }).toEqual({ code: 0, stderr: '' })
      const report = JSON.parse(stdout) as {
        parentTokensRejected: boolean[]
        results: {
          runId: string
          result: ReadFilesResultV1
          authenticated: boolean[]
          localScopes: boolean[]
        }[]
      }
      expect(report.parentTokensRejected).toEqual([true, true])
      expect(report.results.map((result) => result.runId)).toEqual([
        'host-process-1',
        'host-process-2',
      ])
      for (const run of report.results) {
        expect(run.authenticated).toEqual([true, true])
        expect(run.localScopes).toEqual([true, true])
        expect(readFilesResultV1Schema.safeParse(run.result).success).toBe(true)
        for (const item of run.result.results as Item[]) {
          expect(
            typeof decodeReadCapabilityToken(item.editAnchor!.readCapability),
          ).toBe('string')
          expect(item.editAnchor!.rawBasis).toEqual(
            makeItems()[item.requestIndex]!.editAnchor!.rawBasis,
          )
        }
      }
    } finally {
      clearTimeout(timer)
      child.kill()
      await child.exited
      await server.close()
      rmSync(dir, { recursive: true, force: true })
    }
  }, 15_000)
})

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { BunSQLiteMemoryRepository } from '../../../cli/src/services/memory-v2/bun-sqlite-memory-repository'
import { runMemoryRestartFixture } from '../../../test/fixtures/body/memory-restart'

// Repeat the actual producer/fresh consumer, then time only direct page reads
// of that exact retained archive. Provider/compaction/startup waits are not
// included in page-read latency. All measured bytes are owned fixture data.
const root = path.resolve(import.meta.dir, '../../..')
const output = path.resolve(process.argv[2] ?? '')
assert(process.argv.length === 3 && output.startsWith(path.join(root, '.tmp') + path.sep))
fs.mkdirSync(output, { mode: 0o700 })
const privateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'openbuff-b13-timing-'))
const manifest = path.join(root, 'test/fixtures/body/toolchain-manifest.json')
const digest = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')
const selected = JSON.parse(fs.readFileSync(manifest, 'utf8')).tools.bun
assert.equal(Bun.version, selected.expectedVersion)
assert.equal(digest(fs.readFileSync(fs.realpathSync(process.execPath))), selected.expectedSha256ByHost[`${process.platform}-${process.arch}`])
try {
  const receipt = await runMemoryRestartFixture({ root: privateRoot, evidenceDir: output, manifest })
  assert.equal(receipt.status, 'local-verified')
  assert.equal(receipt.originalResults, 30)
  assert.equal(receipt.externalProviderRequests, 0)
  const openedAt = performance.now()
  const opened = await BunSQLiteMemoryRepository.open({
    repositoryRoot: privateRoot,
    contextArchiveRetention: { mode: 'rolling', maxBytes: 4 * 1024 * 1024 },
  })
  const reopenMs = performance.now() - openedAt
  assert(opened.status === 'ok')
  const pages: Array<{ callId: string; start: number; bytes: number; elapsedMs: number; sha256: string }> = []
  const bodies: Array<{ callId: string; bytes: number; sha256: string }> = []
  const repository = opened.repository
  try {
    for (const call of receipt.calls) {
      let cursor = 0
      const chunks: Buffer[] = []
      while (cursor < 32768) {
        const started = performance.now()
        const page = await repository.readContextArchiveBodyPage({
          toolCallId: call.toolCallId, sourceRunId: call.sourceRunId,
          expectedSha256: call.expectedSha256, offsetBytes: cursor, maxBytes: 4096,
        })
        const elapsedMs = performance.now() - started
        assert(page.status === 'ok', JSON.stringify(page))
        assert.equal(page.startByte, cursor)
        assert.equal(page.sha256, call.expectedSha256)
        const bytes = Buffer.from(page.text)
        assert(bytes.length > 0 && bytes.length <= 4096)
        assert.equal(page.endByte, cursor + bytes.length)
        chunks.push(bytes)
        pages.push({ callId: call.toolCallId, start: cursor, bytes: bytes.length, elapsedMs, sha256: page.sha256 })
        cursor = page.endByte
        assert.equal(page.nextOffset, cursor === 32768 ? null : cursor)
      }
      const body = Buffer.concat(chunks)
      assert.equal(body.length, 32768)
      assert.equal(digest(body), call.expectedSha256)
      bodies.push({ callId: call.toolCallId, bytes: body.length, sha256: call.expectedSha256 })
    }
  } finally {
    await repository.close()
  }
  assert.equal(pages.length, 240)
  assert.equal(bodies.length, 30)
  const samples = pages.map((p) => p.elapsedMs).sort((a, b) => a - b)
  const report = { schemaVersion: 1, acceptance: false,
    scope: 'Real persistent archive read latencies on the rebuilt owned B13 fixture, separated from model/compaction/startup; observations not a performance SLA.',
    restartReceiptSha256: digest(fs.readFileSync(path.join(output, 'receipt.json'))),
    reopenMs, pages: pages.length, bodies: bodies.length,
    medianPageMs: samples[Math.floor(samples.length / 2)], maxPageMs: samples.at(-1),
    perPage: pages, verifiedBodies: bodies,
  }
  fs.writeFileSync(path.join(output, 'latency.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  console.log(JSON.stringify({ pages: report.pages, bodies: report.bodies, reopenMs, medianPageMs: report.medianPageMs, maxPageMs: report.maxPageMs }))
} finally {
  fs.rmSync(privateRoot, { recursive: true, force: true })
}

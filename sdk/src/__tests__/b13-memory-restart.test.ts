import { expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runMemoryRestartFixture } from '../../../test/fixtures/body/memory-restart'

test('B13 actual tool outputs → three production compactions → SQLite → fresh SDK first request and original pages', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openbuff-b13-e2e-'))
  const home = process.env.HOME
  try {
    const report = await runMemoryRestartFixture({
      root,
      evidenceDir: process.env.OPENBUFF_TEST_B13_EVIDENCE_DIR,
    })
    expect(report.status).toBe('local-verified')
    expect(report.originalResults).toBe(30)
    expect(report.customCalls).toBe(30)
    expect(report.chronologicalMessages).toBe(200)
    expect(report.compactions).toBe(3)
    expect(report.factualScore).toBe(1)
    expect(report.identifierScore).toBe(1)
    expect(report.retention!.logicalBytes).toBeLessThanOrEqual(4 * 1024 * 1024)
    expect(report.externalProviderRequests).toBe(0)
    expect(report.homeUnchanged).toBe(true)
    expect(process.env.HOME).toBe(home)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}, 90_000)

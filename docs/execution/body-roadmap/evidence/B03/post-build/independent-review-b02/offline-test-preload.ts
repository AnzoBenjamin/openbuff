import { afterAll } from 'bun:test'
import fs from 'node:fs'
const log = process.env.B03_INDEPENDENT_FETCH_LOG
if (!log) throw new Error('Missing owned B03 fetch log')
let refused = 0
const record = (event: string) => fs.appendFileSync(log, JSON.stringify({ event, pid: process.pid, refused, forwarded: 0 }) + '\n')
record('guard-installed-before-imports')
globalThis.fetch = Object.assign(async () => {
  refused++
  record('external-fetch-refused')
  throw new Error('Independent B03 fixture refused external fetch')
}, { preconnect() {} }) as typeof fetch
afterAll(() => {
  record('test-after-all')
  if (refused !== 0) throw new Error('Independent B03 test attempted external fetch')
})

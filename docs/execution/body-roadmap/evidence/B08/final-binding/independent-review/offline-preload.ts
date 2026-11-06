import fs from 'node:fs'

let refused = 0
const log = process.env.B08_INDEPENDENT_FETCH_LOG
const record = (event: string) => {
  if (log) fs.appendFileSync(log, JSON.stringify({ event, pid: process.pid, refused, forwarded: 0 }) + '\n')
}
record('guard-installed-before-imports')
globalThis.fetch = Object.assign(async () => {
  refused++
  record('external-fetch-refused')
  throw new Error('B08 independent review refuses external fetch')
}, { preconnect() {} }) as typeof fetch
process.on('exit', () => record('process-exit'))

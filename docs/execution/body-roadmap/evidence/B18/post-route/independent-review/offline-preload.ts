import fs from 'node:fs'
let refused = 0
const log = process.env.POST_ROUTE_FETCH_LOG!
const record = (event: string) => fs.appendFileSync(log, JSON.stringify({ event, pid: process.pid, refused, forwarded: 0 }) + '\n')
record('guard-installed-before-imports')
globalThis.fetch = Object.assign(async () => { refused++; record('external-fetch-refused'); throw new Error('Post-route independent review refuses external fetch') }, { preconnect() {} }) as typeof fetch
process.on('exit', () => record('process-exit'))

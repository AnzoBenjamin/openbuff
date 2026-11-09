import { writeFileSync } from 'node:fs'

export let fetchCalls = 0
const guardedFetch = Object.assign(
  async () => {
    fetchCalls++
    throw new Error('B05 bridge development must not dispatch network requests')
  },
  {
    preconnect: async () => {},
  }
) as typeof fetch
globalThis.fetch = guardedFetch
process.on('exit', () => {
  const trace = process.env.B05_BRIDGE_NETWORK_TRACE
  if (!trace) throw new Error('Missing owned B05 bridge network trace')
  writeFileSync(`${trace}.${process.pid}.json`, JSON.stringify({ fetchCalls }) + '\n')
  if (fetchCalls !== 0) process.exitCode = 1
})

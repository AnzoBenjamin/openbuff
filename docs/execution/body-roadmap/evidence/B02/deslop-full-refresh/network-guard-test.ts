import { afterAll } from 'bun:test'
import { writeFileSync } from 'node:fs'
let calls = 0
globalThis.fetch = async () => {
 calls++
 throw new Error('Deslop regression fixtures must not issue network requests')
}
afterAll(() => {
 const trace = process.env.MUTATION_FIXTURE_NETWORK_TRACE
 if (!trace) throw new Error('Missing owned test trace')
 writeFileSync(`${trace}.${process.pid}.json`, JSON.stringify({ fetchCalls: calls }) + '\n')
 if (calls !== 0) throw new Error('Deslop regression fixture attempted network dispatch')
})

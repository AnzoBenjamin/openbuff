const harness = require('./consumer-common.cjs')

async function main() {
  const state = harness.prepare('cjs')
  try {
    const resolved = require.resolve('@openbuff/sdk')
    const sdk = require('@openbuff/sdk')
    await harness.exercise(sdk, state, resolved)
  } catch (error) {
    state.failure = { message: String(error), stack: error?.stack }
  } finally {
    await harness.finish(state)
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })

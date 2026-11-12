import harness from './consumer-common.cjs'

const state = harness.prepare('esm')
try {
  const resolved = import.meta.resolve('@openbuff/sdk')
  const sdk = await import('@openbuff/sdk')
  await harness.exercise(sdk, state, resolved)
} catch (error) {
  state.failure = { message: String(error), stack: error?.stack }
} finally {
  await harness.finish(state)
}

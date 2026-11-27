import { prepare, run } from './consumer.cjs'
const context = prepare('esm', process.argv[2], process.argv[3])
try {
  await run(await import('@openbuff/sdk'), context)
} catch (error) {
  context.state.status = 'failed'; context.state.failure = error.stack ?? String(error)
  context.save(); context.restore(); console.error(error); process.exitCode = 1
}

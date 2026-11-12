const { prepare, run } = require('./consumer.cjs')
const context = prepare('cjs', process.argv[2], process.argv[3])
try {
  run(require('@openbuff/sdk'), context).catch(error => {
    context.state.status = 'failed'; context.state.failure = error.stack ?? String(error)
    context.save(); context.restore(); console.error(error); process.exitCode = 1
  })
} catch (error) {
  context.state.status = 'failed'; context.state.failure = error.stack ?? String(error)
  context.save(); context.restore(); console.error(error); process.exitCode = 1
}

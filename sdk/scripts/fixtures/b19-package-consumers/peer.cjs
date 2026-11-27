const fs = require('node:fs')
const [mode, output] = process.argv.slice(2)
const record = event => fs.appendFileSync(output, JSON.stringify({ at: Date.now(), pid: process.pid, ...event }) + '\n')
record({ event: 'start', mode })
process.on('exit', code => record({ event: 'exit', code }))
if (mode === 'env') {
  const names = ['PUBLIC_VALUE', 'DELETE_ME', 'OPENAI_API_KEY', 'CUSTOM_PROVIDER_KEY']
  record({ event: 'environment', values: Object.fromEntries(names.filter(name => process.env[name] !== undefined).map(name => [name, process.env[name]])) })
} else {
  setInterval(() => record({ event: 'heartbeat' }), 25)
  process.on('SIGTERM', () => { record({ event: 'signal', signal: 'SIGTERM' }); process.exit(0) })
}

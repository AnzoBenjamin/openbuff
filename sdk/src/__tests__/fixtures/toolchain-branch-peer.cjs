const fs = require('node:fs')
const path = require('node:path')

const argv = process.argv.slice(2)
const command = path.basename(process.argv[1])
const values = {}
for (const name of ['PATH', 'PROJECT_VALUE', 'DELETE_ME', 'OPENAI_API_KEY', 'CUSTOM_PROVIDER_KEY']) {
  if (process.env[name] !== undefined) values[name] = process.env[name]
}
fs.appendFileSync(process.env.B19_CHILD_TRACE, JSON.stringify({
  kind: 'actual-node-child', command, argv, cwd: process.cwd(), pid: process.pid, values,
}) + '\n')

if (command === 'cargo' && argv[0] === 'metadata') {
  process.stdout.write(JSON.stringify({ packages: [] }))
} else if (command === 'go' && argv[0] === 'list') {
  process.stdout.write(JSON.stringify({ ImportPath: 'fixture.test/toolchain', Dir: process.cwd() }))
} else if (command === 'semgrep' && argv[0] === 'scan') {
  process.stdout.write(JSON.stringify({ version: '2.1.0', runs: [] }))
} else if (argv[0] === 'index') {
  const output = argv[argv.indexOf('--output') + 1]
  fs.mkdirSync(path.dirname(output), { recursive: true })
  fs.writeFileSync(output, JSON.stringify({ documents: [] }))
} else {
  process.stdout.write('fixture 1.0.0')
}

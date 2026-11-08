const fs = require('node:fs')
const [destination, label, input] = process.argv.slice(2)
const observed = {
  pid: process.pid,
  label,
  content: input ? fs.readFileSync(input, 'utf8') : null,
  environment: Object.fromEntries(['PROJECT_VALUE', 'CUSTOM_PROVIDER_KEY', 'OPENAI_API_KEY', 'LANG']
    .filter(name => process.env[name] !== undefined).map(name => [name, process.env[name]])),
}
fs.writeFileSync(destination, JSON.stringify(observed))
process.stdout.write(label + '\n')

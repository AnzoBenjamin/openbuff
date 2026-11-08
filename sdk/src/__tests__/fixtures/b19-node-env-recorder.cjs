const fs = require('node:fs')

const observed = {
  value: process.env.PROJECT_VALUE,
  home: process.env.HOME,
  xdg: process.env.XDG_CONFIG_HOME,
  canonical: process.env.OPENAI_API_KEY,
  configured: process.env.CUSTOM_PROVIDER_KEY,
}
fs.writeFileSync(process.argv[2], JSON.stringify(observed))
process.stdout.write('output-sentinel')

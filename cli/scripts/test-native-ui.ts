import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

// Production React omits act(). Give each native suite its own development
// runtime and configuration so module mocks cannot leak between files.
const cliRoot = path.resolve(import.meta.dir, '..')
const output = mkdtempSync(path.join(tmpdir(), 'openbuff-native-ui-'))
const suites = [...new Bun.Glob('src/**/*.test.tsx').scanSync({ cwd: cliRoot })]
  .sort()
  .filter((file) => {
    const source = readFileSync(path.join(cliRoot, file), 'utf8')
    return (
      source.includes('production') &&
      source.includes('skip') &&
      (source.includes('React.act') || source.includes('testRender'))
    )
  })
if (!suites.length) throw new Error('No native UI suites discovered')

const receipts = suites.map((file, index) => {
  const config = mkdtempSync(path.join(tmpdir(), 'openbuff-native-config-'))
  try {
    const result = spawnSync(
      process.execPath,
      [
        'test',
        '--preload',
        path.join(cliRoot, 'scripts/preload-opentui.ts'),
        file,
      ],
      {
        cwd: cliRoot,
        env: {
          ...process.env,
          NODE_ENV: 'development',
          OPENBUFF_CONFIG_DIR: config,
        },
        encoding: 'utf8',
        timeout: 90_000,
        maxBuffer: 16 * 1024 * 1024,
      },
    )
    const log = (result.stdout ?? '') + (result.stderr ?? '')
    const logName = `${index + 1}-${path.basename(file)}.log`
    writeFileSync(path.join(output, logName), log)
    const count = (name: string) =>
      Number(log.match(new RegExp(`^\\s*(\\d+) ${name}\\s*$`, 'm'))?.[1] ?? 0)
    const row = {
      file,
      exitCode: result.status,
      error: result.error?.message,
      pass: count('pass'),
      skip: count('skip'),
      fail: count('fail'),
      log: logName,
    }
    console.log(
      `${index + 1}/${suites.length} ${file}: ${row.pass} pass, ${row.skip} skip, ${row.fail} fail`,
    )
    return row
  } finally {
    rmSync(config, { recursive: true, force: true })
  }
})
const totals = { pass: 0, skip: 0, fail: 0 }
for (const row of receipts) {
  totals.pass += row.pass
  totals.skip += row.skip
  totals.fail += row.fail
}
writeFileSync(
  path.join(output, 'summary.json'),
  JSON.stringify({ runtime: Bun.version, receipts, totals }, null, 2) + '\n',
)
console.log(JSON.stringify({ output, suites: suites.length, totals }))
if (
  receipts.some(
    (row) =>
      row.exitCode !== 0 || row.fail > 0 || row.pass === 0 || row.skip > 0,
  )
)
  process.exit(1)

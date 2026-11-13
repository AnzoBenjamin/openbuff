import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

test('compiled directory watcher delivers changes without a source-file worker', () => {
  const directory = mkdtempSync(join(tmpdir(), 'openbuff-index-watch-binary-'))
  const source = join(directory, 'probe.ts')
  const binary = join(
    directory,
    process.platform === 'win32' ? 'probe.exe' : 'probe',
  )
  const modulePath = resolve(import.meta.dir, '../index-dir-watch.ts').replace(
    /\\/g,
    '/',
  )
  writeFileSync(
    source,
    `
import { startDirectoryIndexWatch } from ${JSON.stringify(modulePath)};
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
let observed = false;
let failed = false;
const handle = startDirectoryIndexWatch({
  projectRoot: process.cwd(),
  onRawEvent: event => { if (event.fileName === 'changed.txt') observed = true; },
  onDegrade: () => { failed = true; },
  onWarn: (_data, message) => { failed = true; console.error(message); },
});
try {
  const deadline = Date.now() + 5000;
  for (let tick = 0; !observed && !failed && Date.now() < deadline; tick++) {
    writeFileSync(join(process.cwd(), 'changed.txt'), String(tick));
    await Bun.sleep(25);
  }
  if (observed && !failed) console.log('compiled index watcher ok');
  else process.exitCode = 1;
} finally {
  handle.close();
}
`,
  )
  try {
    const built = spawnSync(
      process.execPath,
      ['build', '--compile', source, '--outfile', binary],
      {
        cwd: directory,
        encoding: 'utf8',
        timeout: 15_000,
      },
    )
    expect(built.error).toBeUndefined()
    if (built.status !== 0)
      throw new Error(
        `Watcher probe build failed: ${built.stdout}\n${built.stderr}`,
      )
    expect(built.status).toBe(0)
    const ran = spawnSync(binary, [], {
      cwd: directory,
      encoding: 'utf8',
      timeout: 10_000,
    })
    expect(ran.error).toBeUndefined()
    expect(ran.status).toBe(0)
    expect(ran.stdout).toContain('compiled index watcher ok')
    expect(ran.stderr).not.toContain('worker crashed')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}, 30_000)

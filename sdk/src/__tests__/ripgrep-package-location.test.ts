import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, test } from 'bun:test'

import { getBundledRgPath } from '../native/ripgrep'

for (const format of ['cjs', 'esm'] as const) {
  for (const callerUrl of [false, true]) {
    test(`installed ${format} resolves its own ripgrep from unrelated cwd${callerUrl ? ' and caller URL' : ''}`, async () => {
      const root = mkdtempSync(path.join(tmpdir(), 'rg-package-location-'))
      try {
        const dist = path.join(
          root,
          'installation/node_modules/@openbuff/sdk/dist',
        )
        const cwd = path.join(root, 'unrelated-project')
        mkdirSync(dist, { recursive: true })
        mkdirSync(cwd)
        const extension = format === 'cjs' ? 'cjs' : 'mjs'
        const bundled = await Bun.build({
          entrypoints: [path.resolve(import.meta.dir, '../native/ripgrep.ts')],
          outdir: dist,
          naming: `index.${extension}`,
          target: 'node',
          format,
          env: 'disable',
          ...(format === 'cjs'
            ? {
                define: {
                  'import.meta.url': 'undefined',
                  'import.meta': 'undefined',
                },
              }
            : {}),
        })
        expect(bundled.success).toBe(true)
        const source = getBundledRgPath(undefined, {})
        const relative = path.join(
          'vendor/ripgrep',
          path.basename(path.dirname(source)),
          path.basename(source),
        )
        const expected = path.join(dist, relative)
        mkdirSync(path.dirname(expected), { recursive: true })
        copyFileSync(source, expected)
        // A cwd-relative legacy package must not override the owning package.
        const legacy = path.join(
          cwd,
          'node_modules/@codebuff/sdk/dist',
          relative,
        )
        mkdirSync(path.dirname(legacy), { recursive: true })
        copyFileSync(source, legacy)
        const caller = path.join(cwd, 'caller.mjs')
        writeFileSync(caller, '')
        const entry = path.join(dist, `index.${extension}`)
        const load =
          format === 'cjs'
            ? 'const sdk = require(process.argv[1]);'
            : 'const sdk = await import(process.argv[1]);'
        const script = `${load} console.log(JSON.stringify(sdk.getBundledRgPath(process.argv[2] || undefined, {})));`
        const result = spawnSync(
          process.env.BODY_NODE ?? 'node',
          [
            ...(format === 'esm' ? ['--input-type=module'] : []),
            '-e',
            script,
            format === 'esm' ? pathToFileURL(entry).href : entry,
            callerUrl ? pathToFileURL(caller).href : '',
          ],
          {
            cwd,
            env: { PATH: process.env.PATH, NEXT_PUBLIC_CB_ENVIRONMENT: 'test' },
            encoding: 'utf8',
            timeout: 10_000,
          },
        )
        expect(result.error).toBeUndefined()
        expect(result.status).toBe(0)
        expect(JSON.parse(result.stdout.trim().split('\n').at(-1)!)).toBe(
          expected,
        )
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }, 15_000)
  }
}

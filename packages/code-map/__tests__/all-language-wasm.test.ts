import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

import { PINNED_GRAMMAR_ASSETS } from '../src/grammar-wasm-repair'
import { getLanguageConfig, languageTable, setWasmDir } from '../src/languages'

describe('packaged language WASM coverage', () => {
  let wasmDir: string

  beforeAll(() => {
    wasmDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openbuff-all-wasm-'))
    const repoRoot = path.resolve(import.meta.dir, '../../..')
    for (const config of languageTable) {
      const sourceName =
        config.wasmFile === 'tree-sitter-c-sharp.wasm'
          ? 'tree-sitter-c_sharp.wasm'
          : config.wasmFile
      const primary = path.join(
        repoRoot,
        'node_modules',
        'tree-sitter-wasms',
        'out',
        sourceName,
      )
      const fallback = path.join(
        repoRoot,
        'node_modules',
        '@vscode',
        'tree-sitter-wasm',
        'wasm',
        config.wasmFile,
      )
      // The GDScript grammar is built from its pinned source; neither
      // dependency publishes it. The SDK build retains those verified bytes.
      const built = path.join(repoRoot, 'sdk', 'dist', 'wasm', config.wasmFile)
      const source = [primary, fallback, built].find((file) =>
        fs.existsSync(file),
      )
      if (!source)
        throw new Error(
          `Missing ${config.wasmFile}; build the SDK assets before this packaging check`,
        )
      if (source === built) {
        expect(
          createHash('sha256').update(fs.readFileSync(source)).digest('hex'),
        ).toBe(PINNED_GRAMMAR_ASSETS[config.wasmFile].sha256)
      }
      fs.copyFileSync(source, path.join(wasmDir, config.wasmFile))
    }
    setWasmDir(wasmDir)
  })

  afterAll(() => {
    setWasmDir('')
    fs.rmSync(wasmDir, { recursive: true, force: true })
  })

  for (const config of languageTable) {
    const extension = config.extensions[0]
    test(`loads parser and query for ${extension}`, async () => {
      const loaded = await getLanguageConfig(`fixture${extension}`)
      expect(loaded?.parser).toBeDefined()
      expect(loaded?.query).toBeDefined()
    })
  }
})

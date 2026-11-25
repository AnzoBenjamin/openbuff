import * as fs from 'node:fs'
import * as path from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'

import { afterEach, expect, test } from 'bun:test'

import {
  getLanguageConfig,
  getParserExtractionFingerprint,
  getWasmDir,
  languageTable,
  setWasmDir,
} from '../languages'
import { getFileTokenScores } from '../parse'

const nodeRequire = createRequire(import.meta.url)
const sourceGrammar = nodeRequire.resolve(
  '@vscode/tree-sitter-wasm/wasm/tree-sitter-typescript.wasm',
)
const config = languageTable.find((entry) => entry.extensions.includes('.ts'))!
const original = {
  ...config,
  parser: config.parser,
  language: config.language,
  query: config.query,
  extractionIdentity: config.extractionIdentity,
}
const originalWasmDir = getWasmDir()
const directories: string[] = []

afterEach(() => {
  Object.assign(config, original)
  setWasmDir(originalWasmDir ?? '')
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true })
})

function temporaryGrammar(): { directory: string; wasm: string } {
  const directory = fs.mkdtempSync(
    path.join(tmpdir(), 'openbuff-parser-identity-'),
  )
  directories.push(directory)
  const wasm = path.join(directory, config.wasmFile)
  setWasmDir(directory)
  config.parser = undefined
  config.language = undefined
  config.query = undefined
  return { directory, wasm }
}

test('missing primary grammar fingerprints the package fallback bytes', async () => {
  const { wasm } = temporaryGrammar()
  const fallback = getParserExtractionFingerprint('sample.ts')
  const parsed = await getFileTokenScores(
    '/virtual',
    ['sample.ts'],
    () => 'export function fallbackIdentity() {}\n',
  )
  expect(parsed.parsed['sample.ts']?.extractionFingerprint).toBe(fallback)
  fs.copyFileSync(sourceGrammar, wasm)
  expect(getParserExtractionFingerprint('sample.ts')).toBe(fallback)
})

test('removing the only grammar asset retains identified in-memory bytes until replacement', async () => {
  const { directory } = temporaryGrammar()
  config.wasmFile = 'temporary-typescript.wasm'
  const wasm = path.join(directory, config.wasmFile)
  fs.copyFileSync(sourceGrammar, wasm)
  const loaded = await getLanguageConfig('memory.ts')
  const parser = loaded!.parser
  const fingerprint = getParserExtractionFingerprint('memory.ts')
  fs.unlinkSync(wasm)
  expect(getParserExtractionFingerprint('memory.ts')).toBe(fingerprint)
  expect((await getLanguageConfig('memory.ts'))!.parser).toBe(parser)
  const parsed = await getFileTokenScores(
    '/virtual',
    ['memory.ts'],
    () => 'export function retainedGrammar() {}\n',
  )
  expect(parsed.parsed['memory.ts']?.identifiers).toContain('retainedGrammar')
  expect(parsed.parsed['memory.ts']?.extractionFingerprint).toBe(fingerprint)
  fs.writeFileSync(
    wasm,
    Buffer.concat([fs.readFileSync(sourceGrammar), Buffer.from([0, 1, 0])]),
  )
  expect(getParserExtractionFingerprint('memory.ts')).not.toBe(fingerprint)
  expect((await getLanguageConfig('memory.ts'))!.parser).not.toBe(parser)
})

test('grammar and query replacement invalidate loaded assets and preserve per-parse identity', async () => {
  const { directory, wasm } = temporaryGrammar()
  fs.copyFileSync(sourceGrammar, wasm)
  const queryPath = path.join(directory, 'tags.scm')
  fs.writeFileSync(queryPath, '(identifier) @identifier')
  config.queryPathOrContent = queryPath
  const firstConfig = await getLanguageConfig('sample.ts')
  const firstParser = firstConfig!.parser
  const firstQuery = firstConfig!.query
  const firstFingerprint = getParserExtractionFingerprint('sample.ts')
  const first = await getFileTokenScores(
    '/virtual',
    ['sample.ts'],
    () => 'export function alpha() { beta() }\n',
  )
  expect(first.parsed['sample.ts']?.identifiers).toContain('alpha')
  expect(first.parsed['sample.ts']?.extractionFingerprint).toBe(
    firstFingerprint,
  )

  const stat = fs.statSync(queryPath)
  fs.writeFileSync(queryPath, '(identifier) @call.identifier')
  fs.utimesSync(queryPath, stat.atime, stat.mtime)
  const queryFingerprint = getParserExtractionFingerprint('sample.ts')
  expect(queryFingerprint).not.toBe(firstFingerprint)
  const changedQueryConfig = await getLanguageConfig('sample.ts')
  expect(changedQueryConfig!.parser).toBe(firstParser)
  expect(changedQueryConfig!.query).not.toBe(firstQuery)
  const changedQuery = await getFileTokenScores(
    '/virtual',
    ['sample.ts'],
    () => 'export function alpha() { beta() }\n',
  )
  expect(changedQuery.parsed['sample.ts']?.calls).toContain('beta')
  expect(changedQuery.parsed['sample.ts']?.extractionFingerprint).toBe(
    queryFingerprint,
  )
  expect(first.parsed['sample.ts']?.extractionFingerprint).toBe(
    firstFingerprint,
  )

  // Add a valid empty custom WASM section; semantics remain usable while the bytes change.
  fs.appendFileSync(wasm, Buffer.from([0, 1, 0]))
  const grammarFingerprint = getParserExtractionFingerprint('sample.ts')
  expect(grammarFingerprint).not.toBe(queryFingerprint)
  const changedGrammarConfig = await getLanguageConfig('sample.ts')
  expect(changedGrammarConfig!.parser).toBeDefined()
  expect(changedGrammarConfig!.parser).not.toBe(firstParser)
  const changedGrammar = await getFileTokenScores(
    '/virtual',
    ['sample.ts'],
    () => 'export function alpha() { beta() }\n',
  )
  expect(changedGrammar.parsed['sample.ts']?.extractionFingerprint).toBe(
    grammarFingerprint,
  )
})

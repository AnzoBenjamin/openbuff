import * as os from 'node:os'
import * as path from 'node:path'

import { describe, expect, test } from 'bun:test'

import { getWasmDir, setWasmDir } from '../src/languages'

describe('P8.7 setWasmDir verbatim storage contract', () => {
  test('stores an absolute directory verbatim and clears on empty string', () => {
    const dir = path.join(os.tmpdir(), 'openbuff-wasm-dir-valid')
    setWasmDir(dir)
    expect(getWasmDir()).toBe(dir)
    setWasmDir('')
    expect(getWasmDir()).toBeUndefined()
  })

  test('stores relative and traversal-containing directories verbatim', () => {
    // The public contract stores any caller-supplied directory verbatim;
    // relative directories resolve against the process cwd at grammar-load
    // time. Silently dropping them (back to the default location) would be a
    // breaking change with no error or returned status.
    const previous = getWasmDir()
    try {
      setWasmDir('relative/wasm')
      expect(getWasmDir()).toBe('relative/wasm')
      setWasmDir('/tmp/../escape')
      expect(getWasmDir()).toBe('/tmp/../escape')
    } finally {
      setWasmDir(previous ?? '')
    }
  })
})

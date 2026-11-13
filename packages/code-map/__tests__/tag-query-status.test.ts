import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { describe, expect, it } from 'bun:test'

import { getFileTokenScores } from '../src/parse'
import { getTagQueryStatus, TAG_QUERY_FILES } from '../src/languages'

const queriesDir = path.join(__dirname, '..', 'src', 'tree-sitter-queries')

describe('getTagQueryStatus (N09)', () => {
  it('lists exactly the .scm files the package ships', () => {
    const shipped = fs
      .readdirSync(queriesDir)
      .filter((name) => name.endsWith('.scm'))
      .sort()
    expect([...TAG_QUERY_FILES].sort()).toEqual(shipped)
  })

  it('reports every query available in the source tree', () => {
    const status = getTagQueryStatus()
    expect(status.total).toBe(TAG_QUERY_FILES.length)
    expect(status.missing).toEqual([])
    expect(status.available).toHaveLength(status.total)
  })

  it('reports every query missing when no candidate path exists', () => {
    const status = getTagQueryStatus({ exists: () => false })
    expect(status.available).toEqual([])
    expect([...status.missing].sort()).toEqual([...TAG_QUERY_FILES].sort())
  })

  it('reports a partial install', () => {
    const status = getTagQueryStatus({
      exists: (candidate) => !candidate.endsWith('tree-sitter-rust-tags.scm'),
    })
    expect(status.missing).toEqual(['tree-sitter-rust-tags.scm'])
  })
})

describe('TS fixture symbols, calls and imports', () => {
  it('extracts non-empty identifiers, calls and imports', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'code-map-n09-'))
    try {
      fs.writeFileSync(
        path.join(root, 'util.ts'),
        'export function greet(name: string) { return `hi ${name}` }\n',
      )
      fs.writeFileSync(
        path.join(root, 'main.ts'),
        "import { greet } from './util'\nexport class App { run() { return greet('x') } }\n",
      )
      const { parsed } = await getFileTokenScores(root, ['util.ts', 'main.ts'])
      expect(parsed['util.ts']?.identifiers).toContain('greet')
      expect(parsed['main.ts']?.identifiers).toContain('App')
      expect(parsed['main.ts']?.calls).toContain('greet')
      expect(parsed['main.ts']?.imports?.length ?? 0).toBeGreaterThan(0)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

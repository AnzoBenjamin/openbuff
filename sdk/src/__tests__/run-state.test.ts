import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'fs'
import os from 'os'
import path from 'path'

import {
  selectAlwaysOnInstructionFiles,
  selectNestedInstructionFilesForPaths,
} from '@codebuff/common/util/instruction-files'

import { loadInstructionFiles } from '../instruction-files'
import { initialSessionState } from '../run-state'

// N08 (memory-context-04): every instruction file per directory, root to
// cwd, nested files for touched directories, and contained `@path` imports.

const silentLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

let root: string

function write(relative: string, content: string) {
  const absolute = path.join(root, relative)
  fs.mkdirSync(path.dirname(absolute), { recursive: true })
  fs.writeFileSync(absolute, content)
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'n08-instr-')))
  fs.mkdirSync(path.join(root, '.git'))
  write('AGENTS.md', '# root agents\nUse bun.')
  write('CLAUDE.md', '# root claude\nPrefer DI.')
  write('pkg/AGENTS.md', '# pkg agents\nSee @docs/x.md for the API notes.')
  write('pkg/docs/x.md', 'API notes: keep endpoints stable.')
  write('pkg/src/index.ts', 'export {}\n')
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('instruction files', () => {
  test('working in pkg/ loads root AGENTS.md, root CLAUDE.md, pkg/AGENTS.md and its import, each once', async () => {
    const cwd = path.join(root, 'pkg')
    const loaded = await loadInstructionFiles({
      projectRoot: cwd,
      filePaths: ['AGENTS.md', 'docs/x.md', 'src/index.ts'],
      fs: fs.promises,
      logger: silentLogger,
    })
    expect(loaded.instructionFiles.map((record) => record.path)).toEqual([
      '../AGENTS.md',
      '../CLAUDE.md',
      'AGENTS.md',
      'docs/x.md',
    ])
    expect(loaded.instructionFiles.map((record) => record.scope)).toEqual([
      'ancestor',
      'ancestor',
      'project',
      'import',
    ])
    expect(loaded.instructionFiles[3].importedBy).toBe('AGENTS.md')
    expect(loaded.knowledgeFiles['docs/x.md']).toContain('API notes')
    // All four are always on for the prompt, each once.
    expect(selectAlwaysOnInstructionFiles(loaded)).toEqual([
      '../AGENTS.md',
      '../CLAUDE.md',
      'AGENTS.md',
      'docs/x.md',
    ])
  })

  test('initialSessionState in pkg/ records the same four files', async () => {
    const sessionState = await initialSessionState({
      cwd: path.join(root, 'pkg'),
      homeDir: null,
      includeGlobalSkills: false,
      includeProjectSkills: false,
      projectContextMode: 'paths',
      persistentMemory: false,
      logger: silentLogger,
    } as Parameters<typeof initialSessionState>[0])
    const { fileContext } = sessionState
    expect(Object.keys(fileContext.knowledgeFiles).sort()).toEqual(
      ['../AGENTS.md', '../CLAUDE.md', 'AGENTS.md', 'docs/x.md'].sort(),
    )
    expect(selectAlwaysOnInstructionFiles(fileContext)).toHaveLength(4)
  })

  test('from the root, pkg/AGENTS.md and its import are nested and load only for touched pkg/ paths', async () => {
    const loaded = await loadInstructionFiles({
      projectRoot: root,
      filePaths: [
        'AGENTS.md',
        'CLAUDE.md',
        'pkg/AGENTS.md',
        'pkg/docs/x.md',
        'pkg/src/index.ts',
      ],
      fs: fs.promises,
      logger: silentLogger,
    })
    expect(selectAlwaysOnInstructionFiles(loaded)).toEqual([
      'AGENTS.md',
      'CLAUDE.md',
    ])
    expect(selectNestedInstructionFilesForPaths(loaded, ['README.md'])).toEqual(
      [],
    )
    expect(
      selectNestedInstructionFilesForPaths(loaded, ['pkg/src/index.ts']),
    ).toEqual(['pkg/AGENTS.md', 'pkg/docs/x.md'])
  })

  test('imports are cycle-safe, depth-bounded and contained to the git root', async () => {
    write('a.md', 'A imports @b.md')
    write('b.md', 'B imports @a.md and @c.md')
    write('c.md', 'C')
    write('AGENTS.md', 'root: @a.md @../outside.md @/etc/passwd `@code.md`')
    write('code.md', 'should not load (inside a code span)')
    fs.writeFileSync(path.join(path.dirname(root), 'outside.md'), 'secret')
    try {
      const loaded = await loadInstructionFiles({
        projectRoot: root,
        filePaths: ['AGENTS.md', 'a.md', 'b.md', 'c.md', 'code.md'],
        fs: fs.promises,
        logger: silentLogger,
      })
      const paths = loaded.instructionFiles.map((record) => record.path)
      expect(paths).toEqual(['AGENTS.md', 'a.md', 'b.md', 'c.md'])
      expect(new Set(paths).size).toBe(paths.length)
      expect(JSON.stringify(loaded.knowledgeFiles)).not.toContain('secret')
      expect(paths).not.toContain('code.md')
    } finally {
      fs.rmSync(path.join(path.dirname(root), 'outside.md'), { force: true })
    }
  })

  test('import chains stop at the depth limit', async () => {
    const chain = Array.from({ length: 8 }, (_, index) => `d${index}.md`)
    chain.forEach((name, index) =>
      write(name, index + 1 < chain.length ? `@${chain[index + 1]}` : 'end'),
    )
    write('AGENTS.md', `@${chain[0]}`)
    const loaded = await loadInstructionFiles({
      projectRoot: root,
      filePaths: ['AGENTS.md'],
      fs: fs.promises,
      logger: silentLogger,
    })
    const imports = loaded.instructionFiles.filter(
      (record) => record.scope === 'import',
    )
    expect(imports.map((record) => record.path)).toEqual(chain.slice(0, 5))
  })

  test('without a git root no ancestor directory is read', async () => {
    fs.rmSync(path.join(root, '.git'), { recursive: true })
    const loaded = await loadInstructionFiles({
      projectRoot: path.join(root, 'pkg'),
      filePaths: ['AGENTS.md'],
      fs: fs.promises,
      logger: silentLogger,
    })
    expect(loaded.instructionFiles.map((record) => record.path)).toEqual([
      'AGENTS.md',
      'docs/x.md',
    ])
  })
})

import { afterEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { initialSessionState, applyOverridesToSessionState } from '../run-state'
import type { CodebuffFileSystem } from '@codebuff/common/types/filesystem'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true })),
  )
})

describe('path-only project context', () => {
  test('refreshes live paths and instructions without reading source on initial or continued turns', async () => {
    const cwd = await fs.mkdtemp(
      path.join(os.tmpdir(), 'openbuff-path-context-'),
    )
    directories.push(cwd)
    await fs.writeFile(path.join(cwd, 'old.ts'), 'export const oldSymbol = 1')
    await fs.writeFile(path.join(cwd, 'AGENTS.md'), 'Use the old instructions')
    const sourceReads: string[] = []
    const adapter = {
      ...fs,
      readFile: async (filePath: string, encoding: 'utf8') => {
        if (filePath.endsWith('.ts')) sourceReads.push(filePath)
        return fs.readFile(filePath, encoding)
      },
    } as unknown as CodebuffFileSystem
    const state = await initialSessionState({
      cwd,
      fs: adapter,
      projectContextMode: 'paths',
      persistentMemory: false,
      agentDefinitions: [{ id: 'test', displayName: 'Test', model: 'test' }],
    })
    expect(JSON.stringify(state.fileContext.fileTree)).toContain('old.ts')
    expect(state.fileContext.knowledgeFiles['AGENTS.md']).toBe(
      'Use the old instructions',
    )
    expect(state.fileContext.fileTokenScores).toEqual({})

    await fs.unlink(path.join(cwd, 'old.ts'))
    await fs.writeFile(path.join(cwd, 'new.ts'), 'export const newSymbol = 1')
    await fs.writeFile(path.join(cwd, 'AGENTS.md'), 'Use the new instructions')
    const continued = await applyOverridesToSessionState(
      cwd,
      state,
      { projectContextMode: 'paths' },
      { fs: adapter },
    )
    expect(JSON.stringify(continued.fileContext.fileTree)).toContain('new.ts')
    expect(JSON.stringify(continued.fileContext.fileTree)).not.toContain(
      'old.ts',
    )
    expect(continued.fileContext.knowledgeFiles['AGENTS.md']).toBe(
      'Use the new instructions',
    )
    expect(continued.fileContext.fileTokenScores).toEqual({})
    expect(continued.fileContext.tokenCallers).toEqual({})
    expect(sourceReads).toEqual([])
    expect(state.fileContext.knowledgeFiles['AGENTS.md']).toBe(
      'Use the old instructions',
    )
  })

  test('keeps explicit virtual paths and knowledge authoritative', async () => {
    const state = await initialSessionState({
      cwd: '/virtual-project',
      projectContextMode: 'paths',
      persistentMemory: false,
      projectFiles: {
        'src/index.ts': 'export const first = 1',
        'AGENTS.md': 'Virtual instructions',
      },
      agentDefinitions: [{ id: 'test', displayName: 'Test', model: 'test' }],
    })
    const continued = await applyOverridesToSessionState(
      '/virtual-project',
      state,
      {
        projectContextMode: 'paths',
        projectFiles: { 'src/next.ts': 'export const second = 2' },
        knowledgeFiles: { 'AGENTS.md': 'Explicit instructions' },
      },
    )
    expect(JSON.stringify(continued.fileContext.fileTree)).toContain('next.ts')
    expect(JSON.stringify(continued.fileContext.fileTree)).not.toContain(
      'index.ts',
    )
    expect(continued.fileContext.fileTreeSource).toBe('virtual')
    expect(continued.fileContext.knowledgeFiles).toEqual({
      'AGENTS.md': 'Explicit instructions',
    })
    expect(continued.fileContext.fileTokenScores).toEqual({})
  })
})

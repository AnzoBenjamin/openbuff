import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import {
  findUnguardedProjectRootDerefs,
  formatProjectRootViolations,
} from '../project-root-guard'

const FIXTURE_TOOLS_PREFIX = 'packages/agent-runtime/src/tools'

let tmpDir: string

function toolsDir(): string {
  const directory = join(tmpDir, 'packages', 'agent-runtime', 'src', 'tools')
  mkdirSync(directory, { recursive: true })
  return directory
}

function writeFixture(relativePath: string, content: string): string {
  const path = join(toolsDir(), relativePath)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
  return `${FIXTURE_TOOLS_PREFIX}/${relativePath}`
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'project-root-guard-'))
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

test('flags an unguarded fileContext.projectRoot dereference', () => {
  const fixturePath = writeFixture(
    'read-files.ts',
    [
      "import { resolve } from 'node:path'",
      '',
      'type Params = { fileContext: { projectRoot: string } }',
      '',
      'export function readFiles(params: Params) {',
      "  return resolve(params.fileContext.projectRoot, 'src')",
      '}',
    ].join('\n'),
  )

  const violations = findUnguardedProjectRootDerefs(tmpDir)

  expect(violations).toEqual([
    {
      path: fixturePath,
      line: 6,
      text: "return resolve(params.fileContext.projectRoot, 'src')",
    },
  ])
  expect(formatProjectRootViolations(violations)).toContain(`${fixturePath}:6:`)
})

test('allows optional-chained fileContext?.projectRoot reads', () => {
  writeFixture(
    'read-outline.ts',
    [
      "import { resolve } from 'node:path'",
      '',
      'type Params = { fileContext?: { projectRoot?: string } }',
      '',
      'export function readOutline(params: Params) {',
      "  return resolve(params.fileContext?.projectRoot ?? '', 'src')",
      '}',
    ].join('\n'),
  )

  expect(findUnguardedProjectRootDerefs(tmpDir)).toEqual([])
})

test('allows resolveProjectRootOrEmpty(fileContext) reads', () => {
  writeFixture(
    'tool-executor.ts',
    [
      "import { resolve } from 'node:path'",
      '',
      'export function execute(params: { fileContext: unknown }) {',
      '  const projectRoot = resolveProjectRootOrEmpty(params.fileContext)',
      "  return resolve(projectRoot, 'src')",
      '}',
    ].join('\n'),
  )

  expect(findUnguardedProjectRootDerefs(tmpDir)).toEqual([])
})

test('ignores dereferences that only appear in a comment', () => {
  writeFixture(
    'spawn-commented.ts',
    [
      "import { resolve } from 'node:path'",
      '',
      'export function spawnAgent(params: { fileContext?: { projectRoot?: string } }) {',
      '  // fileContext.projectRoot is required by the type but can be absent',
      "  return resolve(params.fileContext?.projectRoot ?? '', 'src')",
      '}',
    ].join('\n'),
  )

  expect(findUnguardedProjectRootDerefs(tmpDir)).toEqual([])
})

test('ignores lines annotated with guard-ok: projectRoot', () => {
  writeFixture(
    'spawn-agents.ts',
    [
      "import { resolve } from 'node:path'",
      '',
      'type Params = { fileContext: { projectRoot: string } }',
      '',
      'export function spawnAgents(params: Params) {',
      "  return resolve(params.fileContext.projectRoot, 'src') // guard-ok: projectRoot",
      '}',
    ].join('\n'),
  )

  expect(findUnguardedProjectRootDerefs(tmpDir)).toEqual([])
})

test('ignores test files and __tests__ directories', () => {
  writeFixture(
    '__tests__/read-files.test.ts',
    [
      'export function readFiles(params: { fileContext: { projectRoot: string } }) {',
      '  return params.fileContext.projectRoot',
      '}',
    ].join('\n'),
  )
  writeFixture(
    'read-files.test.ts',
    [
      'export function readFiles(params: { fileContext: { projectRoot: string } }) {',
      '  return params.fileContext.projectRoot',
      '}',
    ].join('\n'),
  )
  writeFixture(
    'node_modules/dep/index.ts',
    ['export const value = params.fileContext.projectRoot'].join('\n'),
  )

  expect(findUnguardedProjectRootDerefs(tmpDir)).toEqual([])
})

test('allows a nullish-coalesced fileContext.projectRoot read', () => {
  writeFixture(
    'stream-parser.ts',
    [
      'type Params = { fileContext: { projectRoot: string } }',
      '',
      'export function parseStream(params: Params) {',
      "  const projectRoot = params.fileContext.projectRoot ?? ''",
      '  if (!projectRoot) return null',
      '  return projectRoot',
      '}',
    ].join('\n'),
  )

  expect(findUnguardedProjectRootDerefs(tmpDir)).toEqual([])
})

test('allows a nullish-coalesced projectId assignment', () => {
  writeFixture(
    'stream-parser-project-id.ts',
    [
      'export function streamStart(fileContext: { projectRoot: string }) {',
      '  return {',
      "    type: 'start',",
      "    projectId: fileContext.projectRoot ?? '',",
      '  }',
      '}',
    ].join('\n'),
  )

  expect(findUnguardedProjectRootDerefs(tmpDir)).toEqual([])
})

test('allows a ternary true-branch line dereferencing fileContext.projectRoot', () => {
  writeFixture(
    'read-subtree-branch.ts',
    [
      "import * as nodePath from 'node:path'",
      '',
      'export function resolvePath(fileContext: { projectRoot?: string }) {',
      '  return fileContext?.projectRoot',
      '    ? nodePath.resolve(fileContext.projectRoot)',
      "    : ''",
      '}',
    ].join('\n'),
  )

  expect(findUnguardedProjectRootDerefs(tmpDir)).toEqual([])
})

test('allows a ternary false-branch line dereferencing fileContext.projectRoot', () => {
  writeFixture(
    'skill-branch.ts',
    [
      'export function loadSkill(fileContext: { projectRoot?: string }, name: string) {',
      '  return name',
      '    ? fileContext?.projectRoot',
      '    : fileContext.projectRoot',
      '}',
    ].join('\n'),
  )

  expect(findUnguardedProjectRootDerefs(tmpDir)).toEqual([])
})

test('allows a fileContext.projectRoot && ... short-circuit', () => {
  writeFixture(
    'guarded-and.ts',
    [
      'export function hasProjectRoot(fileContext: { projectRoot?: string }) {',
      '  return fileContext.projectRoot && fileContext.projectRoot.length > 0',
      '}',
    ].join('\n'),
  )

  expect(findUnguardedProjectRootDerefs(tmpDir)).toEqual([])
})

test('still flags a standalone unguarded fileContext.projectRoot deref', () => {
  const fixturePath = writeFixture(
    'unguarded-assignment.ts',
    [
      'export function resolveProjectPath(fileContext: { projectRoot?: string }) {',
      '  const projectRoot = fileContext.projectRoot',
      '  return projectRoot',
      '}',
    ].join('\n'),
  )

  const violations = findUnguardedProjectRootDerefs(tmpDir)

  expect(violations).toEqual([
    {
      path: fixturePath,
      line: 2,
      text: 'const projectRoot = fileContext.projectRoot',
    },
  ])
})

test('formats violations', () => {
  expect(formatProjectRootViolations([])).toBe(
    'Project-root guard passed: no unguarded fileContext.projectRoot dereferences found.',
  )
  expect(
    formatProjectRootViolations([
      {
        path: 'packages/agent-runtime/src/tools/read-files.ts',
        line: 6,
        text: 'return params.fileContext.projectRoot',
      },
    ]),
  ).toBe(
    [
      'Unguarded fileContext.projectRoot dereferences:',
      'packages/agent-runtime/src/tools/read-files.ts:6: return params.fileContext.projectRoot',
    ].join('\n'),
  )
})

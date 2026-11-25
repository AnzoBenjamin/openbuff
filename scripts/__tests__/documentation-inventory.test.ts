import { afterEach, beforeEach, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { getGitDocumentationInventory } from '../lib/documentation-inventory'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'documentation-inventory-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function git(args: string[]): string {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  })
}

function writeDocument(path: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), '# Fixture\n')
}

test('inventories tracked and unignored new Markdown, including force-added ignored files', () => {
  git(['init', '-q'])
  const evidence = 'docs/execution/body-roadmap/evidence'
  writeFileSync(join(root, '.gitignore'), `/.tmp/\n/${evidence}/\n`)
  const staged = ['docs/tracked.md', '.tmp/staged.md', `${evidence}/staged.mdx`]
  const newPaths = ['docs/new.mdx', 'docs/spaces "quotes"\n日本語.md']
  const ignored = ['.tmp/ignored.mdx', `${evidence}/ignored.md`]
  for (const path of [...staged, ...newPaths, ...ignored, 'docs/not-markdown.txt']) {
    writeDocument(path)
  }
  git(['add', '-f', '--', ...staged])
  // An ordinary tracked path stays in scope after an ignore rule is added.
  writeFileSync(
    join(root, '.gitignore'),
    `/.tmp/\n/${evidence}/\n/docs/tracked.md\n`,
  )

  expect([...getGitDocumentationInventory(root)!].sort()).toEqual(
    [...staged, ...newPaths].sort(),
  )
})

test('a genuine repository with no Markdown has an empty inventory, not a fallback', () => {
  git(['init', '-q'])
  expect(getGitDocumentationInventory(root)).toEqual(new Set())
})

test('a non-Git root has no inventory', () => {
  writeDocument('docs/new.md')
  expect(getGitDocumentationInventory(root)).toBeNull()
})

test('a selected subroot does not inherit its parent repository inventory', () => {
  git(['init', '-q'])
  writeFileSync(join(root, '.gitignore'), '/fixture/\n')
  writeDocument('fixture/docs/notes.md')
  expect(getGitDocumentationInventory(join(root, 'fixture'))).toBeNull()
})

test.skipIf(process.platform === 'win32')(
  'repository-root matching uses canonical paths',
  () => {
    git(['init', '-q'])
    writeDocument('docs/notes.md')
    const alias = join(root, 'alias')
    symlinkSync(root, alias, 'dir')

    expect([...getGitDocumentationInventory(alias)!]).toEqual(['docs/notes.md'])
  },
)

test('one invocation probes once and inventories once, regardless of documentation count', () => {
  git(['init', '-q'])
  for (let index = 0; index < 20; index++) writeDocument(`docs/nested/${index}.md`)
  const calls: string[][] = []
  const inventory = getGitDocumentationInventory(root, (cwd, args) => {
    expect(cwd).toBe(realpathSync(root))
    calls.push(args)
    return git(args)
  })

  expect(inventory!.size).toBe(20)
  expect(calls).toEqual([
    ['rev-parse', '--show-toplevel'],
    ['ls-files', '--cached', '--others', '--exclude-standard', '--full-name', '-z'],
  ])
})

test('selected-repository inventory errors are not swallowed as an empty inventory', () => {
  git(['init', '-q'])
  writeFileSync(join(root, '.git', 'index'), 'broken index\n')

  expect(() => getGitDocumentationInventory(root)).toThrow(
    'documentation inventory',
  )
  expect(() => getGitDocumentationInventory(root)).toThrow('ls-files')
})

test('unexpected exit-128 probe failures are not confused with absence of a repository', () => {
  writeFileSync(join(root, '.git'), 'gitdir: missing-git-directory\n')

  expect(() => getGitDocumentationInventory(root)).toThrow(
    'documentation inventory',
  )
  expect(() => getGitDocumentationInventory(root)).toThrow('rev-parse')
})

test('a missing Git executable fails visibly', () => {
  expect(() =>
    getGitDocumentationInventory(root, () => {
      throw Object.assign(new Error('git could not be spawned'), {
        code: 'ENOENT',
      })
    }),
  ).toThrow('git could not be spawned')
})

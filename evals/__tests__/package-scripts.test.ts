import fs from 'fs'
import path from 'path'

import { describe, expect, test } from 'bun:test'

const evalsRoot = path.join(__dirname, '..')
const repoRoot = path.join(evalsRoot, '..')
const pkg = JSON.parse(
  fs.readFileSync(path.join(evalsRoot, 'package.json'), 'utf8'),
) as { scripts: Record<string, string> }

const PATH_LIKE = /\.(ts|tsx|js|mjs|cjs|json)$/

/**
 * Every file or directory a script names, relative to evals/. A token counts
 * as a path when it has a file extension we run, or follows `-p`. `bun run
 * <name>` without an extension must name another package script.
 */
function referencedTargets(command: string): {
  paths: string[]
  scriptRefs: string[]
} {
  const tokens = command.split(/\s+/).filter(Boolean)
  const paths: string[] = []
  const scriptRefs: string[] = []
  tokens.forEach((token, index) => {
    if (token.startsWith('-')) return
    if (tokens[index - 1] === '-p') {
      paths.push(token)
      return
    }
    if (PATH_LIKE.test(token)) {
      paths.push(token)
      return
    }
    if (
      tokens[index - 1] === 'run' &&
      tokens[index - 2] === 'bun' &&
      !token.includes('/')
    ) {
      scriptRefs.push(token)
    }
  })
  return { paths, scriptRefs }
}

describe('evals/package.json scripts (N10)', () => {
  test.each(Object.entries(pkg.scripts))(
    '%s resolves to existing files',
    (_name, command) => {
      const { paths, scriptRefs } = referencedTargets(command)
      for (const target of paths) {
        expect({
          target,
          exists: fs.existsSync(path.join(evalsRoot, target)),
        }).toEqual({ target, exists: true })
      }
      for (const ref of scriptRefs) {
        expect(Object.keys(pkg.scripts)).toContain(ref)
      }
    },
  )

  test('every runnable script names a file (no bare dead commands)', () => {
    const runners = Object.entries(pkg.scripts).filter(([, command]) =>
      /^bun run /.test(command),
    )
    expect(runners.length).toBeGreaterThan(0)
    for (const [name, command] of runners) {
      expect({
        name,
        paths: referencedTargets(command).paths.length > 0,
      }).toEqual({ name, paths: true })
    }
  })

  test('the parser flags a dead script', () => {
    const { paths } = referencedTargets('bun run git-evals/run-eval-set.ts')
    expect(paths).toEqual(['git-evals/run-eval-set.ts'])
    expect(fs.existsSync(path.join(evalsRoot, paths[0]))).toBe(false)
  })

  test('workflows only call evals scripts that exist', () => {
    const workflowsDir = path.join(repoRoot, '.github', 'workflows')
    for (const file of fs.readdirSync(workflowsDir)) {
      const text = fs.readFileSync(path.join(workflowsDir, file), 'utf8')
      for (const match of text.matchAll(
        /cd evals && bun (?:run )?([\w:-]+)/g,
      )) {
        expect({
          file,
          script: match[1],
          known: match[1] in pkg.scripts,
        }).toEqual({ file, script: match[1], known: true })
      }
    }
  })
})

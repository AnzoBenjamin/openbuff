/**
 * Release smoke probe for code-map (N09): index a small TypeScript fixture
 * with the same parser the CLI index uses and require non-empty symbols,
 * calls and imports. A binary shipped without `tree-sitter-queries/*.scm`
 * still parses every file but extracts nothing, which this probe turns into
 * a hard failure. Invoked as `<binary> --smoke-code-map` from
 * cli/scripts/smoke-binary.ts.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'

import { getFileTokenScores, getTagQueryStatus } from '@codebuff/indexer'

import type { TagQueryStatus } from '@codebuff/indexer'

export type CodeMapSmokeResult = {
  ok: boolean
  symbols: number
  calls: number
  imports: number
  queries: TagQueryStatus
  problems: string[]
}

const FIXTURE: Record<string, string> = {
  'util.ts':
    'export function greet(name: string): string {\n  return `hi ${name}`\n}\n',
  'main.ts':
    "import { greet } from './util'\n\nexport class App {\n  run(): string {\n    return greet('smoke')\n  }\n}\n",
}

export async function runCodeMapSmoke(
  deps: {
    getStatus?: () => TagQueryStatus
    scoreFiles?: typeof getFileTokenScores
  } = {},
): Promise<CodeMapSmokeResult> {
  const queries = (deps.getStatus ?? getTagQueryStatus)()
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'openbuff-code-map-smoke-'),
  )
  try {
    for (const [name, content] of Object.entries(FIXTURE)) {
      fs.writeFileSync(path.join(root, name), content)
    }
    const { parsed } = await (deps.scoreFiles ?? getFileTokenScores)(
      root,
      Object.keys(FIXTURE),
    )
    const files = Object.values(parsed)
    const symbols = files.reduce((n, f) => n + f.identifiers.length, 0)
    const calls = files.reduce((n, f) => n + f.calls.length, 0)
    const imports = files.reduce((n, f) => n + (f.imports?.length ?? 0), 0)
    const problems: string[] = []
    if (queries.missing.length > 0) {
      problems.push(`missing tag queries: ${queries.missing.join(', ')}`)
    }
    if (symbols === 0) problems.push('no symbols extracted')
    if (calls === 0) problems.push('no calls extracted')
    if (imports === 0) problems.push('no imports extracted')
    return {
      ok: problems.length === 0,
      symbols,
      calls,
      imports,
      queries,
      problems,
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

export function formatCodeMapSmoke(result: CodeMapSmokeResult): string {
  const counts = `symbols=${result.symbols} calls=${result.calls} imports=${result.imports} queries=${result.queries.available.length}/${result.queries.total}`
  return result.ok
    ? `code-map smoke ok (${counts})`
    : `code-map smoke FAIL (${counts}): ${result.problems.join('; ')}`
}

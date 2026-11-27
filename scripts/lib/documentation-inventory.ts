import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'

export type DocumentationGitRunner = (root: string, args: string[]) => string

const runGit: DocumentationGitRunner = (root, args) =>
  execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, LC_ALL: 'C' },
    maxBuffer: 16 * 1024 * 1024,
  })

function inventoryFailure(root: string, command: string, error: unknown): Error {
  const reason = error instanceof Error ? error.message : String(error)
  return new Error(
    `Git documentation inventory failed for ${root} (${command}): ${reason}`,
    { cause: error },
  )
}

/**
 * Repository-relative Markdown tracked by Git (even when ignored), plus new
 * unignored Markdown. Only the canonical repository root gets an inventory:
 * plain directories and fixture subroots retain their callers' legacy walks.
 * Unexpected Git failures throw; null means no selected-root inventory, not
 * an empty or unverifiable repository. Call once per guard walk/snapshot.
 */
export function getGitDocumentationInventory(
  root: string,
  git: DocumentationGitRunner = runGit,
): ReadonlySet<string> | null {
  const canonicalRoot = realpathSync(root)
  let repositoryRoot: string
  try {
    const output = git(canonicalRoot, ['rev-parse', '--show-toplevel'])
    repositoryRoot = realpathSync(output.replace(/\r?\n$/, ''))
  } catch (error) {
    const failure = error as { status?: unknown; stderr?: unknown } | null
    // Exit 128 alone also covers corrupt repositories and dubious ownership.
    // Only Git's explicit discovery refusal means this is a non-Git fixture.
    if (
      failure?.status === 128 &&
      /^fatal: not a git repository \(or any (?:of the parent directories|parent up to mount point [^\n]+)\)/m.test(
        String(failure.stderr ?? ''),
      )
    ) {
      return null
    }
    throw inventoryFailure(canonicalRoot, 'git rev-parse --show-toplevel', error)
  }
  if (repositoryRoot !== canonicalRoot) return null

  let output: string
  try {
    output = git(canonicalRoot, [
      'ls-files',
      '--cached',
      '--others',
      '--exclude-standard',
      '--full-name',
      '-z',
    ])
  } catch (error) {
    throw inventoryFailure(canonicalRoot, 'git ls-files', error)
  }
  // NUL delimiters preserve spaces, quotes, Unicode and newlines in filenames;
  // a set deduplicates cached entries (e.g. unmerged index stages).
  return new Set(
    output
      .split('\0')
      .filter((path) => path.endsWith('.md') || path.endsWith('.mdx')),
  )
}

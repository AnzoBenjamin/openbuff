import fs from 'fs'
import path from 'path'

import {
  formatProjectTrustItems,
  loadProviderConfigSync,
  needsProjectTrustDecision,
  recordProjectTrustDecision,
  setProjectTrustOverride,
} from '@openbuff/sdk'

import { getConfigDir } from './auth'

import type { ProjectTrustState } from '@openbuff/sdk'

/**
 * N02 project trust gate, CLI side. One decision per launch covers the
 * project's openbuff.json/openbuff.d, `.agents/` agents, project skills and
 * `.agents/mcp.json`. The SDK enforces it (both config loaders consult the
 * same store and the process override set here); this module only decides,
 * asks and persists.
 */

export type ProjectTrustSource =
  | 'flag'
  | 'allowlist'
  | 'stored'
  | 'prompt'
  | 'untrusted'

export type ProjectTrustOutcome = {
  trusted: boolean
  source: ProjectTrustSource
  state?: ProjectTrustState
}

export type ProjectTrustPrompt = (lines: string[]) => Promise<boolean>

export type ResolveProjectTrustDeps = {
  /** Loads config for process.cwd(); defaults to the SDK legacy loader. */
  loadState?: () => ProjectTrustState | undefined
  configDir?: string
  exists?: (filePath: string) => boolean
  readDirectory?: (dir: string) => string[]
  /** Interactive prompt; omitted means non-interactive (no question asked). */
  prompt?: ProjectTrustPrompt
  /** Notice sink for non-interactive untrusted launches. */
  notice?: (line: string) => void
}

const AGENT_FILE_RE = /\.(ts|tsx|js|mjs|cjs|json|md)$/

/** Project content the CLI loads only when trusted, beyond openbuff.json. */
export function listProjectTrustExtras(
  projectRoot: string,
  deps: Pick<ResolveProjectTrustDeps, 'exists' | 'readDirectory'> = {},
): string[] {
  const exists = deps.exists ?? fs.existsSync
  const readDirectory =
    deps.readDirectory ??
    ((dir: string) => {
      try {
        return fs.readdirSync(dir)
      } catch {
        return []
      }
    })
  const extras: string[] = []
  const agentsDir = path.join(projectRoot, '.agents')
  if (
    readDirectory(agentsDir).some(
      (name) => AGENT_FILE_RE.test(name) && name !== 'mcp.json',
    )
  )
    extras.push('load project agents from .agents/')
  for (const skillsDir of [
    path.join('.agents', 'skills'),
    path.join('.claude', 'skills'),
  ])
    if (readDirectory(path.join(projectRoot, skillsDir)).length > 0)
      extras.push(`load project skills from ${skillsDir}/`)
  if (exists(path.join(agentsDir, 'mcp.json')))
    extras.push('start MCP servers from .agents/mcp.json')
  return extras
}

export function describeProjectTrustRequest(
  state: ProjectTrustState | undefined,
  extras: string[],
): string[] {
  return [
    ...(state ? formatProjectTrustItems(state) : []),
    ...extras,
  ]
}

/**
 * Resolve, and when needed ask for, the trust decision for `projectRoot`.
 * `projectRoot` must equal process.cwd() (initializeApp chdirs there).
 */
export async function resolveProjectTrust(
  params: {
    projectRoot: string
    /** `--trust-project-agents`: an explicit grant, recorded in the store. */
    flag: boolean
    /** serve only: legacy trusted-roots.json allowlist hit. */
    allowlisted?: boolean
  },
  deps: ResolveProjectTrustDeps = {},
): Promise<ProjectTrustOutcome> {
  const configDir = deps.configDir ?? getConfigDir()
  const loadState =
    deps.loadState ?? (() => loadProviderConfigSync().projectTrust)
  const grant = (source: ProjectTrustSource, state?: ProjectTrustState) => {
    setProjectTrustOverride({
      projectRoot: params.projectRoot,
      decision: 'trusted',
    })
    return { trusted: true, source, state }
  }

  let state: ProjectTrustState | undefined
  try {
    state = loadState()
  } catch {
    state = undefined
  }

  if (params.flag) {
    if (state)
      recordProjectTrustDecision({
        configDir,
        projectRoot: state.projectRoot,
        configHash: state.configHash,
        decision: 'trusted',
        source: 'flag',
      })
    return grant('flag', state)
  }
  if (params.allowlisted) return grant('allowlist', state)
  if (state?.status === 'trusted') return grant('stored', state)

  const extras = listProjectTrustExtras(params.projectRoot, deps)
  if (
    !needsProjectTrustDecision(state, {
      hasProjectAgentsOrSkills: extras.length > 0,
    })
  )
    return { trusted: false, source: 'untrusted', state }

  const items = describeProjectTrustRequest(state, extras)
  if (deps.prompt && state) {
    const answer = await deps.prompt(items)
    recordProjectTrustDecision({
      configDir,
      projectRoot: state.projectRoot,
      configHash: state.configHash,
      decision: answer ? 'trusted' : 'untrusted',
      source: 'prompt',
    })
    if (answer) return grant('prompt', state)
    setProjectTrustOverride({
      projectRoot: params.projectRoot,
      decision: 'untrusted',
    })
    return { trusted: false, source: 'prompt', state }
  }

  deps.notice?.(
    [
      `openbuff: project ${params.projectRoot} is not trusted${
        state?.reason === 'changed' ? ' (its config changed since you trusted it)' : ''
      }; ignoring:`,
      ...items.map((item) => `  - ${item}`),
      '  Start openbuff interactively to review, or pass --trust-project-agents to trust it.',
    ].join('\n'),
  )
  return { trusted: false, source: 'untrusted', state }
}

/** Plain-terminal trust screen shown before the TUI renderer mounts. */
export function createTerminalTrustPrompt(io: {
  input: NodeJS.ReadableStream
  output: NodeJS.WritableStream
}): ProjectTrustPrompt {
  return async (lines) => {
    const readline = await import('readline/promises')
    // terminal: false keeps readline from installing keypress handling that
    // would leave the answer keystrokes for the TUI renderer to replay.
    const rl = readline.createInterface({
      input: io.input,
      output: io.output,
      terminal: false,
    })
    try {
      io.output.write(
        [
          '',
          'This project has configuration that can run code, use your API keys or loosen approvals:',
          ...lines.map((line) => `  - ${line}`),
          '',
          'Until you trust it, Openbuff ignores all of the above (project config can only tighten policy).',
          'Your answer is saved for this project and asked again if its config changes.',
          '',
        ].join('\n'),
      )
      const answer = (await rl.question('Trust this project? [y/N] '))
        .trim()
        .toLowerCase()
      return answer === 'y' || answer === 'yes'
    } finally {
      rl.close()
      io.input.pause()
    }
  }
}

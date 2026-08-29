import { IndexManager } from '@codebuff/indexer'
import { createConfiguredEmbedder, loadProviderConfigSync } from '@openbuff/sdk'

import { getProjectRoot } from '../project-files'
import { formatAge } from '../utils/format-helpers'

type IndexQueryResult = {
  results: Array<{
    path: string
    score: number
    explanation?: string
    matchedOn?: string[]
  }>
  ready: boolean
  totalIndexed: number
  indexAge: number
  status: IndexStatusView
}

type IndexStatusView = {
  state:
    | 'disabled'
    | 'building'
    | 'ready'
    | 'stale'
    | 'degraded'
    | 'failed'
    | 'empty'
  ready: boolean
  stale: boolean
  refreshing: boolean
  semantic: 'disabled' | 'building' | 'ready' | 'unavailable' | 'failed'
  totalIndexed: number
  indexAge: number
  diagnostics: Array<{ filePath: string; stage: string; message: string }>
  coverage?: {
    truncated: boolean
    maxFiles: number
    skippedFiles: number
    skippedPrefixes: string[]
  }
  message: string
}

type IndexManagerLike = {
  markStale(): void
  ensureBuilt(): void
  waitUntilReady(timeoutMs?: number): Promise<void>
  query(query: string, options?: { limit?: number }): IndexQueryResult
  queryBlended(
    query: string,
    options?: { limit?: number; mode?: 'explain' },
  ): Promise<IndexQueryResult>
  isSemanticReady(): boolean
}

type IndexCommandDeps = {
  getManager: () => {
    enabled: boolean
    semanticEnabled: boolean
    manager: IndexManagerLike | null
  }
}

const defaultDeps: IndexCommandDeps = {
  getManager: () => {
    const config = loadProviderConfigSync().config.indexing
    if (config.enabled === false) {
      return { enabled: false, semanticEnabled: false, manager: null }
    }
    const embedder =
      config.semantic?.enabled && config.semantic.model
        ? (createConfiguredEmbedder(config.semantic.model) ?? undefined)
        : undefined
    return {
      enabled: true,
      semanticEnabled: config.semantic?.enabled ?? false,
      manager: IndexManager.getInstance(getProjectRoot(), config, embedder),
    }
  },
}

export function buildIndexStatusContentBlock(
  result: IndexQueryResult,
  semanticReady: boolean,
  semanticEnabled: boolean,
): import('../types/chat').IndexStatusContentBlock {
  const status = result.status
  const statusLine = `Index status: ${status.state}${status.refreshing ? ' · refreshing' : ''}.`
  const messageLine = status.message
  const corpusLine = `${status.totalIndexed} indexed file${status.totalIndexed === 1 ? '' : 's'}.`
  const ageLine =
    status.indexAge > 0 ? formatAge(status.indexAge) : 'not available'
  const semantic = !semanticEnabled
    ? 'disabled'
    : semanticReady
      ? 'ready'
      : `${status.semantic} (metadata-only fallback)`
  const vectorLine = semantic
  const hintLine = status.ready
    ? 'Use /index explain <query> to inspect ranking provenance.'
    : 'Retry shortly, run /index rebuild, or use read_subtree/glob/code_search.'
  const coverageLine = status.coverage?.truncated
    ? `Coverage: partial at ${status.coverage.maxFiles} files; skipped ${status.coverage.skippedFiles} under ${status.coverage.skippedPrefixes.join(', ') || 'unknown prefixes'}.`
    : undefined
  const diagnosticsLines =
    status.diagnostics.length > 0
      ? [
          `Diagnostics: ${status.diagnostics.length} parser issue${status.diagnostics.length === 1 ? '' : 's'}.`,
          ...status.diagnostics
            .slice(0, 5)
            .map(
              (diagnostic) =>
                `- ${diagnostic.filePath} (${diagnostic.stage}): ${diagnostic.message}`,
            ),
        ]
      : undefined
  const lines = [
    statusLine,
    messageLine,
    `Corpus: ${corpusLine}`,
    `Age: ${ageLine}`,
    `Vector embeddings: ${vectorLine}`,
    hintLine,
    ...(coverageLine ? [coverageLine] : []),
    ...(diagnosticsLines ? diagnosticsLines : []),
  ]
  return {
    type: 'index-status',
    statusLine,
    messageLine,
    corpusLine,
    ageLine,
    vectorLine,
    hintLine,
    coverageLine,
    diagnosticsLines,
    lines,
  }
}

export async function handleIndexCommandBlocks(
  rawArgs: string,
  deps: IndexCommandDeps = defaultDeps,
): Promise<import('../types/chat').IndexStatusContentBlock | string> {
  const [subcommand = 'status', ...rest] = rawArgs
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  const normalized = subcommand.toLowerCase()
  const setup = deps.getManager()

  if (!setup.enabled || !setup.manager) {
    const lines = [
      'Index status: disabled in openbuff.json.',
      'Use read_subtree, glob, or code_search for live discovery.',
    ]
    return {
      type: 'index-status',
      statusLine: lines[0],
      messageLine: lines[1],
      corpusLine: '',
      ageLine: '',
      vectorLine: '',
      hintLine: '',
      lines,
    }
  }

  if (normalized === 'status') {
    return buildIndexStatusContentBlock(
      setup.manager.query('', { limit: 1 }),
      setup.manager.isSemanticReady(),
      setup.semanticEnabled,
    )
  }

  if (normalized === 'rebuild') {
    setup.manager.markStale()
    setup.manager.ensureBuilt()
    await setup.manager.waitUntilReady(30_000)
    const status = setup.manager.query('', { limit: 1 })
    const block = buildIndexStatusContentBlock(
      status,
      setup.manager.isSemanticReady(),
      setup.semanticEnabled,
    )
    const prefix =
      'Index refresh requested. Compatible caches are reconciled incrementally; incompatible caches rebuild.'
    return {
      ...block,
      messageLine: `${prefix}\n${block.messageLine}`,
      lines: [prefix, ...block.lines],
    }
  }

  // For non-status subcommands (explain, etc.), fall back to string.
  return handleIndexCommand(rawArgs, deps)
}

export async function handleIndexCommand(
  rawArgs: string,
  deps: IndexCommandDeps = defaultDeps,
): Promise<string> {
  const [subcommand = 'status', ...rest] = rawArgs
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  const normalized = subcommand.toLowerCase()
  const setup = deps.getManager()

  if (!setup.enabled || !setup.manager) {
    return [
      'Index status: disabled in openbuff.json.',
      'Use read_subtree, glob, or code_search for live discovery.',
    ].join('\n')
  }

  if (normalized === 'status') {
    return formatIndexStatus(
      setup.manager.query('', { limit: 1 }),
      setup.manager.isSemanticReady(),
      setup.semanticEnabled,
    )
  }

  if (normalized === 'rebuild') {
    setup.manager.markStale()
    setup.manager.ensureBuilt()
    await setup.manager.waitUntilReady(30_000)
    const status = setup.manager.query('', { limit: 1 })
    return [
      'Index refresh requested. Compatible caches are reconciled incrementally; incompatible caches rebuild.',
      formatIndexStatus(
        status,
        setup.manager.isSemanticReady(),
        setup.semanticEnabled,
      ),
    ].join('\n')
  }

  if (normalized === 'explain') {
    const query = rest.join(' ').trim()
    if (!query) {
      return 'Usage: /index explain <query>'
    }
    await setup.manager.waitUntilReady(5_000)
    const result = await setup.manager.queryBlended(query, {
      mode: 'explain',
      limit: 10,
    })
    if (!result.ready) {
      return [
        `Index explain: index is still building (${result.totalIndexed} files known).`,
        'Retry shortly or use read_subtree, glob, or code_search now.',
      ].join('\n')
    }
    if (result.results.length === 0) {
      return `Index explain: no matches for "${query}" across ${result.totalIndexed} indexed files.`
    }
    return [
      `Index explain: "${query}" (${result.results.length} results; ${result.totalIndexed} indexed files; age ${formatAge(result.indexAge)}).`,
      ...result.results.map((item, index) => {
        const matched = item.matchedOn?.length
          ? ` matched ${item.matchedOn.join(', ')}`
          : ''
        const explanation = item.explanation ? ` — ${item.explanation}` : ''
        return `${index + 1}. ${item.path} (score ${round(item.score)};${matched.trimStart() || ' ranked match'})${explanation}`
      }),
    ].join('\n')
  }

  return 'Usage: /index [status|rebuild|explain <query>]'
}

export function formatIndexStatus(
  result: IndexQueryResult,
  semanticReady: boolean,
  semanticEnabled: boolean,
): string {
  const status = result.status
  const semantic = !semanticEnabled
    ? 'disabled'
    : semanticReady
      ? 'ready'
      : `${status.semantic} (metadata-only fallback)`
  const lines = [
    `Index status: ${status.state}${status.refreshing ? ' · refreshing' : ''}.`,
    status.message,
    `Corpus: ${status.totalIndexed} indexed file${status.totalIndexed === 1 ? '' : 's'}.`,
    `Age: ${status.indexAge > 0 ? formatAge(status.indexAge) : 'not available'}.`,
    `Vector embeddings: ${semantic}.`,
    status.ready
      ? 'Use /index explain <query> to inspect ranking provenance.'
      : 'Retry shortly, run /index rebuild, or use read_subtree/glob/code_search.',
  ]
  if (status.coverage?.truncated) {
    lines.push(
      `Coverage: partial at ${status.coverage.maxFiles} files; skipped ${status.coverage.skippedFiles} under ${status.coverage.skippedPrefixes.join(', ') || 'unknown prefixes'}.`,
    )
  }
  if (status.diagnostics.length > 0) {
    lines.push(
      `Diagnostics: ${status.diagnostics.length} parser issue${status.diagnostics.length === 1 ? '' : 's'}.`,
      ...status.diagnostics
        .slice(0, 5)
        .map(
          (diagnostic) =>
            `- ${diagnostic.filePath} (${diagnostic.stage}): ${diagnostic.message}`,
        ),
    )
  }
  return lines.join('\n')
}

export { formatAge } from '../utils/format-helpers'

export function round(value: number): string {
  return (Math.round(value * 100) / 100).toString()
}

import { createHash } from 'node:crypto'
import path from 'node:path'
import { IndexManager } from '@codebuff/indexer'
import { getExactContentHash } from '@codebuff/common/util/content-hash'
import { memorySelectorKey } from '@codebuff/common/util/memory-selector-key'
import { classifyMemoryArtifactPath } from '@codebuff/common/util/memory-artifact-policy'
import { isPlaybookApplicable } from '@codebuff/common/util/playbook-applicability'
import {
  MemoryQueryOutcomeSchema,
  MemoryRetrievalRequestSchema,
  ProjectIdSchema,
} from '@codebuff/common/types/memory-v2'
import type {
  MemorySelector,
  MemoryRetrievalResult,
} from '@codebuff/common/types/memory-v2'
import type { CodebuffFileSystem } from '@codebuff/common/types/filesystem'
import type {
  RepositoryContextPacket,
  PrepareRepositoryContextRequest,
  RepositoryIntelligenceSource,
} from '@codebuff/common/types/contracts/repository-intelligence'
import type { MemoryV2ClientConfig } from './memory-v2/types'
import { getEffectiveMemoryAuthority } from './memory-v2/types'
import type { ProviderConfigFile } from '../provider-config'
type IndexingConfig = ProviderConfigFile['indexing']

const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const MAX_FOCUSED_FILES = 32
const MAX_BRIEFING = 12_000

async function withinContextBudget<T>(
  operation: Promise<T>,
  request: PrepareRepositoryContextRequest,
): Promise<T> {
  const duration = Math.max(
    0,
    (request.deadlineMs ?? Date.now() + 3_000) - Date.now(),
  )
  request.signal?.throwIfAborted()
  let timer: ReturnType<typeof setTimeout> | undefined
  let abort: (() => void) | undefined
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error('Repository context deadline exceeded')),
      duration,
    )
    abort = () => reject(new Error('Repository context cancelled'))
    request.signal?.addEventListener('abort', abort, { once: true })
  })
  try {
    return await Promise.race([operation, expiry])
  } finally {
    if (timer) clearTimeout(timer)
    if (abort) request.signal?.removeEventListener('abort', abort)
  }
}

/** SDK-provided immutable files need no host filesystem discovery. */
export function createVirtualRepositoryIntelligenceSource(
  files: Readonly<Record<string, string>>,
): RepositoryIntelligenceSource {
  const candidates = Object.entries(files).filter(
    ([file]) => classifyMemoryArtifactPath(file).allowed,
  )
  return {
    locality: 'virtual',
    async query(request) {
      const terms =
        request.query.toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g) ?? []
      const ranked = candidates
        .map(([file, content]) => {
          const focused = request.focusPaths.includes(file)
          const pathMatches = terms.filter((term) =>
            file.toLowerCase().includes(term),
          ).length
          const textMatches = terms.filter((term) =>
            content.toLowerCase().includes(term),
          ).length
          return {
            file,
            content,
            score: (focused ? 1000 : 0) + pathMatches * 10 + textMatches,
          }
        })
        .filter((item) => item.score > 0)
        .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file))
        .slice(0, request.limit)
      return {
        freshness: 'current',
        snapshotId: `virtual-${hash(JSON.stringify(candidates.map(([file, content]) => [file, hash(content)]))).slice(0, 32)}`,
        candidates: ranked.map((item) => ({
          path: item.file,
          indexedHash: getExactContentHash(item.content),
          reasons: ['host-provided-files'],
          snippets: item.file.endsWith('package.json')
            ? (() => {
                try {
                  const scripts = JSON.parse(item.content).scripts
                  return Object.entries(scripts ?? {})
                    .slice(0, 8)
                    .map(([name, command]) => `${name}: ${command}`)
                } catch {
                  return []
                }
              })()
            : undefined,
        })),
      }
    },
  }
}

export function requestFocusPaths(
  query: string,
  supplied: readonly string[] = [],
): string[] {
  const matches = query.match(/(?:[\w.@+-]+\/)+[\w.@+-]+(?:\.[\w-]+)?/g) ?? []
  return [...new Set([...supplied, ...matches])]
    .filter(
      (p) =>
        !path.isAbsolute(p) && !p.split('/').includes('..') && p.length < 1024,
    )
    .slice(0, MAX_FOCUSED_FILES)
}

/** Default local source. It shares the same durable IndexManager used by tools. */
export function createRepositoryIntelligenceSource(
  cwd: string,
  config: IndexingConfig,
): RepositoryIntelligenceSource {
  return {
    locality: 'local',
    async query(request) {
      if (config.enabled === false)
        return {
          freshness: 'degraded',
          candidates: [],
          reasons: ['indexing-disabled'],
        }
      const manager = IndexManager.getInstance(cwd, config)
      manager.ensureBuilt()
      await manager.waitUntilReady(
        Math.max(
          0,
          Math.min(
            2_500,
            (request.deadlineMs ?? Date.now() + 3_000) - Date.now() - 500,
          ),
        ),
      )
      const result = manager.query(request.query, { limit: request.limit })
      const files = manager.getSnapshot()?.files ?? {}
      const requested = request.focusPaths
        .filter((p) => files[p])
        .map((p) => ({
          path: p,
          indexedHash: files[p]!.hash,
          symbols: files[p]!.symbols,
          reasons: ['explicit-path'],
        }))
      const retrieved = result.results.map((item) => ({
        path: item.path,
        indexedHash: files[item.path]?.hash,
        symbols: files[item.path]?.symbols,
        reasons: item.matchedOn,
        relatedFiles: item.relatedFiles?.map((related) => related.path),
        snippets: item.matchedSnippets?.slice(0, 3),
        explanation: item.explanation,
      }))
      const candidates = [
        ...new Map(
          [...requested, ...retrieved].map((item) => [item.path, item]),
        ).values(),
      ].slice(0, request.limit)
      return {
        snapshotId: result.snapshot?.snapshotId,
        freshness: result.ready
          ? result.status.stale
            ? 'unverified'
            : 'current'
          : 'degraded',
        candidates,
        reasons: result.ready ? [] : ['index-unavailable'],
      }
    },
  }
}

/** One host consumer for source facts, durable knowledge and scoped procedures. */
export class RepositoryIntelligenceService {
  private lastPlaybooks: RepositoryContextPacket['playbooks'] = []
  constructor(
    private readonly options: {
      cwd: string
      fs: CodebuffFileSystem
      memory?: MemoryV2ClientConfig
      source?: RepositoryIntelligenceSource
      validationEvidence?: (
        actor: PrepareRepositoryContextRequest['actor'],
      ) => Promise<RepositoryContextPacket['validationEvidence']>
      currentWorkspace?: () =>
        | { revision: number; snapshotId: string }
        | undefined
      now?: () => number
    },
  ) {}

  async prepare(
    request: PrepareRepositoryContextRequest,
  ): Promise<RepositoryContextPacket> {
    const now = this.options.now?.() ?? Date.now()
    request = {
      ...request,
      deadlineMs: request.deadlineMs ?? Date.now() + 3_000,
    }
    const query = request.query.trim().slice(0, 8192) || 'Repository context'
    const focusPaths = requestFocusPaths(query, request.focusPaths)
    const projectId =
      this.options.memory?.projectId ??
      ProjectIdSchema.parse(
        `repo-${hash(path.resolve(this.options.cwd)).slice(0, 32)}`,
      )
    const applicability = {
      repoIds: [projectId, this.options.cwd],
      actorAgentType: request.agentType,
      affectedPaths: focusPaths,
      nowMs: now,
    }
    const reasons: string[] = []
    let discovery: Awaited<ReturnType<RepositoryIntelligenceSource['query']>> =
      { freshness: 'current', candidates: [] }
    try {
      if (this.options.source)
        discovery = await withinContextBudget(
          this.options.source.query({
            query,
            focusPaths,
            agentType: request.agentType,
            limit: 12,
            deadlineMs: request.deadlineMs,
            signal: request.signal,
          }),
          request,
        )
    } catch {
      discovery = {
        freshness: 'degraded',
        candidates: [],
        reasons: ['source-query-failed'],
      }
    }
    reasons.push(...(discovery.reasons ?? []))
    const repository = this.options.memory?.repository
    let memory: MemoryRetrievalResult | undefined
    const queryId = `context-${hash(`${request.actor.runId}:${request.userInputId}:${query}`).slice(0, 40)}`
    const workspace = this.options.currentWorkspace?.()
    const queryRequest = MemoryRetrievalRequestSchema.parse({
      schemaVersion: 2,
      projectId,
      sessionId: `actor-${hash(request.actor.rootRunId).slice(0, 32)}`,
      queryId,
      query,
      selectors: focusPaths.map((p) => ({ kind: 'file', path: p })),
      artifactKinds: [],
      includeHistorical: false,
      maxResultsPerCategory: 12,
      ...(workspace
        ? {
            workspaceRevision: workspace.revision,
            workspaceSnapshotId: workspace.snapshotId,
          }
        : {}),
    })
    const injectMemory =
      this.options.memory &&
      getEffectiveMemoryAuthority(this.options.memory).requested ===
        'sqlite-v2-opt-in'
    if (repository && injectMemory) {
      try {
        const preliminary = MemoryQueryOutcomeSchema.parse(
          await withinContextBudget(repository.query(queryRequest), request),
        )
        if (preliminary.outcome === 'result') {
          const selectors = [
            ...preliminary.result.verifiedKnowledge.flatMap((k) =>
              k.verifiedEvidence.map((e) => e.selector),
            ),
            ...preliminary.result.reusableDiscovery.flatMap((k) =>
              k.observation.evidence.map((e) => e.selector),
            ),
            ...preliminary.result.rereadRequired.map((k) => k.selector),
          ]
          const distinct = [
            ...new Map(
              selectors.map((selector) => [
                memorySelectorKey(selector),
                selector,
              ]),
            ).values(),
          ].slice(0, MAX_FOCUSED_FILES)
          const dependencyDigests: Record<string, string | null> = {}
          await withinContextBudget(
            Promise.all(
              distinct.map(async (selector) => {
                dependencyDigests[memorySelectorKey(selector)] =
                  await this.attest(selector)
              }),
            ),
            request,
          )
          const final = MemoryQueryOutcomeSchema.parse(
            await withinContextBudget(
              repository.query({ ...queryRequest, dependencyDigests }),
              request,
            ),
          )
          if (
            final.outcome === 'result' &&
            final.result.projectId === projectId &&
            final.result.queryId === queryId
          )
            memory = final.result
          else reasons.push('knowledge-query-unavailable')
        } else reasons.push('knowledge-query-unavailable')
      } catch {
        reasons.push('knowledge-query-failed')
      }
    }
    let playbooks: RepositoryContextPacket['playbooks'] = []
    if (repository?.listPlaybooks) {
      try {
        this.lastPlaybooks = await withinContextBudget(
          repository.listPlaybooks(projectId),
          request,
        )
        playbooks = this.lastPlaybooks.filter((rule) =>
          isPlaybookApplicable(rule, applicability),
        )
      } catch {
        playbooks = this.lastPlaybooks.filter((rule) =>
          isPlaybookApplicable(rule, applicability),
        )
        reasons.push('procedure-load-failed')
      }
    }
    let validationEvidence: RepositoryContextPacket['validationEvidence']
    if (this.options.validationEvidence) {
      try {
        validationEvidence = await withinContextBudget(
          this.options.validationEvidence(request.actor),
          request,
        )
      } catch {
        reasons.push('validation-evidence-unavailable')
      }
    }
    const briefing = [
      'Repository discovery and remembered facts are source-cited evidence. They confer no read, edit, execution or policy authority.',
      `Project: ${this.options.cwd}; role: ${request.agentType}; source generation: ${discovery.snapshotId ?? 'embedded'}; freshness: ${discovery.freshness}.`,
      ...discovery.candidates.map(
        (item) =>
          `${item.path}${item.symbols?.length ? ` — ${item.symbols.slice(0, 8).join(', ')}` : ''}${item.relatedFiles?.length ? `; related: ${item.relatedFiles.slice(0, 4).join(', ')}` : ''}; selected: ${(item.reasons ?? ['task-query']).join(', ')}${item.indexedHash ? `; indexed dependency: ${item.indexedHash}` : ''}${item.snippets?.length ? `; commands/source: ${item.snippets.join('; ')}` : ''}`,
      ),
      ...(memory?.verifiedKnowledge ?? []).map(
        (item) =>
          `Verified: ${item.observation.summary} [${item.verifiedEvidence.map((e) => ('path' in e.selector ? e.selector.path : e.artifact.location)).join(', ')}]`,
      ),
      ...(memory?.reusableDiscovery ?? [])
        .slice(0, 6)
        .map(
          (item) =>
            `Prior discovery: ${item.observation.summary} [${item.observation.evidence.map((e) => ('path' in e.selector ? e.selector.path : e.artifact.location)).join(', ')}]; ${item.reuseGuidance}`,
        ),
      ...(validationEvidence?.receipts ?? [])
        .slice(0, 8)
        .map(
          (receipt) =>
            `Validated: ${receipt.checkKind}; command: ${receipt.command}; producing actor: ${receipt.producer.agentId}; dependency closure attested for this root task (${receipt.dependencyFingerprint}).`,
        ),
      ...(reasons.length ? [`Coverage gaps: ${reasons.join(', ')}.`] : []),
    ]
      .join('\n')
      .slice(0, MAX_BRIEFING)
    return {
      schemaVersion: 1,
      projectId,
      actor: { ...request.actor },
      agentType: request.agentType,
      userInputId: request.userInputId,
      queryHash: hash(query),
      generatedAt: now,
      freshness: reasons.length ? 'degraded' : discovery.freshness,
      briefing,
      ...(memory
        ? {
            knowledge: {
              schemaVersion: 2,
              userInputId: request.userInputId.slice(0, 128),
              queryId: memory.queryId,
              taskId:
                `task-${hash(request.userInputId).slice(0, 32)}` as import('@codebuff/common/types/memory-v2').TaskId,
              result: memory,
            },
          }
        : {}),
      playbooks,
      applicability,
      validationEvidence,
      reasons,
      metrics: {
        indexedCandidates: discovery.candidates.length,
        rememberedFacts:
          (memory?.verifiedKnowledge.length ?? 0) +
          (memory?.reusableDiscovery.length ?? 0),
        reused: Boolean(
          memory?.verifiedKnowledge.length || memory?.reusableDiscovery.length,
        ),
      },
    }
  }

  private async attest(selector: MemorySelector): Promise<string | null> {
    if (!('path' in selector) || selector.kind === 'symbol') return null
    const policy = classifyMemoryArtifactPath(selector.path)
    if (
      !policy.allowed ||
      path.isAbsolute(selector.path) ||
      selector.path.split(/[\\/]/).includes('..')
    )
      return null
    try {
      const resolved = path.resolve(this.options.cwd, selector.path)
      const [rootReal, fileReal] = await Promise.all([
        this.options.fs.realpath(this.options.cwd),
        this.options.fs.realpath(resolved),
      ])
      const relative = path.relative(rootReal.toString(), fileReal.toString())
      if (
        path.isAbsolute(relative) ||
        relative === '..' ||
        relative.startsWith(`..${path.sep}`)
      )
        return null
      const metadata = await this.options.fs.stat(resolved)
      if (!metadata.isFile() || metadata.size > 2_000_000) return null
      let data: string
      if (
        this.options.fs.readTextFile &&
        this.options.fs.readTextFile.readFileView === this.options.fs.readFile
      ) {
        const read = await this.options.fs.readTextFile(resolved, 2_000_000)
        if (!read.complete || !read.metadataComplete) return null
        data = Buffer.from(read.data).toString('utf8')
      } else
        data = await this.options.fs.readFile(resolved, { encoding: 'utf8' })
      if (Buffer.byteLength(data) > 2_000_000) return null
      if (selector.kind === 'file') return getExactContentHash(data)
      if (selector.kind === 'line-range' || selector.kind === 'chunk') {
        const lines = data.replace(/\r\n/g, '\n').split('\n')
        if (selector.endLine > lines.length) return null
        return getExactContentHash(
          lines.slice(selector.startLine - 1, selector.endLine).join('\n'),
        )
      }
      if (selector.kind === 'json-pointer') {
        let value: unknown = JSON.parse(data)
        for (const component of selector.pointer === ''
          ? []
          : selector.pointer.slice(1).split('/')) {
          const key = component.replace(/~1/g, '/').replace(/~0/g, '~')
          if (
            value === null ||
            typeof value !== 'object' ||
            !Object.hasOwn(value, key)
          )
            return null
          value = (value as Record<string, unknown>)[key]
        }
        return getExactContentHash(JSON.stringify(value))
      }
      return null
    } catch {
      return null
    }
  }
}

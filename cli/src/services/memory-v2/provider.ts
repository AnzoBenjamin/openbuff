import { MemoryV2OperatorService, ProjectIdSchema } from '@openbuff/sdk'

import { getMemoryAuthoritySelection } from '../../utils/env'
import { getProjectRoot, getProjectStorageKey } from '../../project-files'
import {
  BunSQLiteMemoryRepository,
  openBunSQLiteMemoryRepository,
  type BunSQLiteMemoryRepositoryOpenResult,
} from './bun-sqlite-memory-repository'

export type MemoryV2ProviderBundle<
  Repository extends BunSQLiteMemoryRepository = BunSQLiteMemoryRepository,
> = {
  status: 'available'
  requestedAuthority: string
  effectiveAuthority: 'shadow-v2' | 'sqlite-v2-opt-in'
  projectId: ReturnType<typeof ProjectIdSchema.parse>
  repository: Repository
  operator: MemoryV2OperatorService
  /** Releases this acquisition. Safe to call repeatedly. */
  release: () => Promise<void>
}

export type MemoryV2ProviderUnavailable = {
  status: 'unavailable'
  requestedAuthority: string
  effectiveAuthority: 'json-v1' | 'sqlite-v2-opt-in'
  projectId?: ReturnType<typeof ProjectIdSchema.parse>
  reason?: 'invalid-authority' | 'storage-unavailable' | 'reset-during-open'
  degradation: string
  retryable: boolean
}

export type MemoryV2ProviderResult<
  Repository extends BunSQLiteMemoryRepository = BunSQLiteMemoryRepository,
> = MemoryV2ProviderBundle<Repository> | MemoryV2ProviderUnavailable

type RepositoryOpener<Repository extends BunSQLiteMemoryRepository> = (
  root: string,
) => Promise<
  | { status: 'ok'; repository: Repository }
  | Extract<BunSQLiteMemoryRepositoryOpenResult, { status: 'error' }>
>

type Resource<Repository extends BunSQLiteMemoryRepository> = {
  root: string
  authority: 'shadow-v2' | 'sqlite-v2-opt-in'
  requestedAuthority: string
  projectId: ReturnType<typeof ProjectIdSchema.parse>
  repository: Repository
  operator: MemoryV2OperatorService
  leaseCount: number
  retired: boolean
  closePromise: Promise<void> | null
}

type Pending<Repository extends BunSQLiteMemoryRepository> = {
  root: string
  authority: 'shadow-v2' | 'sqlite-v2-opt-in'
  requestedAuthority: string
  projectId: ReturnType<typeof ProjectIdSchema.parse>
  generation: number
  promise: Promise<Resource<Repository> | MemoryV2ProviderUnavailable>
}

const defaultOpener: RepositoryOpener<BunSQLiteMemoryRepository> = (root) =>
  openBunSQLiteMemoryRepository({ repositoryRoot: root })

function projectIdForRoot(root: string): ReturnType<typeof ProjectIdSchema.parse> {
  const storageKey = getProjectStorageKey(root)
  return ProjectIdSchema.parse(`project:${storageKey.slice(0, 96)}:${storageKey.slice(-12)}`)
}

/** Owns project-scoped resources while handing each caller an independent lease. */
export class ProjectMemoryV2Provider<
  Repository extends BunSQLiteMemoryRepository = BunSQLiteMemoryRepository,
> {
  private generation = 0
  private current: Resource<Repository> | null = null
  private pending: Pending<Repository> | null = null

  constructor(private readonly opener: RepositoryOpener<Repository> = defaultOpener as RepositoryOpener<Repository>) {}

  private unavailable(
    requestedAuthority: string,
    authority: 'shadow-v2' | 'sqlite-v2-opt-in',
    projectId: ReturnType<typeof ProjectIdSchema.parse>,
    reason: 'storage-unavailable' | 'reset-during-open',
    retryable: boolean,
  ): MemoryV2ProviderUnavailable {
    if (authority === 'sqlite-v2-opt-in') {
      return {
        status: 'unavailable',
        requestedAuthority,
        effectiveAuthority: authority,
        projectId,
        reason,
        degradation: reason === 'reset-during-open'
          ? 'Memory V2 was reset while opening; V1 remains disabled under opt-in authority.'
          : 'Memory V2 storage is unavailable; V1 remains disabled under opt-in authority.',
        retryable,
      }
    }
    return {
      status: 'unavailable',
      requestedAuthority,
      effectiveAuthority: 'json-v1',
      reason,
      degradation: reason === 'reset-during-open'
        ? 'Memory V2 was reset while opening; continuing with V1 memory.'
        : 'Memory V2 storage is unavailable; continuing with V1 memory.',
      retryable,
    }
  }

  private closeResource(resource: Resource<Repository>): Promise<void> {
    if (!resource.closePromise) {
      resource.closePromise = Promise.resolve().then(() => resource.repository.close())
    }
    return resource.closePromise
  }

  private retire(resource: Resource<Repository>): Promise<void> {
    resource.retired = true
    return resource.leaseCount === 0 ? this.closeResource(resource) : Promise.resolve()
  }

  private acquire(resource: Resource<Repository>): MemoryV2ProviderBundle<Repository> {
    resource.leaseCount++
    let released = false
    return {
      status: 'available',
      requestedAuthority: resource.requestedAuthority,
      effectiveAuthority: resource.authority,
      projectId: resource.projectId,
      repository: resource.repository,
      operator: resource.operator,
      release: async () => {
        if (released) return
        released = true
        resource.leaseCount--
        if (resource.retired && resource.leaseCount === 0) await this.closeResource(resource)
      },
    }
  }

  async open(root: string, authority = getMemoryAuthoritySelection()): Promise<MemoryV2ProviderResult<Repository>> {
    if (authority.effective === 'json-v1') {
      await this.close()
      return {
        status: 'unavailable',
        requestedAuthority: authority.requested,
        effectiveAuthority: 'json-v1',
        ...(authority.reason ? { reason: authority.reason } : {}),
        degradation: authority.reason
          ? 'Invalid memory authority; using V1 memory only.'
          : 'V1 JSON memory is authoritative; SQLite was not opened.',
        retryable: false,
      }
    }

    const effectiveAuthority = authority.effective
    if (this.current?.root === root && this.current.authority === effectiveAuthority && !this.current.retired) {
      return this.acquire(this.current)
    }
    if (this.pending?.root === root && this.pending.authority === effectiveAuthority) {
      const result = await this.pending.promise
      return 'repository' in result ? this.acquire(result) : result
    }
    if (this.current || this.pending) await this.close()

    const generation = this.generation
    const projectId = projectIdForRoot(root)
    const pending: Pending<Repository> = {
      root,
      authority: effectiveAuthority,
      requestedAuthority: authority.requested,
      projectId,
      generation,
      promise: Promise.resolve(null as never),
    }
    pending.promise = this.opener(root).then(async (opened) => {
      if (opened.status === 'error') {
        if (this.pending === pending) this.pending = null
        return this.unavailable(authority.requested, effectiveAuthority, projectId, 'storage-unavailable', opened.error.retryable)
      }
      if (generation !== this.generation || this.pending !== pending) {
        await opened.repository.close()
        return this.unavailable(authority.requested, effectiveAuthority, projectId, 'reset-during-open', true)
      }
      const resource: Resource<Repository> = {
        root,
        authority: effectiveAuthority,
        requestedAuthority: authority.requested,
        projectId,
        repository: opened.repository,
        operator: new MemoryV2OperatorService(opened.repository),
        leaseCount: 0,
        retired: false,
        closePromise: null,
      }
      this.current = resource
      this.pending = null
      return resource
    }).catch(() => {
      if (this.pending === pending) this.pending = null
      return this.unavailable(authority.requested, effectiveAuthority, projectId, 'storage-unavailable', false)
    })
    this.pending = pending
    const result = await pending.promise
    return 'repository' in result ? this.acquire(result) : result
  }

  async close(): Promise<void> {
    this.generation++
    const current = this.current
    this.current = null
    this.pending = null
    if (current) await this.retire(current)
  }
}

const projectMemoryV2Provider = new ProjectMemoryV2Provider()

export function getProjectMemoryV2Provider(
  root = getProjectRoot(),
  authority = getMemoryAuthoritySelection(),
): Promise<MemoryV2ProviderResult> {
  return projectMemoryV2Provider.open(root, authority)
}

export function resetProjectMemoryV2Provider(): Promise<void> {
  return projectMemoryV2Provider.close()
}

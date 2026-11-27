import { randomUUID } from 'node:crypto'
import { constants as fsConstants, promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  withFilesystemSandbox,
  type FilesystemSandboxPolicy,
} from '@codebuff/common/util/filesystem-sandbox'
import { resolveProjectPath } from '@codebuff/common/util/project-path-containment'
import { stableHash } from '@codebuff/common/util/stable-hash'

import {
  captureWorkspaceBootstrapExecution,
  resolveBootstrapWorkspaceIdentity,
} from './workspace-bootstrap'
import {
  errorCode,
  exactHash,
  fileIdentity,
  hasParentIdentity,
  holdMutationDirectory,
  matchesFileIdentity,
  hasFileIdentity,
  permissions,
  readMutationEntry,
  reconcileMutation,
  refuseRecovery,
  stagingName,
  WorkspaceMutationBrokerRecoveryError,
} from './workspace-mutation-recovery'

import type { WorkspaceIdentitySource } from './workspace-bootstrap'
import type {
  MutationDirectory,
  MutationEntry,
  MutationFileIdentity,
  MutationParentIdentity,
} from './workspace-mutation-recovery'
import type { ExecutionAdapterContext } from '@codebuff/common/types/contracts/execution-context'

import type {
  CodebuffConditionalCommitResult,
  CodebuffConditionalDeleteResult,
  CodebuffConditionalMoveResult,
  CodebuffFileContent,
  CodebuffTransactionRestoreGuard,
} from '@codebuff/common/types/filesystem'
import type { BigIntStats, PathLike } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import {
  isTransactionActionId,
  type TransactionActionCorrelation,
  type TransactionMutationEvidence,
  type TransactionStageProof,
} from './transaction-mutation-proof'
import type { TransactionIntentEntry } from '../tools/transaction-intent-log'

export { WorkspaceMutationBrokerRecoveryError } from './workspace-mutation-recovery'

const DEFAULT_LOCK_TIMEOUT_MS = 10_000
const DEFAULT_LOCK_POLL_MS = 20

/** Newest receipts to report from listReceipts (no pruning this session). */
const RECEIPT_LIST_LIMIT = 500
/**
 * Retention cap for finalized receipts (hr-09 P4.3). Receipts accumulated
 * indefinitely; the listing was bounded but the directory was not, so a
 * long-lived workspace grew without limit. Finalizing a receipt now prunes
 * the OLDEST finalized receipts beyond this cap. Deliberately above
 * RECEIPT_LIST_LIMIT so the newest full listing window is always intact.
 */
const RECEIPT_RETENTION_LIMIT = 1000

export const WORKSPACE_MUTATION_AUTHORITY = 'cooperative_cas' as const

type BrokerAction = 'commit' | 'create' | 'delete' | 'move'
type FinalReceiptState =
  | 'committed'
  | 'rejected'
  | 'failed'
  | 'recovered_committed'
  | 'recovered_not_applied'

type PendingReceiptState = 'prepared' | 'recovery_required'

export type WorkspaceMutationReceipt = {
  schemaVersion: 1
  receiptId: string
  brokerRevision: number
  authorityKind: typeof WORKSPACE_MUTATION_AUTHORITY
  repositoryId: string
  workspaceId: string
  action: BrokerAction
  path: string
  /** Optional on disk so legacy pending receipts remain inspectable, not writable. */
  parent?: MutationParentIdentity
  sourceIdentity?: MutationFileIdentity
  sourceBirthtimeNs?: string
  destinationPath?: string
  destinationParent?: MutationParentIdentity
  destinationBeforeHash?: string | null
  expectedHash: string | null
  expectedDestinationHash?: null
  beforeHash: string | null
  beforeMode?: number
  afterHash: string | null
  afterMode?: number
  correlation?: TransactionActionCorrelation
  compensationFor?: string
  /** Synced workspace evidence recorded BEFORE unlinking the verified tombstone. */
  deleteTombstoneVerified?: true
  /** The admitted source and its new link were verified and synced before unlink. */
  moveLinkVerified?: true
  resultIdentity?: MutationFileIdentity & {
    ctimeNs: string
    birthtimeNs: string
    mode: number
  }
  state: FinalReceiptState | PendingReceiptState
  createdAt: string
  updatedAt: string
  stagingPath?: string
  stagingIdentity?: MutationFileIdentity
  stagingBirthtimeNs?: string
  errorCode?: string
}

export type WorkspaceMutationReceiptReference = Pick<
  WorkspaceMutationReceipt,
  'receiptId' | 'brokerRevision' | 'authorityKind'
>

export type WorkspaceMutationCommitResult = CodebuffConditionalCommitResult & {
  receipt: WorkspaceMutationReceiptReference
}

export type WorkspaceMutationDeleteResult = CodebuffConditionalDeleteResult & {
  receipt: WorkspaceMutationReceiptReference
}

export type WorkspaceMutationMoveResult = CodebuffConditionalMoveResult & {
  receipt: WorkspaceMutationReceiptReference
}

export type WorkspaceMutationBrokerOptions = {
  cwd: string
  stateDir: string
  sandboxPolicy?: FilesystemSandboxPolicy
  executionContext?: ExecutionAdapterContext
  lockTimeoutMs?: number
  /** @deprecated Stale locks are never automatically reclaimed. */
  staleLockMs?: number
  lockPollMs?: number
}

type BrokerState = {
  schemaVersion: 1
  revision: number
  updatedAt: string
  /** Keep proof for an unresolved group even if unrelated receipts are pruned. */
  pinnedActions?: Record<string, string>
}

type LockOwner = {
  schemaVersion: 1
  token: string
  pid: number
  acquiredAt: string
}

type MutationPath = { absolutePath: string; relativePath: string }
const hasBirthtime = (value: unknown): value is string =>
  typeof value === 'string' && /^[1-9][0-9]{0,23}$/.test(value)
const sameBirthtime = (
  stat: BigIntStats | null,
  expected: string | undefined,
) => !!stat && hasBirthtime(expected) && String(stat.birthtimeNs) === expected
const hasCorrelation = (
  value: TransactionActionCorrelation | undefined,
): value is TransactionActionCorrelation =>
  !!value &&
  typeof value.transactionId === 'string' &&
  value.transactionId.length > 0 &&
  isTransactionActionId(value.actionId) &&
  Number.isSafeInteger(value.from) &&
  value.from >= 0 &&
  Number.isSafeInteger(value.through) &&
  value.through >= value.from &&
  value.through - value.from <= 1

const registeredBrokers = new WeakSet<WorkspaceMutationBroker>()

const sameParent = (
  actual: MutationParentIdentity | undefined,
  expected: MutationParentIdentity | undefined,
) =>
  hasParentIdentity(actual) &&
  hasParentIdentity(expected) &&
  actual.canonicalPath === expected.canonicalPath &&
  actual.dev === expected.dev &&
  actual.ino === expected.ino

const resultIdentity = (stat: BigIntStats) => ({
  ...fileIdentity(stat),
  ctimeNs: String(stat.ctimeNs),
  birthtimeNs: String(stat.birthtimeNs),
  mode: permissions(stat),
})

function assertRecoveryMode(
  stat: BigIntStats | null,
  expectedMode?: number,
): void {
  if (
    expectedMode !== undefined &&
    (!stat || permissions(stat) !== expectedMode)
  ) {
    refuseRecovery(
      'RECOVERY_MODE_CHANGED',
      'Workspace transaction postimage permissions changed.',
    )
  }
}

function toBytes(content: CodebuffFileContent): Uint8Array {
  if (typeof content === 'string') return Buffer.from(content)
  return new Uint8Array(content.buffer, content.byteOffset, content.byteLength)
}

function pathLikeToString(value: PathLike): string {
  if (typeof value === 'string') return value
  if (Buffer.isBuffer(value)) return value.toString()
  return fileURLToPath(value)
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== '..' &&
      !path.isAbsolute(relative))
  )
}

function receiptReference(
  receipt: WorkspaceMutationReceipt,
): WorkspaceMutationReceiptReference {
  return {
    receiptId: receipt.receiptId,
    brokerRevision: receipt.brokerRevision,
    authorityKind: receipt.authorityKind,
  }
}

async function sleep(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds))
}

/**
 * Cooperative local compare-and-swap authority for participating Openbuff
 * processes. It does not provide kernel-enforced exclusion against arbitrary
 * external editors; workspace watchers and revision checks remain the
 * external-mutation backstop.
 */
export class WorkspaceMutationBroker {
  readonly authorityKind = WORKSPACE_MUTATION_AUTHORITY
  readonly repositoryId: string
  readonly workspaceId: string
  readonly identitySource: WorkspaceIdentitySource
  readonly workspaceRoot: string
  readonly brokerDir: string

  private readonly pendingDir: string
  private readonly receiptsDir: string
  private readonly statePath: string
  private readonly lockPath: string
  private readonly lockTimeoutMs: number
  private readonly lockPollMs: number
  private readonly sandboxPolicy?: FilesystemSandboxPolicy

  private constructor(params: {
    workspaceRoot: string
    stateDir: string
    repositoryId: string
    workspaceId: string
    identitySource: WorkspaceIdentitySource
    lockTimeoutMs: number
    lockPollMs: number
    sandboxPolicy?: FilesystemSandboxPolicy
  }) {
    this.workspaceRoot = params.workspaceRoot
    this.repositoryId = params.repositoryId
    this.workspaceId = params.workspaceId
    this.identitySource = params.identitySource
    this.brokerDir = path.join(
      path.resolve(params.stateDir),
      params.repositoryId,
      'mutation-brokers',
      params.workspaceId,
    )
    this.pendingDir = path.join(this.brokerDir, 'pending')
    this.receiptsDir = path.join(this.brokerDir, 'receipts')
    this.statePath = path.join(this.brokerDir, 'state.json')
    this.lockPath = `${this.brokerDir}.lock`
    this.lockTimeoutMs = params.lockTimeoutMs
    this.lockPollMs = params.lockPollMs
    this.sandboxPolicy =
      params.sandboxPolicy &&
      Object.freeze({
        ...params.sandboxPolicy,
        allowPaths: Object.freeze([...params.sandboxPolicy.allowPaths]),
      })
  }

  static isRegistered(value: unknown): value is WorkspaceMutationBroker {
    return (
      typeof value === 'object' &&
      value !== null &&
      registeredBrokers.has(value as WorkspaceMutationBroker)
    )
  }

  static async create(
    options: WorkspaceMutationBrokerOptions,
  ): Promise<WorkspaceMutationBroker> {
    options = {
      ...options,
      executionContext: captureWorkspaceBootstrapExecution(options),
    }
    const resolvedRoot = path.resolve(options.cwd)
    const workspaceRoot = await fs
      .realpath(resolvedRoot)
      .catch(() => resolvedRoot)
    const resolvedStateDir = path.resolve(options.stateDir)
    const stateDir = await fs
      .realpath(resolvedStateDir)
      .catch(() => resolvedStateDir)
    if (isWithin(workspaceRoot, stateDir)) {
      throw new Error(
        'Workspace mutation broker state must be stored outside the workspace.',
      )
    }
    const identity = await resolveBootstrapWorkspaceIdentity({
      cwd: workspaceRoot,
      executionContext: options.executionContext,
    })
    const broker = new WorkspaceMutationBroker({
      workspaceRoot,
      stateDir,
      repositoryId: identity.repositoryId,
      workspaceId: identity.workspaceId,
      identitySource: identity.identitySource,
      lockTimeoutMs: options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS,
      lockPollMs: options.lockPollMs ?? DEFAULT_LOCK_POLL_MS,
      sandboxPolicy: options.sandboxPolicy,
    })
    await broker.initialize()
    registeredBrokers.add(broker)
    return broker
  }

  async conditionalCommit(
    filePath: PathLike,
    data: CodebuffFileContent,
    expectedHash: string | null,
    recovery?: CodebuffTransactionRestoreGuard,
    forward?: TransactionMutationEvidence,
  ): Promise<WorkspaceMutationCommitResult> {
    return this.commit(filePath, data, expectedHash, recovery, forward)
  }

  private async commit(
    filePath: PathLike,
    data: CodebuffFileContent,
    expectedHash: string | null,
    recovery?: CodebuffTransactionRestoreGuard,
    forward?: TransactionMutationEvidence,
    inverse?: TransactionStageProof,
  ): Promise<WorkspaceMutationCommitResult> {
    const target = this.resolvePath(filePath)
    const bytes = toBytes(data)
    const afterHash = exactHash(bytes)
    const stage =
      forward &&
      this.requireForwardStage(forward, target, expectedHash, afterHash)
    return this.withWorkspaceLock(async () => {
      const parent = stage?.parent ?? this.requireRecoveryParent(recovery)
      const mode = recovery?.mode
      if (
        mode !== undefined &&
        (!Number.isSafeInteger(mode) || mode < 0 || mode > 0xffffffff)
      ) {
        refuseRecovery(
          'RECOVERY_INVALID_MODE',
          'Workspace mutation recovery has an invalid preimage mode.',
        )
      }
      const restoreMode = mode === undefined ? undefined : mode & 0o7777
      // Check a caller's recovery guard before any file I/O in this operation.
      // Also honor outstanding broker receipts before inspecting the CAS basis.
      return this.withMutationDirectories(
        [{ target, parent }],
        async ([directory]) => {
          await this.requireRecoveredWorkspace()
          const entry = directory!.entry(path.basename(target.absolutePath))
          const { stat: before, hash: beforeHash } =
            await readMutationEntry(entry)
          if (inverse) await this.verifyTransactionStageLocked(inverse)
          if (forward && before && !hasBirthtime(String(before.birthtimeNs))) {
            refuseRecovery(
              'RECOVERY_IDENTITY_UNAVAILABLE',
              'This filesystem cannot establish the original file incarnation.',
            )
          }
          assertRecoveryMode(
            before,
            recovery?.expectedMode ??
              (beforeHash === expectedHash ? stage?.beforeMode : undefined),
          )
          const stagedMode =
            restoreMode ?? (before ? permissions(before) & 0o777 : 0o600)
          const afterMode =
            restoreMode ??
            (process.platform === 'win32' ? undefined : stagedMode)
          let receipt = await this.prepareReceipt({
            action: expectedHash === null ? 'create' : 'commit',
            path: target.relativePath,
            parent: entry.directory.identity,
            ...this.withSourceIdentity(before),
            ...(forward ? { correlation: forward.correlation } : {}),
            expectedHash,
            beforeHash,
            afterHash,
            afterMode,
          })
          if (beforeHash !== expectedHash) {
            const rejected = await this.finalizeReceipt(receipt, 'rejected')
            return {
              applied: false,
              actualHash: beforeHash,
              receipt: receiptReference(rejected),
            }
          }

          const staging = entry.directory.entry(
            stagingName(receipt.receiptId, 'tmp'),
          )
          let staged: BigIntStats | undefined
          let mutationVisible = false
          try {
            staged = await this.writeStagedFile(
              staging,
              bytes,
              stagedMode,
              afterMode !== undefined,
            )
            receipt = await this.updatePendingReceipt(receipt, {
              stagingIdentity: fileIdentity(staged),
              stagingBirthtimeNs: String(staged.birthtimeNs),
            })
            if (forward && !hasBirthtime(String(staged.birthtimeNs))) {
              refuseRecovery(
                'RECOVERY_IDENTITY_UNAVAILABLE',
                'This filesystem cannot establish the staging file incarnation.',
              )
            }
            await staging.validate(staged)
            // The exclusive link already checks absence without clobbering. For
            // replacement, recheck the observed basis before the final rename.
            if (inverse) await this.verifyTransactionStageLocked(inverse)
            if (before || inverse) await entry.validate(before)
            if (expectedHash === null) {
              try {
                await fs.link(staging.ioPath, entry.ioPath)
              } catch (error) {
                if (errorCode(error) !== 'EEXIST') throw error
                await this.unlinkStagedFile(staging, fileIdentity(staged))
                staged = undefined
                const { hash: actualHash } = await readMutationEntry(entry)
                const rejected = await this.finalizeReceipt(receipt, 'rejected')
                return {
                  applied: false,
                  actualHash,
                  receipt: receiptReference(rejected),
                }
              }
              mutationVisible = true
              await this.syncMutationDirectory(entry.directory)
              await this.unlinkStagedFile(staging, fileIdentity(staged))
            } else {
              await fs.rename(staging.ioPath, entry.ioPath)
              mutationVisible = true
              await this.syncMutationDirectory(entry.directory)
            }
            const { stat, hash } = await readMutationEntry(entry)
            if (
              !matchesFileIdentity(stat, receipt.stagingIdentity) ||
              (forward && !sameBirthtime(stat, receipt.stagingBirthtimeNs)) ||
              hash !== afterHash ||
              (afterMode !== undefined && permissions(stat!) !== afterMode)
            ) {
              refuseRecovery(
                'POST_COMMIT_STATE_MISMATCH',
                `Mutation ${receipt.receiptId} committed an unexpected workspace state.`,
              )
            }
            const committed = await this.finalizeReceipt(
              this.withResultIdentity(receipt, stat),
              'committed',
            )
            return { applied: true, receipt: receiptReference(committed) }
          } catch (error) {
            if (
              staged &&
              !mutationVisible &&
              !(error instanceof WorkspaceMutationBrokerRecoveryError)
            ) {
              try {
                await this.unlinkStagedFile(staging, fileIdentity(staged))
              } catch (cleanupError) {
                return this.failReceipt(receipt, cleanupError, true)
              }
            }
            return this.failReceipt(receipt, error, mutationVisible)
          }
        },
      )
    })
  }

  async createExclusive(
    filePath: PathLike,
    data: CodebuffFileContent,
    forward?: TransactionMutationEvidence,
  ): Promise<WorkspaceMutationCommitResult> {
    return this.conditionalCommit(filePath, data, null, undefined, forward)
  }

  async conditionalDelete(
    filePath: PathLike,
    expectedHash: string,
    recovery?: Omit<CodebuffTransactionRestoreGuard, 'mode'>,
    forward?: TransactionMutationEvidence,
  ): Promise<WorkspaceMutationDeleteResult> {
    return this.delete(filePath, expectedHash, recovery, forward)
  }

  private async delete(
    filePath: PathLike,
    expectedHash: string,
    recovery?: Omit<CodebuffTransactionRestoreGuard, 'mode'>,
    forward?: TransactionMutationEvidence,
    inverse?: TransactionStageProof,
  ): Promise<WorkspaceMutationDeleteResult> {
    const target = this.resolvePath(filePath)
    const stage =
      forward && this.requireForwardStage(forward, target, expectedHash, null)
    return this.withWorkspaceLock(async () => {
      const parent = stage?.parent ?? this.requireRecoveryParent(recovery)
      return this.withMutationDirectories(
        [{ target, parent }],
        async ([directory]) => {
          await this.requireRecoveredWorkspace()
          const entry = directory!.entry(path.basename(target.absolutePath))
          const { stat: before, hash: beforeHash } =
            await readMutationEntry(entry)
          if (inverse) await this.verifyTransactionStageLocked(inverse)
          if (forward && before && !hasBirthtime(String(before.birthtimeNs))) {
            refuseRecovery(
              'RECOVERY_IDENTITY_UNAVAILABLE',
              'This filesystem cannot establish the deleted file incarnation.',
            )
          }
          assertRecoveryMode(
            before,
            recovery?.expectedMode ??
              (beforeHash === expectedHash ? stage?.beforeMode : undefined),
          )
          let receipt = await this.prepareReceipt({
            action: 'delete',
            path: target.relativePath,
            parent: entry.directory.identity,
            ...this.withSourceIdentity(before),
            ...(forward ? { correlation: forward.correlation } : {}),
            expectedHash,
            beforeHash,
            afterHash: null,
          })
          if (beforeHash !== expectedHash || !before) {
            const rejected = await this.finalizeReceipt(receipt, 'rejected')
            return {
              applied: false,
              actualHash: beforeHash,
              receipt: receiptReference(rejected),
            }
          }

          const tombstone = entry.directory.entry(
            stagingName(receipt.receiptId, 'delete'),
          )
          let mutationVisible = false
          try {
            await tombstone.validate(null)
            if (inverse) await this.verifyTransactionStageLocked(inverse)
            await entry.validate(before)
            await fs.rename(entry.ioPath, tombstone.ioPath)
            mutationVisible = true
            await this.syncMutationDirectory(entry.directory)
            const { stat, hash } = await readMutationEntry(
              tombstone,
              receipt.sourceIdentity,
            )
            if (
              !stat ||
              (forward && !sameBirthtime(stat, receipt.sourceBirthtimeNs)) ||
              hash !== expectedHash ||
              permissions(stat) !== receipt.beforeMode
            ) {
              refuseRecovery(
                'DELETE_TOMBSTONE_HASH_MISMATCH',
                `Delete ${receipt.receiptId} moved unexpected bytes and requires recovery.`,
              )
            }
            await entry.validate(null)
            receipt = await this.updatePendingReceipt(receipt, {
              deleteTombstoneVerified: true,
            })
            await entry.validate(null)
            await tombstone.validate(stat)
            await fs.unlink(tombstone.ioPath)
            await this.syncMutationDirectory(tombstone.directory)
            await entry.validate(null)
            const committed = await this.finalizeReceipt(receipt, 'committed')
            return { applied: true, receipt: receiptReference(committed) }
          } catch (error) {
            return this.failReceipt(receipt, error, mutationVisible)
          }
        },
      )
    })
  }

  async conditionalMove(
    sourcePath: PathLike,
    destinationPath: PathLike,
    expectedSourceHash: string,
    forward?: TransactionMutationEvidence,
  ): Promise<WorkspaceMutationMoveResult> {
    return this.move(sourcePath, destinationPath, expectedSourceHash, forward)
  }

  private async move(
    sourcePath: PathLike,
    destinationPath: PathLike,
    expectedSourceHash: string,
    forward?: TransactionMutationEvidence,
    inverse?: TransactionStageProof,
  ): Promise<WorkspaceMutationMoveResult> {
    const source = this.resolvePath(sourcePath)
    const destination = this.resolvePath(destinationPath)
    const sourceStage =
      forward &&
      this.requireForwardStage(forward, source, expectedSourceHash, null, true)
    const destinationStage =
      forward &&
      this.requireForwardStage(
        forward,
        destination,
        null,
        expectedSourceHash,
        false,
      )
    const inverseStages = inverse && this.transactionStage(inverse).stages
    const sourceParent = sourceStage?.parent ?? inverseStages?.[0]?.parent
    const destinationParent =
      destinationStage?.parent ?? inverseStages?.[1]?.parent
    if (source.absolutePath === destination.absolutePath) {
      throw new Error(
        'Workspace mutation move source and destination must differ.',
      )
    }
    return this.withWorkspaceLock(async () => {
      await this.requireRecoveredWorkspace()
      return this.withMutationDirectories(
        [
          { target: source, parent: sourceParent },
          { target: destination, parent: destinationParent },
        ],
        async ([sourceDir, destinationDir]) => {
          const from = sourceDir!.entry(path.basename(source.absolutePath))
          const to = destinationDir!.entry(
            path.basename(destination.absolutePath),
          )
          const { stat: before, hash: actualSourceHash } =
            await readMutationEntry(from)
          const { hash: actualDestinationHash } = await readMutationEntry(to)
          if (inverse) await this.verifyTransactionStageLocked(inverse)
          if (
            (forward || inverse) &&
            before &&
            !hasBirthtime(String(before.birthtimeNs))
          ) {
            refuseRecovery(
              'RECOVERY_IDENTITY_UNAVAILABLE',
              'This filesystem cannot establish the moved file incarnation.',
            )
          }
          if (actualSourceHash === expectedSourceHash)
            assertRecoveryMode(
              before,
              sourceStage?.beforeMode ?? destinationStage?.afterMode,
            )
          let receipt = await this.prepareReceipt({
            action: 'move',
            path: source.relativePath,
            parent: from.directory.identity,
            ...this.withSourceIdentity(before),
            ...(forward ? { correlation: forward.correlation } : {}),
            ...(inverse
              ? { compensationFor: inverse.evidence.correlation.actionId }
              : {}),
            destinationPath: destination.relativePath,
            destinationParent: to.directory.identity,
            destinationBeforeHash: actualDestinationHash,
            expectedHash: expectedSourceHash,
            expectedDestinationHash: null,
            beforeHash: actualSourceHash,
            afterHash: expectedSourceHash,
          })
          if (
            actualSourceHash !== expectedSourceHash ||
            actualDestinationHash !== null ||
            !before
          ) {
            const rejected = await this.finalizeReceipt(receipt, 'rejected')
            return {
              applied: false,
              actualSourceHash,
              actualDestinationHash,
              receipt: receiptReference(rejected),
            }
          }

          let destinationLinked = false
          try {
            if (inverse) await this.verifyTransactionStageLocked(inverse)
            await to.validate(null)
            await from.validate(before)
            await fs.link(from.ioPath, to.ioPath)
            destinationLinked = true
            await this.syncMutationDirectory(to.directory)
            const { stat: linkedSource, hash: sourceHash } =
              await readMutationEntry(from, receipt.sourceIdentity)
            const { stat: linkedDestination, hash: destinationHash } =
              await readMutationEntry(to, receipt.sourceIdentity)
            if (
              !linkedSource ||
              !linkedDestination ||
              ((forward || inverse) &&
                (!sameBirthtime(linkedSource, receipt.sourceBirthtimeNs) ||
                  !sameBirthtime(
                    linkedDestination,
                    receipt.sourceBirthtimeNs,
                  ))) ||
              sourceHash !== expectedSourceHash ||
              destinationHash !== expectedSourceHash ||
              permissions(linkedDestination) !== receipt.beforeMode
            ) {
              refuseRecovery(
                'MOVE_LINK_STATE_MISMATCH',
                `Move ${receipt.receiptId} linked unexpected workspace state.`,
              )
            }
            if (forward || inverse)
              receipt = await this.updatePendingReceipt(receipt, {
                moveLinkVerified: true,
              })
            await to.validate(linkedDestination)
            await from.validate(linkedSource)
            await fs.unlink(from.ioPath)
            await this.syncMutationDirectory(from.directory)
            await from.validate(null)
            const moved = await readMutationEntry(to, receipt.sourceIdentity)
            if (
              !moved.stat ||
              ((forward || inverse) &&
                !sameBirthtime(moved.stat, receipt.sourceBirthtimeNs)) ||
              moved.hash !== receipt.afterHash ||
              permissions(moved.stat) !== receipt.beforeMode
            )
              refuseRecovery(
                'MOVE_LINK_STATE_MISMATCH',
                'Move lost its destination identity.',
              )
            const committed = await this.finalizeReceipt(
              this.withResultIdentity(receipt, moved.stat),
              'committed',
            )
            return { applied: true, receipt: receiptReference(committed) }
          } catch (error) {
            if (errorCode(error) === 'EEXIST' && !destinationLinked) {
              const currentDestination = await readMutationEntry(to)
              const currentSource = await readMutationEntry(from)
              const rejected = await this.finalizeReceipt(receipt, 'rejected')
              return {
                applied: false,
                actualSourceHash: currentSource.hash,
                actualDestinationHash: currentDestination.hash,
                receipt: receiptReference(rejected),
              }
            }
            // Don't undo a potentially foreign replacement by hash alone. Leave
            // any partial link for the same identity-checked recovery procedure.
            return this.failReceipt(receipt, error, destinationLinked)
          }
        },
      )
    })
  }

  private async failReceipt(
    receipt: WorkspaceMutationReceipt,
    error: unknown,
    mutationVisible: boolean,
  ): Promise<never> {
    const code = errorCode(error)
    if (
      mutationVisible ||
      error instanceof WorkspaceMutationBrokerRecoveryError
    ) {
      await this.updatePendingReceipt(receipt, {
        state: 'recovery_required',
        errorCode: code,
      })
      throw Object.assign(
        new WorkspaceMutationBrokerRecoveryError(
          `Workspace ${receipt.action} ${receipt.receiptId} requires recovery (${code}).`,
          code,
        ),
        { cause: error },
      )
    }
    await this.finalizeReceipt(receipt, 'failed', code)
    throw Object.assign(
      new Error(
        `Workspace ${receipt.action} ${receipt.receiptId} failed (${code}).`,
      ),
      { cause: error },
    )
  }

  async preflightTransactionActions(count: number): Promise<void> {
    await this.withWorkspaceLock(async () => {
      const state = await this.readJson<BrokerState>(this.statePath)
      if (
        !Number.isSafeInteger(count) ||
        count < 1 ||
        Object.keys(this.receiptPins(state)).length + count >
          RECEIPT_RETENTION_LIMIT
      ) {
        refuseRecovery(
          'TRANSACTION_RECEIPT_CAPACITY',
          'Unresolved transaction proofs fill the broker receipt budget.',
        )
      }
      // The workspace intent log admits only one unresolved durable group.
      // Other broker users cannot consume these correlated-action slots.
    })
  }

  /** Receipt membership and the live postimage are verified under the broker lock. */
  async verifyTransactionStage(proof: TransactionStageProof): Promise<void> {
    await this.withWorkspaceLock(async () => {
      await this.requireRecoveredWorkspace()
      await this.verifyTransactionStageLocked(proof)
    })
  }

  async withVerifiedTransactionCommit<T extends { ok: boolean }>(
    proofs: readonly TransactionStageProof[],
    recordCommit: () => Promise<T>,
  ): Promise<T> {
    return this.withWorkspaceLock(async () => {
      await this.requireRecoveredWorkspace()
      const transactionId = proofs[0]?.evidence.correlation.transactionId
      if (
        !transactionId ||
        proofs.some(
          ({ evidence }) =>
            evidence.correlation.transactionId !== transactionId,
        )
      ) {
        refuseRecovery(
          'RECOVERY_INVALID_ACTION',
          'Expected one complete transaction proof set.',
        )
      }
      for (const proof of proofs) await this.verifyTransactionStageLocked(proof)
      const outcome = await recordCommit()
      if (outcome.ok) await this.releaseReceiptPins(transactionId)
      return outcome
    })
  }

  async withVerifiedTransactionAbort<T extends { ok: boolean }>(
    transactionId: string,
    entries: readonly TransactionIntentEntry[],
    recordAbort: () => Promise<T>,
  ): Promise<T> {
    return this.withWorkspaceLock(async () => {
      await this.requireRecoveredWorkspace()
      for (const entry of entries) {
        const target = this.resolveReceiptPath(entry.path)
        if (
          !hasParentIdentity(entry.parent) ||
          !isWithin(this.workspaceRoot, target.absolutePath)
        ) {
          refuseRecovery(
            'RECOVERY_INVALID_ACTION',
            'Transaction preimage path or parent is unavailable.',
          )
        }
        await this.withMutationDirectories(
          [{ target, parent: entry.parent }],
          async ([parent]) => {
            const { stat, hash } = await readMutationEntry(
              parent!.entry(path.basename(target.absolutePath)),
            )
            if (
              entry.beforeHash !== hash ||
              (entry.beforeMode !== undefined &&
                (!stat || permissions(stat) !== entry.beforeMode))
            ) {
              refuseRecovery(
                'RECOVERY_PREIMAGE_CHANGED',
                `Transaction preimage for '${entry.path}' needs operator repair.`,
              )
            }
          },
        )
      }
      const outcome = await recordAbort()
      if (outcome.ok) await this.releaseReceiptPins(transactionId)
      return outcome
    })
  }

  private async releaseReceiptPins(transactionId: string) {
    try {
      const state = await this.readJson<BrokerState>(this.statePath)
      const pinnedActions = this.receiptPins(state)
      const remaining = Object.fromEntries(
        Object.entries(pinnedActions).filter(
          ([, owner]) => owner !== transactionId,
        ),
      )
      if (Object.keys(remaining).length !== Object.keys(pinnedActions).length)
        await this.writeJsonDurable(this.statePath, {
          ...state,
          pinnedActions: remaining,
        })
    } catch {
      // A failed release may consume capacity but must not lose an active proof
      // or undo a terminal intent that was already durably acknowledged.
    }
  }

  private receiptPins(state: BrokerState) {
    const pins = state.pinnedActions ?? {}
    if (
      !pins ||
      typeof pins !== 'object' ||
      Array.isArray(pins) ||
      Object.entries(pins).some(
        ([id, owner]) =>
          !isTransactionActionId(id) || typeof owner !== 'string' || !owner,
      )
    ) {
      refuseRecovery('RECOVERY_INVALID_RECEIPT', 'Invalid broker receipt pins.')
    }
    return pins
  }

  async restoreTransactionStage(proof: TransactionStageProof): Promise<number> {
    const { stage, stages } = this.transactionStage(proof)
    const {
      beforeHash,
      beforeBytes,
      beforeMode,
      afterHash,
      afterMode,
      parent,
    } = stage
    if (afterHash === undefined || !hasParentIdentity(parent))
      return refuseRecovery(
        'RECOVERY_INVALID_ACTION',
        'Transaction stage lacks its guarded postimage.',
      )
    if (stages.length === 2) {
      const [destination, source] = stages
      if (
        stage !== source ||
        !destination ||
        typeof beforeHash !== 'string' ||
        destination.afterHash !== beforeHash
      ) {
        return refuseRecovery(
          'RECOVERY_MOVE_SOURCE_REQUIRED',
          'Recovery must reverse a move as one brokered action, not delete its destination independently.',
        )
      }
      const { applied } = await this.move(
        this.resolveReceiptPath(destination.path).absolutePath,
        proof.fullPath,
        beforeHash,
        undefined,
        proof,
      )
      return applied ? 2 : 0
    }
    const guard = { parent, expectedMode: afterMode }
    if (beforeHash === null && afterHash !== null) {
      return (
        await this.delete(proof.fullPath, afterHash, guard, undefined, proof)
      ).applied
        ? 1
        : 0
    }
    if (
      typeof beforeBytes === 'string' &&
      exactHash(Buffer.from(beforeBytes)) === beforeHash
    ) {
      return (
        await this.commit(
          proof.fullPath,
          beforeBytes,
          afterHash,
          { ...guard, mode: beforeMode },
          undefined,
          proof,
        )
      ).applied
        ? 1
        : 0
    }
    return refuseRecovery(
      'RECOVERY_INVALID_ACTION',
      'Transaction stage lacks its verified preimage.',
    )
  }

  private requireAction(evidence: TransactionMutationEvidence) {
    const { correlation, stages } = evidence
    if (
      !correlation.transactionId ||
      !isTransactionActionId(correlation.actionId) ||
      !Number.isSafeInteger(correlation.from) ||
      correlation.from < 0 ||
      !Number.isSafeInteger(correlation.through) ||
      correlation.through - correlation.from + 1 !== stages.length ||
      (stages.length !== 1 && stages.length !== 2)
    ) {
      refuseRecovery(
        'RECOVERY_INVALID_ACTION',
        'Invalid broker transaction action correlation.',
      )
    }
  }

  private requireForwardStage(
    evidence: TransactionMutationEvidence,
    target: MutationPath,
    beforeHash: string | null,
    afterHash: string | null,
    moveSource?: boolean,
  ): TransactionIntentEntry {
    this.requireAction(evidence)
    const stage = evidence.stages[moveSource ? 1 : 0]
    if (
      evidence.stages.length !== (moveSource === undefined ? 1 : 2) ||
      !stage ||
      stage.path !== target.relativePath ||
      !isWithin(this.workspaceRoot, target.absolutePath) ||
      stage.beforeHash !== beforeHash ||
      stage.afterHash !== afterHash ||
      !hasParentIdentity(stage.parent)
    ) {
      refuseRecovery(
        'RECOVERY_INVALID_ACTION',
        'Transaction action does not match its admitted path or basis.',
      )
    }
    return stage
  }

  private transactionStage(proof: TransactionStageProof) {
    const {
      evidence: { correlation, stages },
      index,
      fullPath,
    } = proof
    this.requireAction(proof.evidence)
    const stage = stages[index - correlation.from]
    if (!stage || !hasParentIdentity(stage.parent))
      return refuseRecovery(
        'RECOVERY_INVALID_ACTION',
        'Missing transaction stage identity.',
      )
    const target = this.resolveReceiptPath(stage.path)
    if (
      target.absolutePath !== fullPath ||
      !isWithin(this.workspaceRoot, target.absolutePath)
    )
      refuseRecovery(
        'RECOVERY_INVALID_ACTION',
        'Transaction stage escaped its verified workspace path.',
      )
    return { target, stage, correlation, stages }
  }

  private async verifyTransactionStageLocked(
    proof: TransactionStageProof,
  ): Promise<void> {
    const { target, stage, correlation, stages } = this.transactionStage(proof)
    const move = stages.length === 2
    const source = stages.at(-1)!
    const destination = move ? stages[0]! : undefined
    const action = move
      ? 'move'
      : source.afterHash === null
        ? 'delete'
        : source.beforeHash === null
          ? 'create'
          : 'commit'
    const absent = () =>
      refuseRecovery(
        'RECOVERY_NO_BROKER_PROOF',
        `No matching durable broker proof for transaction path '${stage.path}'.`,
      )
    const receipt = await this.readActionReceipt(correlation.actionId)
    if (
      !receipt ||
      (receipt.state !== 'committed' &&
        receipt.state !== 'recovered_committed') ||
      receipt.correlation?.transactionId !== correlation.transactionId ||
      receipt.correlation.actionId !== correlation.actionId ||
      receipt.correlation.from !== correlation.from ||
      receipt.correlation.through !== correlation.through ||
      receipt.action !== action ||
      receipt.path !== source.path ||
      !sameParent(receipt.parent, source.parent) ||
      receipt.expectedHash !== source.beforeHash ||
      receipt.beforeHash !== source.beforeHash ||
      receipt.afterHash !==
        (move ? destination!.afterHash : source.afterHash) ||
      (source.beforeHash !== null &&
        (!hasFileIdentity(receipt.sourceIdentity) ||
          !hasBirthtime(receipt.sourceBirthtimeNs) ||
          typeof receipt.beforeMode !== 'number' ||
          (source.beforeMode !== undefined &&
            receipt.beforeMode !== source.beforeMode)))
    ) {
      return absent()
    }
    if (
      action === 'delete' &&
      (receipt.deleteTombstoneVerified !== true || source.beforeHash === null)
    )
      return absent()
    if (
      destination &&
      (receipt.moveLinkVerified !== true ||
        source.afterHash !== null ||
        destination.beforeHash !== null ||
        destination.afterHash !== source.beforeHash ||
        receipt.destinationBeforeHash !== null ||
        receipt.expectedDestinationHash !== null ||
        receipt.destinationPath !== destination.path ||
        !sameParent(receipt.destinationParent, destination.parent))
    )
      return absent()

    const result = destination ?? source
    if (result.afterHash !== null) {
      const identity = move ? receipt.sourceIdentity : receipt.stagingIdentity
      if (
        !hasFileIdentity(identity) ||
        !hasFileIdentity(receipt.resultIdentity) ||
        receipt.resultIdentity.dev !== identity.dev ||
        receipt.resultIdentity.ino !== identity.ino ||
        !hasBirthtime(receipt.resultIdentity.birthtimeNs) ||
        receipt.resultIdentity.birthtimeNs !==
          (move ? receipt.sourceBirthtimeNs : receipt.stagingBirthtimeNs) ||
        typeof receipt.resultIdentity.ctimeNs !== 'string' ||
        typeof receipt.resultIdentity.mode !== 'number' ||
        (result.afterMode !== undefined &&
          receipt.resultIdentity.mode !== result.afterMode) ||
        (receipt.afterMode !== undefined &&
          receipt.resultIdentity.mode !== receipt.afterMode) ||
        (move && receipt.resultIdentity.mode !== receipt.beforeMode)
      )
        return absent()
    }

    const paths = move ? [source, destination!] : [stage]
    await this.withMutationDirectories(
      paths.map((entry) => ({
        target: entry === stage ? target : this.resolveReceiptPath(entry.path),
        parent: entry.parent,
      })),
      async (directories) => {
        for (const [index, entry] of paths.entries()) {
          const leaf = directories[index]!.entry(path.basename(entry.path))
          const observed = await readMutationEntry(leaf)
          if (entry.afterHash === null) {
            if (observed.stat !== null) return absent()
          } else {
            const actual = observed.stat && resultIdentity(observed.stat)
            const expected = receipt.resultIdentity!
            if (
              !actual ||
              observed.hash !== entry.afterHash ||
              actual.dev !== expected.dev ||
              actual.ino !== expected.ino ||
              actual.ctimeNs !== expected.ctimeNs ||
              actual.birthtimeNs !== expected.birthtimeNs ||
              actual.mode !== expected.mode
            )
              return absent()
          }
        }
      },
    )
  }

  private withSourceIdentity(stat: BigIntStats | null) {
    return stat
      ? {
          sourceIdentity: fileIdentity(stat),
          sourceBirthtimeNs: String(stat.birthtimeNs),
          beforeMode: permissions(stat),
        }
      : {}
  }

  private withResultIdentity(
    receipt: WorkspaceMutationReceipt,
    stat: BigIntStats | null,
  ) {
    return receipt.correlation && stat
      ? { ...receipt, resultIdentity: resultIdentity(stat) }
      : receipt
  }

  private async receiptNames(directory: string, id: string) {
    return (await fs.readdir(directory)).filter(
      (name) => /^\d{16}-/.test(name) && name.slice(17) === `${id}.json`,
    )
  }

  private async readActionReceipt(
    id: string,
  ): Promise<WorkspaceMutationReceipt | undefined> {
    if (!isTransactionActionId(id)) return undefined
    const names = await this.receiptNames(this.receiptsDir, id)
    if (names.length !== 1) return undefined
    return this.readNamedReceipt(this.receiptsDir, names[0]!)
  }

  private async readNamedReceipt(
    directory: string,
    name: string,
  ): Promise<WorkspaceMutationReceipt | undefined> {
    const file = path.join(directory, name)
    const named = await fs
      .lstat(file, { bigint: true })
      .catch((error: unknown) => {
        if (errorCode(error) === 'ENOENT') return undefined
        throw error
      })
    if (!named?.isFile() || named.nlink !== 1n) return undefined
    const handle = await fs.open(
      file,
      fsConstants.O_RDONLY |
        (fsConstants.O_NOFOLLOW ?? 0) |
        (fsConstants.O_NONBLOCK ?? 0),
    )
    try {
      const opened = await handle.stat({ bigint: true })
      if (!opened.isFile() || !matchesFileIdentity(opened, fileIdentity(named)))
        return undefined
      const receipt = JSON.parse(
        await handle.readFile('utf8'),
      ) as WorkspaceMutationReceipt
      if (
        !receipt ||
        receipt.schemaVersion !== 1 ||
        !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(
          receipt.receiptId,
        ) ||
        receipt.repositoryId !== this.repositoryId ||
        receipt.workspaceId !== this.workspaceId ||
        receipt.authorityKind !== this.authorityKind ||
        !Number.isSafeInteger(receipt.brokerRevision) ||
        receipt.brokerRevision <= 0 ||
        this.receiptFileName(receipt) !== name
      )
        return undefined
      return receipt
    } finally {
      await handle.close()
    }
  }

  async listReceipts(): Promise<WorkspaceMutationReceipt[]> {
    await fs.mkdir(this.receiptsDir, { recursive: true, mode: 0o700 })
    // Bound the listing: receipts accumulate indefinitely, so report the newest
    // N instead of re-reading every historical receipt (file names sort by
    // zero-padded broker revision, newest last). Malformed receipt files are
    // skipped rather than failing the whole listing.
    const names = (await fs.readdir(this.receiptsDir))
      .filter((name) => name.endsWith('.json'))
      .sort()
      .slice(-RECEIPT_LIST_LIMIT)
    const receipts: WorkspaceMutationReceipt[] = []
    for (const name of names) {
      try {
        receipts.push(
          await this.readJson<WorkspaceMutationReceipt>(
            path.join(this.receiptsDir, name),
          ),
        )
      } catch (error) {
        if (error instanceof SyntaxError) continue
        throw error
      }
    }
    return receipts
  }

  private async initialize(): Promise<void> {
    await this.withWorkspaceLock(async () => {
      await fs.mkdir(this.pendingDir, { recursive: true, mode: 0o700 })
      await fs.mkdir(this.receiptsDir, { recursive: true, mode: 0o700 })
      if (!(await this.exists(this.statePath))) {
        await this.writeJsonDurable(this.statePath, {
          schemaVersion: 1,
          revision: 0,
          updatedAt: new Date().toISOString(),
        } satisfies BrokerState)
      }
      await this.requireRecoveredWorkspace()
    })
  }

  private async withWorkspaceLock<T>(operation: () => Promise<T>): Promise<T> {
    const release = await this.acquireWorkspaceLock()
    try {
      return await operation()
    } finally {
      await release()
    }
  }

  private async acquireWorkspaceLock(): Promise<() => Promise<void>> {
    await fs.mkdir(path.dirname(this.lockPath), {
      recursive: true,
      mode: 0o700,
    })
    const startedAt = Date.now()
    const owner: LockOwner = {
      schemaVersion: 1,
      token: randomUUID(),
      pid: process.pid,
      acquiredAt: new Date().toISOString(),
    }
    while (true) {
      try {
        await fs.mkdir(this.lockPath, { mode: 0o700 })
        await this.writeJsonDurable(
          path.join(this.lockPath, 'owner.json'),
          owner,
        )
        await this.fsyncDirectory(this.lockPath)
        break
      } catch (error) {
        if (errorCode(error) !== 'EEXIST') throw error
        const status = await this.readLockStatus()
        if (status === 'missing') continue
        if (
          status === 'dead' ||
          (status === 'unknown' && Date.now() - startedAt >= this.lockTimeoutMs)
        ) {
          throw new WorkspaceMutationBrokerRecoveryError(
            `Workspace mutation lock requires recovery: '${this.lockPath}' (${status} owner; automatic takeover is disabled).`,
          )
        }
        if (Date.now() - startedAt >= this.lockTimeoutMs) {
          throw new Error(
            `Timed out acquiring workspace mutation lock '${this.lockPath}'.`,
          )
        }
        await sleep(this.lockPollMs)
      }
    }

    // No participant can replace this live ownership: contenders never reclaim.
    // This is cooperative exclusion, not fencing against external lock deletion.
    return async () => {
      try {
        const current = await this.readJson<LockOwner>(
          path.join(this.lockPath, 'owner.json'),
        )
        if (current.token === owner.token) {
          await fs.rm(this.lockPath, { recursive: true, force: true })
          await this.fsyncDirectory(path.dirname(this.lockPath))
        }
      } catch (error) {
        if (errorCode(error) !== 'ENOENT') throw error
      }
    }
  }

  /**
   * Liveness is diagnostic only. No contender may remove an existing lock,
   * even after ESRCH: read/check/unlink is not an atomic ownership transfer.
   * Only the process which exclusively created it may release it. Crashes
   * leave inspectable recovery-required state until explicit resolution.
   */
  private async readLockStatus(): Promise<
    'missing' | 'live' | 'dead' | 'unknown'
  > {
    let owner: LockOwner
    try {
      owner = await this.readJson<LockOwner>(
        path.join(this.lockPath, 'owner.json'),
      )
    } catch (error) {
      if (errorCode(error) !== 'ENOENT' && !(error instanceof SyntaxError)) {
        return 'unknown'
      }
      return (await this.exists(this.lockPath)) ? 'unknown' : 'missing'
    }
    if (
      !owner ||
      owner.schemaVersion !== 1 ||
      typeof owner.token !== 'string' ||
      !owner.token ||
      !Number.isSafeInteger(owner.pid) ||
      owner.pid <= 0
    ) {
      return 'unknown'
    }
    try {
      process.kill(owner.pid, 0)
      return 'live'
    } catch (error) {
      return errorCode(error) === 'ESRCH'
        ? 'dead'
        : errorCode(error) === 'EPERM'
          ? 'live'
          : 'unknown'
    }
  }

  private async requireRecoveredWorkspace(): Promise<void> {
    const unresolved = await this.recoverPendingReceipts()
    if (unresolved.length > 0) {
      throw new WorkspaceMutationBrokerRecoveryError(
        `Workspace mutation recovery is required for receipt(s): ${unresolved.join(', ')}.`,
      )
    }
  }

  private async recoverPendingReceipts(): Promise<string[]> {
    const names = (await fs.readdir(this.pendingDir))
      .filter((name) => name.endsWith('.json'))
      .sort()
    const unresolved: string[] = []
    for (const name of names) {
      const pendingPath = path.join(this.pendingDir, name)
      const receipt = await this.readNamedReceipt(this.pendingDir, name)
      if (
        !receipt ||
        !['prepared', 'recovery_required'].includes(receipt.state) ||
        (receipt.correlation !== undefined &&
          (!hasCorrelation(receipt.correlation) ||
            receipt.correlation.actionId !== receipt.receiptId ||
            (receipt.correlation.through - receipt.correlation.from === 1) !==
              (receipt.action === 'move'))) ||
        (receipt.compensationFor !== undefined &&
          (!isTransactionActionId(receipt.compensationFor) ||
            receipt.action !== 'move'))
      ) {
        refuseRecovery(
          'RECOVERY_INVALID_RECEIPT',
          `Invalid pending mutation receipt '${name}'.`,
        )
      }
      const pins = this.receiptPins(
        await this.readJson<BrokerState>(this.statePath),
      )
      if (pins[receipt.receiptId] !== receipt.correlation?.transactionId) {
        refuseRecovery(
          'RECOVERY_INVALID_RECEIPT',
          `Pending mutation '${name}' has inconsistent ownership.`,
        )
      }
      const finalPath = path.join(this.receiptsDir, name)
      const finalExists = await fs.lstat(finalPath).then(
        () => true,
        (error: unknown) => {
          if (errorCode(error) === 'ENOENT') return false
          throw error
        },
      )
      if (finalExists) {
        const final = await this.readNamedReceipt(this.receiptsDir, name)
        const stable = (r: WorkspaceMutationReceipt) => {
          const { state, errorCode, updatedAt, resultIdentity, ...identity } = r
          return stableHash(
            JSON.stringify(
              Object.entries(identity).sort(([a], [b]) => a.localeCompare(b)),
            ),
          )
        }
        if (
          !final ||
          ![
            'committed',
            'recovered_committed',
            'recovered_not_applied',
            'failed',
            'rejected',
          ].includes(final.state) ||
          stable(final) !== stable(receipt) ||
          (final.correlation &&
            final.state === 'committed' &&
            final.action !== 'delete' &&
            !final.resultIdentity)
        ) {
          refuseRecovery(
            'RECOVERY_INVALID_RECEIPT',
            `Final mutation '${name}' does not match its pending evidence.`,
          )
        }
        // Rename visibility is not durability. Keep pending evidence until the
        // matching final has survived directory fsync and then sync the removal.
        await this.fsyncDirectory(this.receiptsDir)
        await fs.unlink(pendingPath)
        await this.fsyncDirectory(this.pendingDir)
        continue
      }
      const recovered = await this.recoverReceipt(receipt)
      if (!recovered) unresolved.push(receipt.receiptId)
    }
    return unresolved
  }

  private async recoverReceipt(
    receipt: WorkspaceMutationReceipt,
  ): Promise<boolean> {
    let state: 'recovered_committed' | 'recovered_not_applied'
    try {
      const { action } = receipt
      if (
        !hasParentIdentity(receipt.parent) ||
        (action === 'move' && !hasParentIdentity(receipt.destinationParent))
      ) {
        // No current path observation can prove where a legacy receipt was
        // originally prepared. Don't probe or mutate any workspace entry.
        refuseRecovery(
          'RECOVERY_MISSING_PARENT_PROOF',
          'Pending mutation lacks its original parent identity.',
        )
      }
      const target = this.resolveReceiptPath(receipt.path)
      const locations = [{ target, parent: receipt.parent }]
      const destination =
        action === 'move'
          ? this.resolveReceiptPath(receipt.destinationPath)
          : undefined
      if (destination) {
        if (
          target.absolutePath === destination.absolutePath ||
          receipt.stagingPath !== undefined
        ) {
          refuseRecovery(
            'RECOVERY_INVALID_RECEIPT',
            'Invalid move receipt paths.',
          )
        }
        locations.push({
          target: destination,
          parent: receipt.destinationParent!,
        })
      }
      const stage =
        action === 'move'
          ? undefined
          : stagingName(
              receipt.receiptId,
              action === 'delete' ? 'delete' : 'tmp',
            )
      if (
        stage &&
        (stage === path.basename(target.absolutePath) ||
          receipt.stagingPath !==
            this.relativeFromAbsolute(
              path.join(path.dirname(target.absolutePath), stage),
            ))
      ) {
        refuseRecovery(
          'RECOVERY_INVALID_STAGING_PATH',
          'Pending mutation staging path does not match its role and receipt.',
        )
      }
      state = await this.withMutationDirectories(
        locations,
        async ([parent, destinationParent]) => {
          const source = parent!.entry(path.basename(target.absolutePath))
          const other = destination
            ? destinationParent!.entry(path.basename(destination.absolutePath))
            : parent!.entry(stage!)
          const reconciled = await reconcileMutation(
            receipt,
            source,
            other,
            (directory) => this.syncMutationDirectory(directory),
            async (stat) => {
              receipt = await this.updatePendingReceipt(receipt, {
                deleteTombstoneVerified: true,
                beforeMode: permissions(stat),
              })
            },
          )
          if (
            reconciled === 'recovered_committed' &&
            receipt.correlation &&
            action !== 'delete'
          ) {
            const result = action === 'move' ? other : source
            const observed = await readMutationEntry(
              result,
              action === 'move'
                ? receipt.sourceIdentity
                : receipt.stagingIdentity,
            )
            const expectedMode =
              action === 'move' ? receipt.beforeMode : receipt.afterMode
            const expectedBirthtime =
              action === 'move'
                ? receipt.sourceBirthtimeNs
                : receipt.stagingBirthtimeNs
            if (
              !observed.stat ||
              observed.hash !== receipt.afterHash ||
              !hasBirthtime(expectedBirthtime) ||
              String(observed.stat.birthtimeNs) !== expectedBirthtime ||
              (expectedMode !== undefined &&
                permissions(observed.stat) !== expectedMode)
            )
              refuseRecovery(
                'POST_COMMIT_STATE_MISMATCH',
                'Recovered mutation lost its result identity.',
              )
            receipt = this.withResultIdentity(receipt, observed.stat)
          }
          return reconciled
        },
      )
    } catch (error) {
      await this.updatePendingReceipt(receipt, {
        state: 'recovery_required',
        errorCode: errorCode(error),
      })
      return false
    }
    await this.finalizeReceipt(receipt, state)
    return true
  }

  private async prepareReceipt(
    values: Omit<
      WorkspaceMutationReceipt,
      | 'schemaVersion'
      | 'receiptId'
      | 'brokerRevision'
      | 'authorityKind'
      | 'repositoryId'
      | 'workspaceId'
      | 'state'
      | 'createdAt'
      | 'updatedAt'
      | 'stagingPath'
    > & { parent: MutationParentIdentity },
  ): Promise<WorkspaceMutationReceipt> {
    const state = await this.readJson<BrokerState>(this.statePath)
    const now = new Date().toISOString()
    const revision = state.revision + 1
    const receiptId = values.correlation?.actionId ?? randomUUID()
    const pinnedActions = this.receiptPins(state)
    if (
      values.correlation &&
      (Object.hasOwn(pinnedActions, receiptId) ||
        (await this.receiptNames(this.receiptsDir, receiptId)).length)
    )
      refuseRecovery(
        'DUPLICATE_TRANSACTION_ACTION',
        'Transaction action already has a broker receipt.',
      )
    if (
      values.correlation &&
      Object.keys(pinnedActions).length >= RECEIPT_RETENTION_LIMIT
    )
      refuseRecovery(
        'TRANSACTION_RECEIPT_CAPACITY',
        'Unresolved transaction proofs fill the broker receipt budget.',
      )
    const stage =
      values.action === 'move'
        ? undefined
        : stagingName(receiptId, values.action === 'delete' ? 'delete' : 'tmp')
    await this.writeJsonDurable(this.statePath, {
      schemaVersion: 1,
      revision,
      updatedAt: now,
      pinnedActions: values.correlation
        ? { ...pinnedActions, [receiptId]: values.correlation.transactionId }
        : pinnedActions,
    } satisfies BrokerState)
    const receipt: WorkspaceMutationReceipt = {
      schemaVersion: 1,
      receiptId,
      brokerRevision: revision,
      authorityKind: WORKSPACE_MUTATION_AUTHORITY,
      repositoryId: this.repositoryId,
      workspaceId: this.workspaceId,
      state: 'prepared',
      createdAt: now,
      updatedAt: now,
      ...(stage
        ? {
            stagingPath: path.posix.join(
              path.posix.dirname(values.path),
              stage,
            ),
          }
        : {}),
      ...values,
    }
    await this.writeJsonDurable(this.pendingReceiptPath(receipt), receipt)
    return receipt
  }

  private async updatePendingReceipt(
    receipt: WorkspaceMutationReceipt,
    update: Partial<
      Pick<
        WorkspaceMutationReceipt,
        | 'state'
        | 'errorCode'
        | 'stagingIdentity'
        | 'stagingBirthtimeNs'
        | 'beforeMode'
        | 'deleteTombstoneVerified'
        | 'moveLinkVerified'
      >
    >,
  ): Promise<WorkspaceMutationReceipt> {
    const updated = {
      ...receipt,
      ...update,
      updatedAt: new Date().toISOString(),
    }
    await this.writeJsonDurable(this.pendingReceiptPath(updated), updated)
    return updated
  }

  private async finalizeReceipt(
    receipt: WorkspaceMutationReceipt,
    state: FinalReceiptState,
    failureCode?: string,
  ): Promise<WorkspaceMutationReceipt> {
    const finalized: WorkspaceMutationReceipt = {
      ...receipt,
      state,
      updatedAt: new Date().toISOString(),
      ...(failureCode ? { errorCode: failureCode } : { errorCode: undefined }),
    }
    const pendingPath = this.pendingReceiptPath(receipt)
    const finalPath = this.finalReceiptPath(receipt)
    await this.writeJsonDurable(finalPath, finalized)
    await this.removeIfExists(pendingPath)
    await this.fsyncDirectory(this.pendingDir)
    await this.pruneOldReceipts()
    return finalized
  }

  /**
   * Retention prune (hr-09 P4.3): delete the oldest finalized receipts beyond
   * RECEIPT_RETENTION_LIMIT. Best-effort by design — a failed unlink logs and
   * continues (the next finalize retries), never failing the mutation that
   * just succeeded. Never touches the pending dir.
   */
  private async pruneOldReceipts(): Promise<void> {
    let names: string[]
    try {
      names = (await fs.readdir(this.receiptsDir))
        .filter((name) => name.endsWith('.json'))
        .sort()
    } catch {
      return
    }
    if (names.length <= RECEIPT_RETENTION_LIMIT) return
    let prunable: string[]
    try {
      const pins = this.receiptPins(
        await this.readJson<BrokerState>(this.statePath),
      )
      prunable = names.filter(
        (name) => !Object.hasOwn(pins, name.slice(17, -5)),
      )
    } catch {
      return // Unknown retention ownership cannot authorize deletion.
    }
    const excess = prunable.slice(0, names.length - RECEIPT_RETENTION_LIMIT)
    for (const name of excess) {
      try {
        await fs.unlink(path.join(this.receiptsDir, name))
      } catch (error) {
        if (errorCode(error) === 'ENOENT') continue
        // Best-effort: log-free by design (no logger on this class); the
        // next finalize retries the prune.
      }
    }
    await this.fsyncDirectory(this.receiptsDir)
  }

  private receiptFileName(receipt: WorkspaceMutationReceipt): string {
    return `${String(receipt.brokerRevision).padStart(16, '0')}-${receipt.receiptId}.json`
  }

  private pendingReceiptPath(receipt: WorkspaceMutationReceipt): string {
    return path.join(this.pendingDir, this.receiptFileName(receipt))
  }

  private finalReceiptPath(receipt: WorkspaceMutationReceipt): string {
    return path.join(this.receiptsDir, this.receiptFileName(receipt))
  }

  private resolvePath(value: PathLike): MutationPath {
    const raw = pathLikeToString(value)
    const absolutePath = path.resolve(this.workspaceRoot, raw)
    if (
      !raw ||
      raw.includes('\0') ||
      absolutePath === this.workspaceRoot ||
      (!this.sandboxPolicy && !isWithin(this.workspaceRoot, absolutePath))
    ) {
      throw new Error(
        `Workspace mutation path is outside the broker root: ${raw}`,
      )
    }
    return {
      absolutePath,
      relativePath: this.relativeFromAbsolute(absolutePath),
    }
  }

  private relativeFromAbsolute(absolutePath: string): string {
    return path
      .relative(this.workspaceRoot, absolutePath)
      .split(path.sep)
      .join('/')
  }

  private resolveReceiptPath(relativePath: unknown): MutationPath {
    if (
      typeof relativePath === 'string' &&
      relativePath &&
      !relativePath.includes('\0')
    ) {
      const absolutePath = path.resolve(this.workspaceRoot, relativePath)
      if (
        absolutePath !== this.workspaceRoot &&
        this.relativeFromAbsolute(absolutePath) === relativePath &&
        (this.sandboxPolicy || isWithin(this.workspaceRoot, absolutePath))
      ) {
        return { absolutePath, relativePath }
      }
    }
    return refuseRecovery(
      'RECOVERY_INVALID_RECEIPT_PATH',
      'Invalid broker receipt path.',
    )
  }

  private requireRecoveryParent(
    recovery: Pick<CodebuffTransactionRestoreGuard, 'parent'> | undefined,
  ) {
    if (recovery === undefined) return undefined
    if (!hasParentIdentity(recovery?.parent)) {
      refuseRecovery(
        'RECOVERY_MISSING_PARENT_PROOF',
        'Workspace mutation recovery lacks its original parent identity.',
      )
    }
    return recovery.parent
  }

  private async withMutationDirectories<T>(
    locations: readonly {
      target: MutationPath
      parent?: MutationParentIdentity
    }[],
    operation: (directories: MutationDirectory[]) => Promise<T>,
  ): Promise<T> {
    const directories: MutationDirectory[] = []
    try {
      for (const { target, parent } of locations) {
        const directory = await holdMutationDirectory(
          path.dirname(target.absolutePath),
          parent,
        )
        directories.push(directory)
        const canonicalTarget = path.join(
          directory.identity.canonicalPath,
          path.basename(target.absolutePath),
        )
        if (
          !this.isAllowedPath(target.absolutePath) ||
          !this.isAllowedPath(canonicalTarget) ||
          !this.isAllowedPath(directory.identity.canonicalPath)
        ) {
          refuseRecovery(
            'RECOVERY_OUTSIDE_BROKER_ROOT',
            `Workspace mutation path escapes the broker root: ${target.relativePath}`,
          )
        }
      }
      for (const directory of directories) await directory.validate()
      return await operation(directories)
    } finally {
      await Promise.all(directories.map((directory) => directory.close()))
    }
  }

  private isAllowedPath(absolutePath: string): boolean {
    return this.sandboxPolicy
      ? withFilesystemSandbox(
          this.sandboxPolicy,
          () => resolveProjectPath(this.workspaceRoot, absolutePath) !== null,
        )
      : isWithin(this.workspaceRoot, absolutePath)
  }

  private async syncMutationDirectory(
    directory: MutationDirectory,
  ): Promise<void> {
    await directory.validate()
    await this.fsyncDirectory(
      directory.identity.canonicalPath,
      directory.handle,
    )
    await directory.validate()
  }

  private async unlinkStagedFile(
    staging: MutationEntry,
    identity: MutationFileIdentity,
  ): Promise<void> {
    const stat = await staging.stat()
    if (!stat?.isFile() || !matchesFileIdentity(stat, identity)) {
      refuseRecovery(
        'RECOVERY_FOREIGN_STAGING',
        'Workspace mutation staging has lost ownership.',
      )
    }
    await staging.validate(stat)
    await fs.unlink(staging.ioPath)
    await this.syncMutationDirectory(staging.directory)
  }

  private async writeStagedFile(
    staging: MutationEntry,
    bytes: Uint8Array,
    mode: number,
    requireMode: boolean,
  ): Promise<BigIntStats> {
    await staging.directory.validate()
    const handle = await fs.open(staging.ioPath, 'wx', 0o600)
    try {
      const created = await handle.stat({ bigint: true })
      await staging.validate(created)
      await handle.writeFile(bytes)
      await handle.chmod(mode)
      await handle.sync()
      const staged = await handle.stat({ bigint: true })
      await staging.validate(staged)
      if (requireMode && permissions(staged) !== mode) {
        throw new Error(
          'The workspace cannot represent the requested preimage mode.',
        )
      }
      return staged
    } catch (error) {
      try {
        await this.unlinkStagedFile(
          staging,
          fileIdentity(await handle.stat({ bigint: true })),
        )
      } catch (cleanupError) {
        refuseRecovery(
          errorCode(cleanupError),
          'Workspace mutation could not safely remove an incomplete staging file.',
        )
      }
      throw error
    } finally {
      await handle.close()
    }
  }

  private async writeJsonDurable(
    filePath: string,
    value: unknown,
  ): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 })
    const tempPath = `${filePath}.tmp.${process.pid}.${randomUUID()}`
    const handle = await fs.open(tempPath, 'wx', 0o600)
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    try {
      await fs.rename(tempPath, filePath)
      await this.fsyncDirectory(path.dirname(filePath))
    } catch (error) {
      await this.removeIfExists(tempPath).catch(() => undefined)
      throw error
    }
  }

  private async fsyncDirectory(
    directory: string,
    held?: FileHandle,
  ): Promise<void> {
    if (held) {
      await held.sync()
      return
    }
    let handle
    try {
      handle = await fs.open(directory, 'r')
      await handle.sync()
    } catch (error) {
      const code = errorCode(error)
      if (
        process.platform === 'win32' &&
        ['EACCES', 'EBADF', 'EINVAL', 'ENOTSUP', 'EPERM'].includes(code)
      ) {
        return
      }
      throw error
    } finally {
      await handle?.close()
    }
  }

  private async readJson<T>(filePath: string): Promise<T> {
    return JSON.parse(await fs.readFile(filePath, 'utf8')) as T
  }

  private async exists(filePath: string): Promise<boolean> {
    try {
      await fs.stat(filePath)
      return true
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return false
      throw error
    }
  }

  private async removeIfExists(filePath: string): Promise<void> {
    try {
      await fs.unlink(filePath)
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error
    }
  }
}

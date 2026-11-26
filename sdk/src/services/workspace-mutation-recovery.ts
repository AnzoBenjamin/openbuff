import { createHash } from 'node:crypto'
import { constants, promises as fs } from 'node:fs'
import path from 'node:path'

import type { BigIntStats } from 'node:fs'
import type { WorkspaceMutationReceipt } from './workspace-mutation-broker'
import type { FileHandle } from 'node:fs/promises'

export type MutationFileIdentity = { dev: string; ino: string }
export type MutationParentIdentity = MutationFileIdentity & {
  canonicalPath: string
}

export class WorkspaceMutationBrokerRecoveryError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message)
    this.name = 'WorkspaceMutationBrokerRecoveryError'
  }
}

export function refuseRecovery(code: string, message: string): never {
  throw new WorkspaceMutationBrokerRecoveryError(message, code)
}

export function errorCode(error: unknown): string {
  return error instanceof Error && 'code' in error
    ? String((error as NodeJS.ErrnoException).code ?? error.name)
    : error instanceof Error
      ? error.name
      : 'UNKNOWN'
}

export function exactHash(content: Uint8Array): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`
}

export function fileIdentity(stat: BigIntStats): MutationFileIdentity {
  return { dev: String(stat.dev), ino: String(stat.ino) }
}

export function hasFileIdentity(value: unknown): value is MutationFileIdentity {
  if (!value || typeof value !== 'object') return false
  const { dev, ino } = value as Partial<MutationFileIdentity>
  return (
    typeof dev === 'string' &&
    /^\d+$/.test(dev) &&
    typeof ino === 'string' &&
    /^[1-9]\d*$/.test(ino)
  )
}

export function hasParentIdentity(
  value: unknown,
): value is MutationParentIdentity {
  return (
    hasFileIdentity(value) &&
    typeof (value as MutationParentIdentity).canonicalPath === 'string'
  )
}

export function matchesFileIdentity(
  stat: BigIntStats | null,
  identity: MutationFileIdentity | undefined,
): boolean {
  return (
    !!stat &&
    !!identity &&
    String(stat.dev) === identity.dev &&
    String(stat.ino) === identity.ino
  )
}

export function permissions(stat: BigIntStats): number {
  return Number(stat.mode & 0o7777n)
}

function sameGeneration(
  first: BigIntStats | null,
  second: BigIntStats | null,
): boolean {
  if (first === null || second === null) return first === second
  return (
    first.dev === second.dev &&
    first.ino === second.ino &&
    first.size === second.size &&
    first.mode === second.mode &&
    first.mtimeNs === second.mtimeNs &&
    first.ctimeNs === second.ctimeNs
  )
}

export type MutationDirectory = {
  identity: MutationParentIdentity
  handle?: FileHandle
  validate(): Promise<void>
  entry(name: string): MutationEntry
  close(): Promise<void>
}

export type MutationEntry = {
  directory: MutationDirectory
  ioPath: string
  stat(): Promise<BigIntStats | null>
  validate(expected: BigIntStats | null): Promise<void>
  hash(expected: BigIntStats): Promise<string>
}

const noFollow = constants.O_NOFOLLOW ?? 0
const nonBlock = constants.O_NONBLOCK ?? 0

/**
 * With Linux procfs, every leaf operation is relative to the same held,
 * no-follow directory. Rechecks detect observed directory relocation and leaf
 * replacement, not every interleaving with an external writer (there is no
 * portable inode-conditional unlink/rename). Non-Linux uses checked canonical
 * paths plus lstat/fstat, with no equivalent parent pinning.
 */
export async function holdMutationDirectory(
  lexicalPath: string,
  expected?: MutationParentIdentity,
): Promise<MutationDirectory> {
  const parentChanged = () =>
    refuseRecovery(
      'RECOVERY_PARENT_CHANGED',
      `Workspace mutation parent is missing, symlinked, or replaced: '${lexicalPath}'.`,
    )
  const parentError = (error: unknown): never => {
    if (['ENOENT', 'ENOTDIR', 'ELOOP'].includes(errorCode(error)))
      return parentChanged()
    throw error
  }
  const canonicalPath = await fs.realpath(lexicalPath).catch(parentError)
  if (
    expected &&
    (lexicalPath !== canonicalPath || expected.canonicalPath !== canonicalPath)
  ) {
    parentChanged()
  }

  let handle: FileHandle | undefined
  try {
    if (process.platform === 'linux') {
      if (!noFollow || !nonBlock || !constants.O_DIRECTORY) {
        refuseRecovery(
          'RECOVERY_DIRECTORY_UNAVAILABLE',
          'No-follow Linux directory access is unavailable.',
        )
      }
      handle = await fs
        .open(
          canonicalPath,
          constants.O_RDONLY | constants.O_DIRECTORY | noFollow,
        )
        .catch(parentError)
    }
    const initial = await (
      handle
        ? handle.stat({ bigint: true })
        : fs.lstat(canonicalPath, { bigint: true })
    ).catch(parentError)
    const identity = { canonicalPath, ...fileIdentity(initial) }
    if (
      !initial.isDirectory() ||
      (expected && !matchesFileIdentity(initial, expected))
    ) {
      parentChanged()
    }
    if (!hasFileIdentity(identity)) {
      refuseRecovery(
        'RECOVERY_DIRECTORY_UNAVAILABLE',
        'Workspace mutation parent has no usable file identity.',
      )
    }
    const ioDirectory = handle ? `/proc/self/fd/${handle.fd}` : canonicalPath
    const directory: MutationDirectory = {
      identity,
      handle,
      async validate() {
        if (
          (await fs.realpath(lexicalPath).catch(parentError)) !== canonicalPath
        )
          parentChanged()
        const named = await fs
          .lstat(canonicalPath, { bigint: true })
          .catch(parentError)
        if (!named.isDirectory() || !matchesFileIdentity(named, identity))
          parentChanged()
        if (
          handle &&
          (await fs.readlink(ioDirectory).catch(parentError)) !== canonicalPath
        )
          parentChanged()
      },
      entry: (name) => mutationEntry(directory, path.join(ioDirectory, name)),
      close: async () => {
        await handle?.close()
      },
    }
    await directory.validate()
    return directory
  } catch (error) {
    await handle?.close()
    throw error
  }
}

function mutationEntry(
  directory: MutationDirectory,
  ioPath: string,
): MutationEntry {
  const changed = () =>
    refuseRecovery(
      'RECOVERY_ENTRY_CHANGED',
      `Workspace mutation entry changed: '${path.basename(ioPath)}'.`,
    )
  return {
    directory,
    ioPath,
    async stat() {
      try {
        return await fs.lstat(ioPath, { bigint: true })
      } catch (error) {
        if (errorCode(error) === 'ENOENT') return null
        throw error
      }
    },
    async validate(expected) {
      await directory.validate()
      if (!sameGeneration(expected, await this.stat())) changed()
    },
    async hash(expected) {
      if (!expected.isFile()) {
        refuseRecovery(
          'RECOVERY_UNSAFE_ENTRY',
          `Workspace mutation requires a regular file: '${path.basename(ioPath)}'.`,
        )
      }
      await this.validate(expected)
      const handle = await fs.open(
        ioPath,
        constants.O_RDONLY | noFollow | nonBlock,
      )
      try {
        const opened = await handle.stat({ bigint: true })
        if (!opened.isFile() || !sameGeneration(expected, opened)) changed()
        await this.validate(expected)
        const hash = exactHash(await handle.readFile())
        if (!sameGeneration(opened, await handle.stat({ bigint: true })))
          changed()
        await this.validate(expected)
        return hash
      } finally {
        await handle.close()
      }
    },
  }
}

export function stagingName(receiptId: string, role: 'tmp' | 'delete'): string {
  return `.openbuff-mutation-${receiptId}.${role}`
}

/** Read an attested regular entry or verify absence without following a link. */
export async function readMutationEntry(
  entry: MutationEntry,
  expectedIdentity?: MutationFileIdentity,
): Promise<{ stat: BigIntStats | null; hash: string | null }> {
  await entry.directory.validate()
  const stat = await entry.stat()
  if (!stat) {
    await entry.validate(null)
    return { stat: null, hash: null }
  }
  if (expectedIdentity && !matchesFileIdentity(stat, expectedIdentity)) {
    refuseRecovery(
      'RECOVERY_ENTRY_CHANGED',
      'Mutation entry no longer has the recorded identity.',
    )
  }
  return { stat, hash: await entry.hash(stat) }
}

/** Only mutate an owned staging/link entry after checking both held locations. */
export async function reconcileMutation(
  receipt: WorkspaceMutationReceipt,
  target: MutationEntry,
  other: MutationEntry,
  sync: (directory: MutationDirectory) => Promise<void>,
  recordVerifiedTombstone: (stat: BigIntStats) => Promise<void>,
): Promise<'recovered_committed' | 'recovered_not_applied'> {
  const validHash = (hash: unknown) =>
    hash === null ||
    (typeof hash === 'string' && /^sha256:[a-f0-9]{64}$/.test(hash))
  if (
    !validHash(receipt.expectedHash) ||
    !validHash(receipt.beforeHash) ||
    !validHash(receipt.afterHash) ||
    !['delete', 'move', 'create', 'commit'].includes(receipt.action) ||
    (receipt.beforeHash !== null && !hasFileIdentity(receipt.sourceIdentity))
  ) {
    refuseRecovery(
      'RECOVERY_INVALID_RECEIPT',
      'Pending mutation has incomplete basis or result identity.',
    )
  }

  const observed = await readMutationEntry(target)
  const mustProveIncarnation =
    !!receipt.correlation || !!receipt.compensationFor
  const matchesIncarnation = (
    stat: BigIntStats | null,
    identity: MutationFileIdentity | undefined,
    birthtimeNs: string | undefined,
  ) =>
    matchesFileIdentity(stat, identity) &&
    (birthtimeNs === undefined
      ? !mustProveIncarnation
      : (!mustProveIncarnation || stat!.birthtimeNs > 0n) &&
        String(stat!.birthtimeNs) === birthtimeNs)
  const atBefore =
    observed.hash === receipt.beforeHash &&
    (observed.stat === null ||
      matchesIncarnation(
        observed.stat,
        receipt.sourceIdentity,
        receipt.sourceBirthtimeNs,
      ))
  const sameAdmittedBasis = receipt.beforeHash === receipt.expectedHash

  if (receipt.action === 'move') {
    const destination = await readMutationEntry(other)
    if (
      sameAdmittedBasis &&
      receipt.destinationBeforeHash === null &&
      receipt.expectedDestinationHash === null &&
      receipt.afterHash !== null &&
      receipt.afterHash === receipt.beforeHash &&
      ((!receipt.correlation && !receipt.compensationFor) ||
        receipt.moveLinkVerified === true) &&
      destination.hash === receipt.afterHash &&
      matchesIncarnation(
        destination.stat,
        receipt.sourceIdentity,
        receipt.sourceBirthtimeNs,
      ) &&
      (receipt.beforeMode === undefined ||
        permissions(destination.stat!) === receipt.beforeMode)
    ) {
      if (observed.stat === null) {
        await sync(other.directory)
        await sync(target.directory)
        await other.validate(destination.stat)
        await target.validate(null)
        return 'recovered_committed'
      }
      if (atBefore) {
        await sync(other.directory)
        await other.validate(destination.stat)
        await target.validate(observed.stat)
        await fs.unlink(target.ioPath)
        await sync(target.directory)
        return 'recovered_committed'
      }
    }
    if (
      atBefore &&
      receipt.destinationBeforeHash === null &&
      destination.stat === null
    )
      return 'recovered_not_applied'
    return refuseRecovery(
      'AMBIGUOUS_MOVE_STATE',
      'Pending move does not match its owned before or after state.',
    )
  }

  await other.directory.validate()
  const staged = await other.stat()
  if (staged) {
    const stagingIdentity =
      receipt.action === 'delete'
        ? receipt.sourceIdentity
        : receipt.stagingIdentity
    if (
      !sameAdmittedBasis ||
      !staged.isFile() ||
      !hasFileIdentity(stagingIdentity) ||
      !matchesIncarnation(
        staged,
        stagingIdentity,
        receipt.action === 'delete'
          ? receipt.sourceBirthtimeNs
          : receipt.stagingBirthtimeNs,
      )
    ) {
      refuseRecovery(
        'RECOVERY_FOREIGN_STAGING',
        'Pending mutation staging has no proven ownership.',
      )
    }
    const expectedStageHash =
      receipt.action === 'delete' ? receipt.beforeHash : receipt.afterHash
    if (
      (await other.hash(staged)) !== expectedStageHash ||
      (receipt.action === 'delete'
        ? receipt.beforeMode !== undefined &&
          permissions(staged) !== receipt.beforeMode
        : receipt.afterMode !== undefined &&
          permissions(staged) !== receipt.afterMode)
    ) {
      refuseRecovery(
        'RECOVERY_FOREIGN_STAGING',
        'Pending mutation staging bytes or mode changed.',
      )
    }
  }

  if (receipt.action === 'delete') {
    if (receipt.afterHash !== null || receipt.expectedHash === null) {
      refuseRecovery(
        'RECOVERY_INVALID_RECEIPT',
        'Invalid deletion receipt basis.',
      )
    }
    if (
      observed.stat === null &&
      sameAdmittedBasis &&
      (staged || receipt.deleteTombstoneVerified === true)
    ) {
      await sync(other.directory)
      if (staged) {
        await target.validate(null)
        await other.validate(staged)
        await recordVerifiedTombstone(staged)
        await target.validate(null)
        await other.validate(staged)
        await fs.unlink(other.ioPath)
        await sync(other.directory)
      }
      await target.validate(null)
      return 'recovered_committed'
    }
    if (!staged && atBefore) return 'recovered_not_applied'
    return refuseRecovery(
      'AMBIGUOUS_DELETE_STATE',
      'Pending deletion does not match its owned before or after state.',
    )
  }

  const atAfter =
    sameAdmittedBasis &&
    receipt.afterHash !== null &&
    observed.hash === receipt.afterHash &&
    matchesIncarnation(
      observed.stat,
      receipt.stagingIdentity,
      receipt.stagingBirthtimeNs,
    ) &&
    (receipt.afterMode === undefined ||
      permissions(observed.stat!) === receipt.afterMode)
  if (!atBefore && !atAfter) {
    refuseRecovery(
      'AMBIGUOUS_COMMIT_STATE',
      'Pending commit does not match its owned before or after state.',
    )
  }
  if (staged) {
    await target.validate(observed.stat)
    await other.validate(staged)
    await fs.unlink(other.ioPath)
    await sync(other.directory)
  }
  if (atAfter) {
    await sync(target.directory)
    // A completed create may still have its staging hard link. Removing our
    // link changes ctime, so check the same inode, bytes and mode again rather
    // than requiring the pre-unlink generation to survive our own cleanup.
    if (
      staged &&
      matchesFileIdentity(staged, receipt.stagingIdentity) &&
      matchesFileIdentity(observed.stat, receipt.stagingIdentity)
    ) {
      const cleaned = await readMutationEntry(target, receipt.stagingIdentity)
      if (
        !cleaned.stat ||
        cleaned.hash !== receipt.afterHash ||
        permissions(cleaned.stat) !== permissions(observed.stat!)
      ) {
        refuseRecovery(
          'POST_COMMIT_STATE_MISMATCH',
          'Recovered create lost its result identity.',
        )
      }
    } else {
      await target.validate(observed.stat)
    }
  }
  return atAfter ? 'recovered_committed' : 'recovered_not_applied'
}

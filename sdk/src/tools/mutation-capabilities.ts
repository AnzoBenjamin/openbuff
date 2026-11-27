import {
  encodeReadCapabilityToken,
  hasAuthoritativeReadCapabilityScope,
} from '@codebuff/common/util/content-hash'
import {
  captureTextDocument,
  getRawReadBasis,
} from '@codebuff/common/util/byte-text'

import {
  FILESYSTEM_RESULT_CONTENT_MAX_BYTES,
  type WholeFileCapabilityV1,
} from '@codebuff/common/tools/results/filesystem'
import type { ReadCapabilityIssuer } from '@codebuff/common/util/content-hash'
import type { RawReadBasisV1 } from '@codebuff/common/util/raw-read-basis'

export type FreshWholeFileMutationAuthority = {
  afterContent: string
  capability: WholeFileCapabilityV1
  editAnchor: {
    startLine: number
    endLine: number
    contentHash: string
    readCapability: string
    rawBasis: RawReadBasisV1
  }
}

export function buildFreshWholeFileMutationAuthority(params: {
  canonicalPath: string
  path: string
  content: string
  confirmedAfterHash?: string | null
  capabilityIssuer?: ReadCapabilityIssuer
}): FreshWholeFileMutationAuthority | undefined {
  if (
    !params.capabilityIssuer ||
    !hasAuthoritativeReadCapabilityScope({
      ...params.capabilityIssuer,
      path: params.path,
    }) ||
    Buffer.byteLength(params.content) > FILESYSTEM_RESULT_CONTENT_MAX_BYTES
  ) {
    return undefined
  }
  let document
  try {
    document = captureTextDocument(params.content)
  } catch {
    return undefined
  }
  if (params.confirmedAfterHash !== document.rawHash) return undefined
  const capability = buildFreshWholeFileCapability({
    ...params,
    capabilityIssuer: params.capabilityIssuer,
  })
  const decodedHash = document.observationHash
  const endLine = document.maxCapabilityLine
  return {
    afterContent: params.content,
    capability,
    editAnchor: {
      startLine: 1,
      endLine,
      contentHash: decodedHash,
      readCapability: capability.token,
      rawBasis: getRawReadBasis(document, 1, endLine, 'whole'),
    },
  }
}

export function buildFreshWholeFileCapability(params: {
  canonicalPath: string
  path: string
  content: string
  confirmedAfterHash?: string | null
  capabilityIssuer: ReadCapabilityIssuer
}): WholeFileCapabilityV1 {
  const { canonicalPath, path, content, capabilityIssuer } = params
  const document = captureTextDocument(content)
  if (params.confirmedAfterHash !== document.rawHash) {
    throw new Error(
      'Fresh mutation authority requires a confirmed exact after-hash',
    )
  }
  const readContentHash = document.observationHash
  const snapshotContentHash = document.rawHash
  const endLine = document.maxCapabilityLine
  const rawBasis = getRawReadBasis(document, 1, endLine, 'whole')
  return {
    kind: 'whole_file',
    version: 1,
    token: encodeReadCapabilityToken({
      startLine: 1,
      endLine,
      hash: readContentHash,
      scope: {
        ...capabilityIssuer,
        path,
      },
      rawBasis,
    }),
    snapshot: {
      kind: 'file_snapshot',
      version: 1,
      canonicalPath,
      contentHash: snapshotContentHash,
      sizeBytes: document.byteLength,
      encoding: 'utf8',
      readGeneration: Date.now(),
    },
  }
}

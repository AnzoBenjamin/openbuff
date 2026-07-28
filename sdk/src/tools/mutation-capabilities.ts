import {
  encodeReadCapabilityToken,
  getContentHash,
  getExactContentHash,
  hasAuthoritativeReadCapabilityScope,
  normalizeLineEndings,
} from '@codebuff/common/util/content-hash'

import {
  FILESYSTEM_RESULT_CONTENT_MAX_BYTES,
  type WholeFileCapabilityV1,
} from '@codebuff/common/tools/results/filesystem'
import type { ReadCapabilityIssuer } from '@codebuff/common/util/content-hash'

export type FreshWholeFileMutationAuthority = {
  afterContent: string
  capability: WholeFileCapabilityV1
  editAnchor: {
    startLine: number
    endLine: number
    contentHash: string
    readCapability: string
  }
}

export function buildFreshWholeFileMutationAuthority(params: {
  canonicalPath: string
  path: string
  content: string
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
  const capability = buildFreshWholeFileCapability({
    ...params,
    capabilityIssuer: params.capabilityIssuer,
  })
  const decodedHash = getContentHash(params.content)
  const endLine = normalizeLineEndings(params.content).split('\n').length
  return {
    afterContent: params.content,
    capability,
    editAnchor: {
      startLine: 1,
      endLine,
      contentHash: decodedHash,
      readCapability: capability.token,
    },
  }
}

export function buildFreshWholeFileCapability(params: {
  canonicalPath: string
  path: string
  content: string
  capabilityIssuer: ReadCapabilityIssuer
}): WholeFileCapabilityV1 {
  const { canonicalPath, path, content, capabilityIssuer } = params
  const readContentHash = getContentHash(content)
  const snapshotContentHash = getExactContentHash(content)
  const endLine = normalizeLineEndings(content).split('\n').length
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
    }),
    snapshot: {
      kind: 'file_snapshot',
      version: 1,
      canonicalPath,
      contentHash: snapshotContentHash,
      sizeBytes: Buffer.byteLength(content),
      encoding: 'utf8',
      readGeneration: Date.now(),
    },
  }
}

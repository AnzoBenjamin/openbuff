import {
  decodeReadCapabilityToken,
  getContentHash,
  readCapabilityMatchesScope,
} from '@codebuff/common/util/content-hash'
import {
  captureTextDocument,
  getRawReadBasis,
  reanchorRawReadCapability,
} from '@codebuff/common/util/byte-text'
import { rawReadBasesMatch } from '@codebuff/common/util/raw-read-basis'

import type {
  ReadFilesEditAnchor,
  ReadFilesItemV1,
} from '@codebuff/common/tools/results/filesystem'
import type { ReadCapabilityIssuer } from '@codebuff/common/util/content-hash'
import type { CapturedTextDocument } from '@codebuff/common/util/byte-text'

/** Authenticate the host's original observation before storing or transporting authority. */
export function authenticateReadFilesItem(
  item: ReadFilesItemV1,
  issuer: ReadCapabilityIssuer,
): ReadFilesEditAnchor | undefined {
  if (
    item.status !== 'ok' ||
    (item.selector !== 'file' && item.selector !== 'range') ||
    !item.complete ||
    item.metadataComplete !== true ||
    !item.editAnchor
  )
    return undefined
  const anchor = item.editAnchor
  const capability = decodeReadCapabilityToken(anchor.readCapability)
  if (
    typeof capability === 'string' ||
    capability.tokenVersion !== 'v4' ||
    !capability.rawBasis ||
    !readCapabilityMatchesScope(capability, { ...issuer, path: item.path }) ||
    capability.hash !== anchor.contentHash ||
    capability.startLine !== anchor.startLine ||
    capability.endLine !== anchor.endLine ||
    (anchor.rawBasis !== undefined &&
      !rawReadBasesMatch(anchor.rawBasis, capability.rawBasis))
  )
    return undefined
  const rawBasis = capability.rawBasis
  try {
    if (item.selector === 'file') {
      if (
        rawBasis.scope !== 'whole' ||
        typeof item.rawSourceContent !== 'string'
      )
        return undefined
      const document = captureTextDocument(item.rawSourceContent, rawBasis)
      if (
        item.content !== document.observation ||
        anchor.startLine !== 1 ||
        anchor.endLine !== document.maxCapabilityLine ||
        !rawReadBasesMatch(
          rawBasis,
          getRawReadBasis(document, 1, document.maxCapabilityLine, 'whole'),
        ) ||
        !reanchorRawReadCapability({ content: document.rawText, capability }).ok
      )
        return undefined
    } else {
      // The signed raw basis came from the actual adapter read. Its normalized
      // hash authenticates the separately returned, undecorated observation.
      if (
        rawBasis.scope !== 'lines' ||
        typeof item.sourceContent !== 'string' ||
        anchor.startLine !== item.startLine ||
        anchor.endLine !== item.endLine ||
        getContentHash(item.sourceContent) !== capability.hash ||
        captureTextDocument(item.sourceContent, { includesBom: false })
          .maxCapabilityLine !==
          item.endLine - item.startLine + 1
      )
        return undefined
    }
  } catch {
    return undefined
  }
  return { ...anchor, rawBasis }
}

export function captureAuthenticatedWholeRead(
  item: ReadFilesItemV1,
  issuer: ReadCapabilityIssuer,
): { document: CapturedTextDocument; anchor: ReadFilesEditAnchor } | undefined {
  const anchor = authenticateReadFilesItem(item, issuer)
  if (
    !anchor ||
    item.selector !== 'file' ||
    item.status !== 'ok' ||
    typeof item.rawSourceContent !== 'string'
  )
    return undefined
  return {
    document: captureTextDocument(item.rawSourceContent, anchor.rawBasis),
    anchor,
  }
}

import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { createHash } from 'node:crypto'

import {
  createTextDocument,
  type OutputDocument,
  type OutputKind,
} from './output-document'
import { getToolOutputRecords } from './tool-result-normalizer'

export interface CapturedArtifact {
  path: string
  kind: OutputKind
  sha256?: string
}
export const OUTPUT_ARTIFACT_BYTE_LIMIT = 8_000_000

/** Only explicit producer artifact references qualify; source-file paths do not. */
export function capturedArtifacts(output: unknown): CapturedArtifact[] {
  const artifacts: CapturedArtifact[] = []
  for (const record of getToolOutputRecords(output)) {
    for (const key of ['logFile', 'logPath', 'artifactPath']) {
      const path = record[key]
      if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0'))
        continue
      if (
        record.persisted === false ||
        record.logPersisted === false ||
        record.artifactPersisted === false
      )
        continue
      if (artifacts.some((item) => item.path === path)) continue
      artifacts.push({
        path,
        kind: key.startsWith('log') ? 'log' : 'text',
        sha256: typeof record.sha256 === 'string' ? record.sha256 : undefined,
      })
    }
  }
  return artifacts
}

/** User-triggered local artifact access. Never follows a source-file fallback. */
export async function recoverCapturedArtifact(
  id: string,
  artifact: CapturedArtifact,
): Promise<OutputDocument> {
  let file
  try {
    if (!isAbsolute(artifact.path) || artifact.path.includes('\0'))
      throw new Error('An explicit absolute captured artifact path is required')
    file = await open(
      artifact.path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    )
    const stat = await file.stat()
    if (!stat.isFile())
      throw new Error('The saved artifact is not a regular file')
    const bytes = new Uint8Array(
      Math.min(stat.size, OUTPUT_ARTIFACT_BYTE_LIMIT),
    )
    let read = 0
    while (read < bytes.length) {
      const chunk = await file.read(bytes, read, bytes.length - read, read)
      if (!chunk.bytesRead) break
      read += chunk.bytesRead
    }
    const captured = bytes.subarray(0, read)
    const after = await file.stat()
    const changed = stat.size !== after.size || stat.mtimeMs !== after.mtimeMs
    const limited = stat.size > read || changed
    const verified =
      !limited &&
      artifact.sha256 !== undefined &&
      createHash('sha256').update(captured).digest('hex') === artifact.sha256
    const mismatch = !limited && artifact.sha256 !== undefined && !verified
    return createTextDocument({
      id,
      title: artifact.path,
      kind: artifact.kind,
      text: new TextDecoder().decode(captured),
      availability: limited || mismatch ? 'limited' : 'retained',
      provenance: {
        source: 'saved-artifact',
        identity: artifact.path,
        freshness: verified ? 'captured' : 'unverified',
        exact: verified,
        version: verified ? artifact.sha256 : undefined,
      },
      coverage: {
        captured: read,
        total: stat.size,
        unit: 'bytes',
        reasons: [
          ...(stat.size > read ? ['Local artifact read limit reached'] : []),
          ...(changed ? ['Artifact changed during read'] : []),
          ...(mismatch ? ['Artifact differs from the captured checksum'] : []),
        ],
      },
      notice: `Local saved artifact · ${verified ? 'captured checksum verified' : mismatch ? 'captured checksum mismatch; original version unavailable' : 'original version not verified'}${limited ? ` · ${read} of ${stat.size} bytes read` : ''}`,
    })
  } catch (error) {
    const code =
      error && typeof error === 'object' && 'code' in error
        ? String(error.code)
        : undefined
    return createTextDocument({
      id,
      title: artifact.path,
      kind: artifact.kind,
      text: '',
      availability: 'unavailable',
      provenance: {
        source: 'saved-artifact',
        identity: artifact.path,
        freshness: 'unverified',
        exact: false,
      },
      notice: `Saved artifact unavailable${code ? ` (${code})` : ''} · captured preview remains available`,
    })
  } finally {
    await file?.close()
  }
}

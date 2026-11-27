import type { MemorySelector } from '../types/memory-v2'

/** Canonical selector identity shared by durable projections and live attestation. */
export function memorySelectorKey(selector: MemorySelector): string {
  if (selector.kind === 'uri-fragment') return `${selector.uri.toLowerCase()}#${selector.fragment.toLowerCase()}`
  const base = selector.path.replaceAll('\\', '/').toLowerCase()
  if (selector.kind === 'symbol') return `${base}#${selector.symbol.toLowerCase()}`
  if (selector.kind === 'json-pointer') return `${base}#${selector.pointer.toLowerCase()}`
  if (selector.kind === 'line-range') return `${base}:${selector.startLine}-${selector.endLine}`
  if (selector.kind === 'chunk') return `${base}#chunk:${selector.chunkId.toLowerCase()}:${selector.startLine}-${selector.endLine}`
  return base
}

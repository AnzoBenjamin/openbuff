import { isMcpToolResultEnvelope } from '@codebuff/common/mcp/result'

import { getToolOutputValues } from './tool-result-normalizer'
import {
  cleanPreviewText,
  parseStructuredPreview,
  summarizeStructuredPreview,
} from './structured-preview'

export interface ToolDisplayOutput {
  value?: unknown
  text?: string
  preview?: string
}

// Reserve room for separators and the overflow notice in the 8,000-char body.
const MAX_TEXT_CHARACTERS = 7_800
const MAX_JSON_TEXT_CHARACTERS = 500_000

/** Exact within a fixed budget; uncertainty retains both pieces of evidence. */
function sameStructuredValue(left: unknown, right: unknown): boolean {
  let remaining = 4_096
  const compare = (a: unknown, b: unknown, depth: number): boolean => {
    if (--remaining < 0) return false
    if (Object.is(a, b)) return true
    if (depth >= 16) return false
    if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false
    if (Array.isArray(a) || Array.isArray(b)) {
      if (
        !Array.isArray(a) ||
        !Array.isArray(b) ||
        a.length !== b.length ||
        a.length > remaining
      )
        return false
      for (let index = 0; index < a.length; index++) {
        const first = Object.getOwnPropertyDescriptor(a, index)
        const second = Object.getOwnPropertyDescriptor(b, index)
        if (
          !first ||
          !second ||
          !('value' in first) ||
          !('value' in second) ||
          !compare(first.value, second.value, depth + 1)
        )
          return false
      }
      return true
    }
    let firstCount = 0
    for (const key in a) {
      if (!Object.prototype.hasOwnProperty.call(a, key)) continue
      firstCount++
      if (remaining <= 0) return false
      const first = Object.getOwnPropertyDescriptor(a, key)
      const second = Object.getOwnPropertyDescriptor(b, key)
      if (
        !first ||
        !second ||
        !second.enumerable ||
        !('value' in first) ||
        !('value' in second) ||
        !compare(first.value, second.value, depth + 1)
      )
        return false
    }
    let secondCount = 0
    for (const key in b) {
      if (!Object.prototype.hasOwnProperty.call(b, key)) continue
      if (++secondCount > firstCount) return false
    }
    return firstCount === secondCount
  }
  return compare(left, right, 0)
}

/** Project known transport envelopes; arbitrary result data retains its shape. */
export function toolDisplayOutput(
  outputRaw: unknown,
  output?: string,
): ToolDisplayOutput {
  const values = getToolOutputValues(outputRaw)
  // A bare array is result data, including [] and single-item collections.
  const value =
    values === outputRaw
      ? outputRaw
      : values.length === 1
        ? values[0]
        : values.length
          ? values
          : undefined

  if (isMcpToolResultEnvelope(value)) {
    const parts: string[] = []
    const structuredParts: unknown[] = []
    let jsonCharacters = 0
    let characters = 0
    let limited = false
    for (let index = 0; index < value.content.length; index++) {
      if (index >= 30 || characters >= MAX_TEXT_CHARACTERS) {
        limited = true
        break
      }
      const part = value.content[index]
      if (!part || typeof part !== 'object' || Array.isArray(part)) {
        parts.push('Additional captured content · Inspect for details')
        continue
      }
      let text: string
      if (part.type === 'text' && typeof part.text === 'string') {
        if (/^[\[{]/.test(part.text.trimStart())) {
          if (jsonCharacters + part.text.length > MAX_JSON_TEXT_CHARACTERS) {
            parts.push(
              'Text too large to format · Inspect for captured details',
            )
            limited = true
            continue
          }
          jsonCharacters += part.text.length
          const parsed = parseStructuredPreview(part.text)
          if (parsed !== undefined) {
            if (!sameStructuredValue(parsed, value.structuredContent))
              structuredParts.push(parsed)
            continue
          }
        }
        text = part.text
      } else if (part.type === 'resource_link') {
        text = [part.title ?? part.name ?? 'Resource', part.uri]
          .filter((item): item is string => typeof item === 'string')
          .join(' · ')
      } else if (part.type === 'resource') {
        const resource = part.resource
        text =
          resource && typeof resource === 'object' && !Array.isArray(resource)
            ? [
                resource.uri,
                resource.text ?? 'Captured resource · Inspect for metadata',
              ]
                .filter((item): item is string => typeof item === 'string')
                .join('\n')
            : 'Captured resource · Inspect for metadata'
      } else if (part.type === 'image' || part.type === 'audio') {
        text = `${part.type === 'image' ? 'Image' : 'Audio'} attached${typeof part.mimeType === 'string' ? ` (${part.mimeType})` : ''} · Inspect for captured metadata`
      } else {
        text = 'Additional captured content · Inspect for details'
      }
      const budget = MAX_TEXT_CHARACTERS - characters
      if (text.length > budget) {
        text = `${text.slice(0, Math.max(0, budget - 1))}…`
        limited = true
      }
      text = cleanPreviewText(text)
      parts.push(text)
      characters += text.length
    }
    const parsedValue =
      structuredParts.length === 1 ? structuredParts[0] : structuredParts
    const displayedValue = structuredParts.length
      ? value.structuredContent === undefined
        ? parsedValue
        : { result: value.structuredContent, additionalResults: parsedValue }
      : value.structuredContent
    if (limited) parts.push('Preview limited · Inspect for captured details')
    if (!parts.length && displayedValue === undefined)
      parts.push('No content returned')
    return {
      text: parts.join('\n\n'),
      value: displayedValue,
      preview:
        value.structuredContent !== undefined
          ? summarizeStructuredPreview(value.structuredContent)
          : displayedValue !== undefined
            ? summarizeStructuredPreview(displayedValue)
            : parts
                .find((part) => part.trim())
                ?.split('\n')
                .find((line) => line.trim()),
    }
  }

  if (value !== undefined && typeof value === 'object') return { value }
  const text = output ?? (value === undefined ? undefined : String(value))
  if (text === undefined) return {}
  const structured = parseStructuredPreview(text)
  return structured === undefined ? { text } : { value: structured }
}

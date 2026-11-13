import { cleanPreviewText, humanizeFieldName } from './structured-preview'
import type { OutputDocument, OutputLocation } from './output-document'

/** A display projection only: exact values, export text and logical lines stay captured. */
export function readableOutput(document: OutputDocument): OutputDocument {
  const pathTitle = /^\$(?:\[(?:"(?:\\.|[^"\\])*"|\d+)\])+$/.test(
    document.title,
  )
  const title = pathTitle
    ? [...document.title.matchAll(/\[("(?:\\.|[^"\\])*"|\d+)\]/g)]
        .map((part) =>
          part[1].startsWith('"')
            ? cleanPreviewText(humanizeFieldName(JSON.parse(part[1]))).replace(
                /\s+/g,
                ' ',
              )
            : `Item ${Number(part[1]) + 1}`,
        )
        .join(' › ')
    : document.title
  if (document.kind !== 'json')
    return title === document.title ? document : { ...document, title }
  const project = (index: number) => {
    const source = document.line(index)
    const match = /^(\$(?:\[(?:"(?:\\.|[^"\\])*"|\d+)\])*)(: | · )(.*)$/.exec(
      source,
    )
    if (!match) return { text: source, delta: 0, prefix: 0 }
    const parts = [...match[1].matchAll(/\[("(?:\\.|[^"\\])*"|\d+)\]/g)]
    const last = parts.at(-1)?.[1]
    const label =
      last === undefined
        ? 'Output'
        : last.startsWith('"')
          ? humanizeFieldName(JSON.parse(last)) || '(empty key)'
          : `Item ${Number(last) + 1}`
    const safeLabel = cleanPreviewText(label).replace(/\s+/g, ' ')
    const prefix = `${'  '.repeat(Math.min(10, Math.max(0, parts.length - 1)))}${safeLabel}${match[2]}`
    const value = document.row?.(index)?.value
    const shown =
      typeof value === 'string' && value.includes('\n')
        ? `${match[3].split('\\n', 1)[0]}  ↵ Enter opens full text`
        : match[3]
    return {
      text: prefix + shown,
      delta: match[1].length + match[2].length - prefix.length,
      prefix: prefix.length,
    }
  }
  return {
    ...document,
    title,
    line: (index) => project(index).text,
    range: (start, count) =>
      document
        .range(start, count)
        .map(
          (_, offset) =>
            project(Math.max(0, Math.floor(start) || 0) + offset).text,
        ),
    find: (query, from, direction) => {
      const origin = project(from.line)
      const mapped: OutputLocation = {
        line: from.line,
        character:
          from.character === 0 ? 0 : Math.max(1, from.character + origin.delta),
      }
      const found = document.find(query, mapped, direction)
      if (!found) return null
      const target = project(found.line)
      return {
        line: found.line,
        character: target.text.includes(query)
          ? Math.max(0, found.character - target.delta)
          : 0,
      }
    },
    landmarks: document.landmarks.map((landmark) => ({
      ...landmark,
      label: project(landmark.line).text.trim(),
    })),
  }
}

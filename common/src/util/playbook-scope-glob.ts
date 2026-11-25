/** Finite scope-glob syntax: segment *, ?, classes and bounded comma braces; ** spans segments. */
export function expandScopeGlob(pattern: string): string[] | undefined {
  if (
    !pattern ||
    pattern.length > 256 ||
    /[\x00-\x1f]/.test(pattern) ||
    /[!+@?*]\(/.test(pattern)
  )
    return undefined
  let patterns = [pattern]
  for (let depth = 0; depth < 8; depth++) {
    let changed = false
    const next: string[] = []
    for (const value of patterns) {
      const start = value.indexOf('{')
      if (start < 0) {
        if (value.includes('}')) return undefined
        next.push(value)
        continue
      }
      const end = value.indexOf('}', start)
      if (end < 0 || value.slice(start + 1, end).includes('{')) return undefined
      const choices = value.slice(start + 1, end).split(',')
      if (
        choices.length < 2 ||
        choices.some((choice) => !choice || choice.includes('/'))
      )
        return undefined
      for (const choice of choices)
        next.push(value.slice(0, start) + choice + value.slice(end + 1))
      if (next.length > 64) return undefined
      changed = true
    }
    patterns = next
    if (!changed)
      return patterns.every((value) => validClasses(value))
        ? patterns
        : undefined
  }
  return undefined
}
function validClasses(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    if (value[index] === ']') return false
    if (value[index] !== '[') continue
    const end = value.indexOf(']', index + 1)
    if (
      end < 0 ||
      end === index + 1 ||
      value.slice(index + 1, end).includes('/') ||
      value.slice(index + 1, end).includes('[')
    )
      return false
    const content = value.slice(index + 1, end).replace(/^[!^]/, '')
    if (!content) return false
    for (let at = 0; at < content.length - 2; at++)
      if (
        content[at + 1] === '-' &&
        content.charCodeAt(at) > content.charCodeAt(at + 2)
      )
        return false
    index = end
  }
  return true
}
const tokens = (
  pattern: string,
): Array<
  '*' | '?' | { literal: string } | { set: string; negate: boolean }
> => {
  const output: ReturnType<typeof tokens> = []
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index]
    if (char === '*' || char === '?') output.push(char)
    else if (char === '[') {
      const end = pattern.indexOf(']', index + 1),
        content = pattern.slice(index + 1, end)
      output.push({
        set: content.replace(/^[!^]/, ''),
        negate: /^[!^]/.test(content),
      })
      index = end
    } else output.push({ literal: char })
  }
  return output
}
function segmentMatches(value: string, pattern: string): boolean {
  const parts = tokens(pattern),
    memo = new Map<string, boolean>()
  const visit = (v: number, p: number): boolean => {
    const key = `${v}:${p}`,
      cached = memo.get(key)
    if (cached !== undefined) return cached
    const token = parts[p]
    let result: boolean
    if (!token) result = v === value.length
    else if (token === '*')
      result = visit(v, p + 1) || (v < value.length && visit(v + 1, p))
    else if (v === value.length) result = false
    else if (token === '?') result = visit(v + 1, p + 1)
    else if ('literal' in token)
      result = token.literal === value[v] && visit(v + 1, p + 1)
    else {
      let included = false
      for (let index = 0; index < token.set.length; index++) {
        if (token.set[index + 1] === '-' && index + 2 < token.set.length) {
          included ||=
            value[v] >= token.set[index] && value[v] <= token.set[index + 2]
          index += 2
        } else included ||= value[v] === token.set[index]
      }
      result = included !== token.negate && visit(v + 1, p + 1)
    }
    memo.set(key, result)
    return result
  }
  return visit(0, 0)
}
export function matchScopeGlob(path: string, glob: string): boolean {
  const normalized = path.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '')
  if (
    !normalized ||
    normalized.startsWith('/') ||
    normalized.split('/').some((part) => part === '..') ||
    normalized.length > 1024
  )
    return false
  const variants = expandScopeGlob(glob)
  if (!variants) return false
  const pathParts = normalized.split('/')
  return variants.some((pattern) => {
    const parts = pattern
        .replace(/\\/g, '/')
        .replace(/^(?:\.\/)+/, '')
        .split('/'),
      memo = new Map<string, boolean>()
    const visit = (p: number, g: number): boolean => {
      const key = `${p}:${g}`,
        cached = memo.get(key)
      if (cached !== undefined) return cached
      const part = parts[g]
      const result =
        part === undefined
          ? p === pathParts.length
          : part === '**'
            ? visit(p, g + 1) || (p < pathParts.length && visit(p + 1, g))
            : p < pathParts.length &&
              segmentMatches(pathParts[p], part) &&
              visit(p + 1, g + 1)
      memo.set(key, result)
      return result
    }
    return visit(0, 0)
  })
}

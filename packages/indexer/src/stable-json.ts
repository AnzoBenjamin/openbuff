/** Stable across JavaScript and Rust map ordering; array order remains semantic. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry))
      return entry
    return Object.fromEntries(
      Object.keys(entry)
        .sort()
        .map((key) => [key, entry[key]]),
    )
  })
}

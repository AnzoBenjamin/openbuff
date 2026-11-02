export function repairEsmExportRenames(content: string): {
  content: string
  fixCount: number
  removalCount: number
} {
  // Step 1: Find all declared variables/functions/classes in the bundle.
  const declared = new Set<string>()
  const declRegex =
    /^(?:var|let|const)\s+(\w+)|^(?:async\s+)?function\*?\s+(\w+)|^class\s+(\w+)/gm
  let match: RegExpExecArray | null
  while ((match = declRegex.exec(content)) !== null) {
    const name = match[1] || match[2] || match[3]
    if (name) declared.add(name)
  }
  // Bun also emits several top-level `var` declarations on one line, e.g.
  // `var first, exported = ...`. Counting only the first binding silently
  // removed real public exports from the bundle.
  for (const line of content.matchAll(/^var\s+[^\n]*/gm)) {
    for (const binding of line[0].matchAll(
      /(?:^var\s+|,\s*)([$\w]+)\s*(?==|,|;)/g,
    )) {
      declared.add(binding[1])
    }
  }

  // Step 2: Find the final `export { ... }` block at the end of the file.
  // A string or template elsewhere in the bundle may itself contain
  // `export{`. Match a complete top-level block and replace its exact span;
  // an unanchored replace can corrupt an earlier string and the whole bundle.
  const exportBlockRegex = /^export[ \t]*\{([\s\S]*?)^\}[ \t]*;?[ \t]*$/gm
  let lastMatch: RegExpExecArray | null = null
  while ((match = exportBlockRegex.exec(content)) !== null) {
    lastMatch = match
  }

  if (!lastMatch) return { content, fixCount: 0, removalCount: 0 }
  const lastExportBlock = lastMatch[1]

  // Step 3: Parse each export entry and classify.
  // Entries can be:
  //   - `symbolName` (bare)
  //   - `X2 as symbolName` (dedup rename)
  //   - `X as Y` (legitimate rename, e.g. OpenbuffClient as CodebuffClient)
  const entryRegex = /(\w+)(\d+)?\s+as\s+(\w+)|(\w+)(?=\s*[,\n}])/g
  const renames: { from: string; to: string }[] = []
  const removals: string[] = []

  while ((match = entryRegex.exec(lastExportBlock)) !== null) {
    let localName: string
    let exportedName: string
    let hasRename = false

    if (match[3]) {
      // Pattern: `X2 as Y` or `X as Y`
      localName = match[1] + (match[2] || '') // e.g. MAX_RETRIES_PER_MESSAGE2
      exportedName = match[3] // e.g. MAX_RETRIES_PER_MESSAGE
      hasRename = true
    } else {
      // Pattern: `symbolName` (bare)
      localName = match[4]
      exportedName = localName
    }

    // If the local variable exists, this export is fine.
    if (declared.has(localName)) continue

    if (hasRename) {
      // `X2 as X` where X2 is not declared
      if (declared.has(exportedName)) {
        // Dedup rename: X is defined, X2 is not. Fix: replace with X.
        renames.push({
          from: `${localName} as ${exportedName}`,
          to: exportedName,
        })
      } else {
        // Neither X2 nor X is defined — tree-shaken. Remove the entry.
        removals.push(`${localName} as ${exportedName}`)
      }
    } else {
      // Bare export `X` where X is not declared — tree-shaken. Remove it.
      removals.push(localName)
    }
  }

  if (renames.length === 0 && removals.length === 0)
    return { content, fixCount: 0, removalCount: 0 }

  // Apply renames only while rebuilding the matched export block. Replacing
  // globally could change an unrelated string, comment or declaration.
  let fixCount = 0

  // Step 5: Rebuild the export block to remove tree-shaken entries.
  // Parse the export block into lines, filter out removed entries, and
  // reconstruct a clean export statement.
  const exportLines = lastExportBlock
    .split(',')
    .map((l) => l.trim().replace(/\s+as\s+/, ' as '))
    .filter((l) => l && l !== ',' && l !== '}')

  const removalSet = new Set(removals)
  const renameMap = new Map(renames.map((r) => [r.from, r.to]))
  const keptEntries: string[] = []
  let removalCount = 0

  for (const line of exportLines) {
    const clean = line.replace(/,$/, '').trim()
    if (!clean) continue
    if (removalSet.has(clean)) {
      removalCount++
      continue
    }
    const renamed = renameMap.get(clean)
    if (renamed !== undefined) {
      keptEntries.push(renamed)
      fixCount++
      continue
    }
    keptEntries.push(clean)
  }

  // Rebuild only the exact last matched export block.
  const newExportBlock = keptEntries.map((e) => `  ${e},`).join('\n')
  const newExportStatement = `export {\n${newExportBlock}\n};`
  return {
    content:
      content.slice(0, lastMatch.index) +
      newExportStatement +
      content.slice(lastMatch.index + lastMatch[0].length),
    fixCount,
    removalCount,
  }
}

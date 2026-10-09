export type MentionAgentMatch = { id: string }
export type MentionFileMatch = { filePath: string; isDirectory: boolean }

export type MentionReplacement = {
  replacement: string
  selectedFile?: MentionFileMatch
}

/**
 * Resolve the mention replacement for `index` against the agent/file match
 * lists. With `useFallback` false (click and Enter-select), an out-of-range
 * or missing entry yields null and the caller aborts. With `useFallback` true
 * (tab-complete), a missing entry falls back to the first entry of the same
 * list; null is returned only when that list is empty. `selectedFile` is set
 * for file matches so the caller can run the addPendingFileMention side
 * effect.
 */
export const resolveMentionReplacement = (
  index: number,
  agentMatches: readonly MentionAgentMatch[],
  fileMatches: readonly MentionFileMatch[],
  useFallback: boolean,
): MentionReplacement | null => {
  if (index < agentMatches.length) {
    const selected = useFallback
      ? agentMatches[index] || agentMatches[0]
      : agentMatches[index]
    if (!selected) return null
    return { replacement: `@${selected.id} ` }
  }
  const fileIndex = index - agentMatches.length
  const selectedFile = useFallback
    ? fileMatches[fileIndex] || fileMatches[0]
    : fileMatches[fileIndex]
  if (!selectedFile) return null
  return {
    selectedFile,
    replacement: `@${selectedFile.filePath} `,
  }
}

/**
 * Splice a mention replacement into the input at the active mention token
 * (the `@` at `startIndex` followed by `query`), returning the new text and
 * the cursor position just after the inserted replacement.
 */
export const buildMentionReplacement = (
  inputValue: string,
  startIndex: number,
  query: string,
  replacement: string,
): { text: string; cursorPosition: number } => {
  const before = inputValue.slice(0, startIndex)
  const after = inputValue.slice(startIndex + 1 + query.length)
  return {
    text: before + replacement + after,
    cursorPosition: before.length + replacement.length,
  }
}

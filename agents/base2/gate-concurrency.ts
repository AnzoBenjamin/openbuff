/**
 * Pure concurrent-instance isolation helper for the base2 mid-turn git-status
 * sweep.
 *
 * NOTE: the inline copy is **generated** into the base2 `handleSteps`
 * `<gate-helpers-generated>` region via `scripts/generate-gate-helpers.ts`
 * (same as gate-paths/reviewer/repair). `handleSteps` is serialized via
 * `toString()` / `new Function(...)` and loses module closure, so it cannot
 * import this file — edit this module and regenerate rather than hand-maintaining
 * the inline copy.
 */
export function shouldAbsorbGitStatusFile(params: {
  file: string
  initialGitStatusFiles: readonly string[]
  gatePassedFiles: ReadonlySet<string> | { has(f: string): boolean }
  taskRelatedFiles: ReadonlySet<string> | { has(f: string): boolean }
  selfMutatedPaths?: ReadonlySet<string> | { has(f: string): boolean }
}): boolean {
  const {
    file,
    initialGitStatusFiles,
    gatePassedFiles,
    taskRelatedFiles,
    selfMutatedPaths,
  } = params
  if (initialGitStatusFiles.includes(file)) return false
  if (gatePassedFiles.has(file)) return false
  if (taskRelatedFiles.has(file)) return true
  if (selfMutatedPaths !== undefined && selfMutatedPaths.has(file)) return true
  return false
}

import { maxFilesPerCall, resolveOwningTargets } from '../services/build-graph'
import { getBuildTargets as resolveBuildTargets } from '../services/harness-intelligence'
import type { CodebuffToolOutput } from '../../../common/src/tools/list'

export function getBuildTargets(
  cwd: string,
  files: string[],
): CodebuffToolOutput<'get_build_targets'> {
  // Audit fix (I): best-effort owning-target resolution from the build-graph
  // service, which was previously referenced only by its test. Fail-open: any
  // resolution error (absent ecosystem tooling, unreadable manifests) leaves
  // the optional field off rather than failing the tool or the existing
  // `targets` result.
  let owningTargets: ReturnType<typeof resolveOwningTargets> | undefined
  try {
    owningTargets = resolveOwningTargets({ cwd, files })
  } catch {
    owningTargets = undefined
  }
  return [
    {
      type: 'json',
      value: {
        targets: resolveBuildTargets(cwd, files),
        ...(owningTargets ? { owningTargets } : {}),
        // Truncation honesty (P3 coherence audit): an input file list beyond
        // the per-call cap means some files were silently not considered —
        // surface it so the agent can re-issue with the remainder.
        ...(files.length > maxFilesPerCall ? { truncated: true } : {}),
      },
    },
  ]
}

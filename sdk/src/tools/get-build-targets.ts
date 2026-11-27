import { maxFilesPerCall, resolveOwningTargetsAsync } from '../services/build-graph'
import { getBuildTargetsAsync as resolveBuildTargets } from '../services/harness-intelligence'
import { ToolchainExecutionError } from '../services/toolchain-execution'
import type { ToolchainExecutionContext } from '../services/toolchain-execution'
import type { CodebuffToolOutput } from '../../../common/src/tools/list'

export async function getBuildTargets(
  cwd: string,
  files: string[],
  signal?: AbortSignal,
  executionContext?: ToolchainExecutionContext,
): Promise<CodebuffToolOutput<'get_build_targets'>> {
  // Audit fix (I): best-effort owning-target resolution from the build-graph
  // service, which was previously referenced only by its test. Fail-open: any
  // resolution error (absent ecosystem tooling, unreadable manifests) leaves
  // the optional field off rather than failing the tool or the existing
  // `targets` result.
  let owningTargets: Awaited<ReturnType<typeof resolveOwningTargetsAsync>> | undefined
  try {
    owningTargets = await resolveOwningTargetsAsync({ cwd, files, executionContext })
  } catch (error) {
    if (error instanceof ToolchainExecutionError) throw error
    owningTargets = undefined
  }
  return [
    {
      type: 'json',
      value: {
        targets: await resolveBuildTargets(cwd, files, signal),
        ...(owningTargets ? { owningTargets } : {}),
        // Truncation honesty (P3 coherence audit): an input file list beyond
        // the per-call cap means some files were silently not considered —
        // surface it so the agent can re-issue with the remainder.
        ...(files.length > maxFilesPerCall ? { truncated: true } : {}),
      },
    },
  ]
}

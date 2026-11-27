import {
  analyzeTestImpactAsync,
  getAffectedTestTargetsAsync,
} from '../services/harness-intelligence'
import type { CodebuffToolOutput } from '../../../common/src/tools/list'

// Audit fix (J): the sdk cannot import the indexer's reverse-dependency
// accessor, so analyzeTestImpact always runs without reverseDeps and the
// graph tier is empty. The note says so honestly instead of fabricating data.
const GRAPH_TIER_NOTE =
  'indexer reverse-dependency graph is not wired into this tool yet; graph tier is empty'

export async function getAffectedTests(
  cwd: string,
  files: string[],
  signal?: AbortSignal,
): Promise<CodebuffToolOutput<'get_affected_tests'>> {
  // The graph tier stays empty here: the sdk has no direct accessor for the
  // indexer reference graph (packages/indexer's `queryReferences` is internal
  // to its query engine), so `analyzeTestImpact` runs with its default
  // no-op reverse-deps seam until a cheap importer lookup is exposed.
  //
  // Both halves go through the async discovery twins, which share ONE in-flight
  // cache entry with each other and with inspect_environment. The aux gate
  // issues all three in one iteration, so that iteration used to pay a blocking
  // localStorage-length sync walk per tool; now it pays a single shared walk,
  // off the event loop.
  // The signal reaches both halves so a cancelled aux-gate iteration stops
  // queueing filesystem probes instead of draining them for a caller that has
  // already given up on the answer.
  const [targets, impact] = await Promise.all([
    getAffectedTestTargetsAsync(cwd, files, signal),
    analyzeTestImpactAsync(cwd, files, {}, signal),
  ])
  return [
    {
      type: 'json',
      value: {
        targets,
        impact: impact.map((entry) => ({
          ...entry,
          graphNote: GRAPH_TIER_NOTE,
        })),
      },
    },
  ]
}

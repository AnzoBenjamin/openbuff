import {
  analyzeTestImpact,
  getAffectedTestTargets,
} from '../services/harness-intelligence'
import type { CodebuffToolOutput } from '../../../common/src/tools/list'

// Audit fix (J): the sdk cannot import the indexer's reverse-dependency
// accessor, so analyzeTestImpact always runs without reverseDeps and the
// graph tier is empty. The note says so honestly instead of fabricating data.
const GRAPH_TIER_NOTE =
  'indexer reverse-dependency graph is not wired into this tool yet; graph tier is empty'

export function getAffectedTests(
  cwd: string,
  files: string[],
): CodebuffToolOutput<'get_affected_tests'> {
  // The graph tier stays empty here: the sdk has no direct accessor for the
  // indexer reference graph (packages/indexer's `queryReferences` is internal
  // to its query engine), so `analyzeTestImpact` runs with its default
  // no-op reverse-deps seam until a cheap importer lookup is exposed.
  return [
    {
      type: 'json',
      value: {
        targets: getAffectedTestTargets(cwd, files),
        impact: analyzeTestImpact(cwd, files).map((entry) => ({
          ...entry,
          graphNote: GRAPH_TIER_NOTE,
        })),
      },
    },
  ]
}

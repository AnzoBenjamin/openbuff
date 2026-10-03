import {
  analyzeTestImpact,
  getAffectedTestTargets,
} from '../services/harness-intelligence'
import type { CodebuffToolOutput } from '../../../common/src/tools/list'

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
        impact: analyzeTestImpact(cwd, files),
      },
    },
  ]
}

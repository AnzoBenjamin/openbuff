import {
  applySemanticEdit,
  NO_RESULT_ERROR,
  type SemanticEditApplyDeps,
  type SemanticEditApplyResult,
} from './semantic-edit-apply'

import type { LanguageIntelligenceService } from '../services/language-intelligence'

/**
 * P4-T2 (code_action, v1: organize imports) apply tool: identical thin
 * wrapper to rename_symbol — the service runs the code action and returns the
 * spliced `changedFiles` (or an honest structured unavailable/errorMessage);
 * this layer applies them through `changeFiles` and reduces the commit result
 * into the tool's published shape. Positions pass through VERBATIM — the
 * service owns the 1-based→0-based conversion. An unsupported kind never
 * reaches here as a splicable edit: the service degrades it to a typed
 * unavailable, which this wrapper returns verbatim.
 */
export async function codeAction(
  service: LanguageIntelligenceService,
  params: { path: string; line: number; character: number; kind: string },
  opts: SemanticEditApplyDeps,
): Promise<SemanticEditApplyResult<'code_action'>> {
  const [first] = await service.codeAction(params)
  const applied = await applySemanticEdit(
    first?.value ?? { errorMessage: NO_RESULT_ERROR },
    opts,
  )
  return applied
}

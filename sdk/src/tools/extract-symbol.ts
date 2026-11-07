import {
  applySemanticEdit,
  NO_RESULT_ERROR,
  type SemanticEditApplyDeps,
  type SemanticEditApplyResult,
} from './semantic-edit-apply'

import type { LanguageIntelligenceService } from '../services/language-intelligence'

/**
 * P4-T2 (extract_symbol) apply tool: identical thin wrapper to rename_symbol
 * and code_action — the service runs the extract refactor and returns the
 * spliced `changedFiles` (or an honest structured unavailable/errorMessage);
 * this layer applies them through `changeFiles` and reduces the commit result
 * into the tool's published shape. `destination_path` passes through VERBATIM
 * — the service owns the destination gate and refuses servers whose extract
 * refactor does not create the destination file. An unsupported extract
 * refactor never reaches here as a splicable edit: the service degrades it
 * to a typed unavailable, which this wrapper returns verbatim.
 */
export async function extractSymbol(
  service: LanguageIntelligenceService,
  params: {
    path: string
    line: number
    character: number
    destination_path: string
    symbol_name: string
  },
  opts: SemanticEditApplyDeps,
): Promise<SemanticEditApplyResult<'extract_symbol'>> {
  const [first] = await service.extractSymbol(params)
  const applied = await applySemanticEdit(
    first?.value ?? { errorMessage: NO_RESULT_ERROR },
    opts,
  )
  return applied
}

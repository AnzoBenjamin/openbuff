import {
  applySemanticEdit,
  NO_RESULT_ERROR,
  type SemanticEditApplyDeps,
  type SemanticEditApplyResult,
} from './semantic-edit-apply'

import type { LanguageIntelligenceService } from '../services/language-intelligence'
import type { LspRequestContext } from '../services/lsp-multiplexer'

/**
 * P4-T2 (extract_symbol) apply tool: identical thin wrapper to rename_symbol
 * and code_action — the service runs the extract refactor and returns the
 * spliced `changedFiles` (or an honest structured unavailable/errorMessage);
 * this layer applies them through `changeFiles` and reduces the commit result
 * into the tool's published shape. `destination_path` passes through VERBATIM
 * — the built-in service requires a concrete, command-free WorkspaceEdit
 * that creates exactly that destination and updates its source. It never
 * runs an unverified server command to obtain an edit.
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
  executionContext?: LspRequestContext,
): Promise<SemanticEditApplyResult<'extract_symbol'>> {
  const [first] = await service.extractSymbol(params, executionContext)
  const applied = await applySemanticEdit(
    first?.value ?? { errorMessage: NO_RESULT_ERROR },
    opts,
  )
  return applied
}

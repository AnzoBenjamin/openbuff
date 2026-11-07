import {
  applySemanticEdit,
  NO_RESULT_ERROR,
  type SemanticEditApplyDeps,
  type SemanticEditApplyResult,
} from './semantic-edit-apply'

import type { LanguageIntelligenceService } from '../services/language-intelligence'
/**
 * P4-T2 (rename_symbol) apply tool: runs the language-server rename through
 * the service (which shifts the 1-based model line to the 0-based LSP
 * position exactly once and splices the returned WorkspaceEdit against
 * CURRENT disk bytes), then applies the returned `changedFiles` through the
 * production multi-file commit path (`changeFiles`: per-file broker CAS,
 * CommitReceiptV1s, P2-T5 intent log, rollback).
 *
 * `unavailable` / `errorMessage` service outputs are returned verbatim as the
 * tool's own published shape; anything the service could splice is committed.
 * Positions pass through VERBATIM — the service owns the 1-based→0-based
 * conversion.
 */
export async function renameSymbol(
  service: LanguageIntelligenceService,
  params: { path: string; line: number; character: number; new_name: string },
  opts: SemanticEditApplyDeps,
): Promise<SemanticEditApplyResult<'rename_symbol'>> {
  const [first] = await service.renameSymbol(params)
  const applied = await applySemanticEdit(
    first?.value ?? { errorMessage: NO_RESULT_ERROR },
    opts,
  )
  return applied
}

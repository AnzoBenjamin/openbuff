import type { CodebuffToolOutput } from '../../../common/src/tools/list'
import type { LanguageIntelligenceService } from '../services/language-intelligence'
import type { LspRequestContext } from '../services/lsp-multiplexer'

export function workspaceSymbol(
  service: LanguageIntelligenceService,
  params: { query: string },
  executionContext?: LspRequestContext,
): Promise<CodebuffToolOutput<'workspace_symbol'>> {
  return service.workspaceSymbol(params, executionContext)
}

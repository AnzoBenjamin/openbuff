import type { CodebuffToolOutput } from '../../../common/src/tools/list'
import type { LanguageIntelligenceService } from '../services/language-intelligence'

export function workspaceSymbol(
  service: LanguageIntelligenceService,
  params: { query: string },
): Promise<CodebuffToolOutput<'workspace_symbol'>> {
  return service.workspaceSymbol(params)
}

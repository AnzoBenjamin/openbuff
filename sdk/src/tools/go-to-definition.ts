import type { CodebuffToolOutput } from '../../../common/src/tools/list'
import type { LanguageIntelligenceService } from '../services/language-intelligence'
import type { LspRequestContext } from '../services/lsp-multiplexer'

export function goToDefinition(
  service: LanguageIntelligenceService,
  params: { path: string; line: number; character: number },
  executionContext?: LspRequestContext,
): Promise<CodebuffToolOutput<'go_to_definition'>> {
  return service.goToDefinition(params, executionContext)
}

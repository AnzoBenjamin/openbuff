import type { CodebuffToolOutput } from '../../../common/src/tools/list'
import type { LanguageIntelligenceService } from '../services/language-intelligence'

export function goToDefinition(
  service: LanguageIntelligenceService,
  params: { path: string; line: number; character: number },
): Promise<CodebuffToolOutput<'go_to_definition'>> {
  return service.goToDefinition(params)
}

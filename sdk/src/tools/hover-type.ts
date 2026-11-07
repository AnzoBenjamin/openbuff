import type { CodebuffToolOutput } from '../../../common/src/tools/list'
import type { LanguageIntelligenceService } from '../services/language-intelligence'

export function hoverType(
  service: LanguageIntelligenceService,
  params: { path: string; line: number; character: number },
): Promise<CodebuffToolOutput<'hover_type'>> {
  return service.hoverType(params)
}

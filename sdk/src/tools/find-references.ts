import type { CodebuffToolOutput } from '../../../common/src/tools/list'
import type { LanguageIntelligenceService } from '../services/language-intelligence'

export function findReferences(
  service: LanguageIntelligenceService,
  params: { path: string; line: number; character: number },
): Promise<CodebuffToolOutput<'find_references'>> {
  return service.findReferences(params)
}

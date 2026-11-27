import { expect, test } from 'bun:test'
import { findReferences } from '../tools/find-references'
import { goToDefinition } from '../tools/go-to-definition'
import { hoverType } from '../tools/hover-type'
import { workspaceSymbol } from '../tools/workspace-symbol'
import type { LanguageIntelligenceService } from '../services/language-intelligence'
import type { LspRequestContext } from '../services/lsp-multiplexer'
import type { ActionExecutionPort } from '@codebuff/common/types/contracts/execution-context'

const position = { path: 'src/example.ts', line: 9, character: 4 }
const query = { query: 'Example' }
const cases = [
  { name: 'findReferences', params: position, call: (service: LanguageIntelligenceService, context?: LspRequestContext) => findReferences(service, position, context) },
  { name: 'goToDefinition', params: position, call: (service: LanguageIntelligenceService, context?: LspRequestContext) => goToDefinition(service, position, context) },
  { name: 'hoverType', params: position, call: (service: LanguageIntelligenceService, context?: LspRequestContext) => hoverType(service, position, context) },
  { name: 'workspaceSymbol', params: query, call: (service: LanguageIntelligenceService, context?: LspRequestContext) => workspaceSymbol(service, query, context) },
] as const

for (const entry of cases) test(`${entry.name} forwards each caller context without changing params or output`, async () => {
  // Opaque identity doubles only: this checks wrapper plumbing, never admission.
  const first = { execution: {} as ActionExecutionPort, signal: new AbortController().signal }
  const second = { execution: {} as ActionExecutionPort, signal: new AbortController().signal }
  const calls: Array<{ params: unknown; context: LspRequestContext | undefined }> = []
  const output: [{ type: 'json'; value: { errorMessage: string } }] = [{ type: 'json', value: { errorMessage: 'fixture service output' } }]
  const service = { [entry.name]: async (params: unknown, context?: LspRequestContext) => {
    calls.push({ params, context })
    await Promise.resolve()
    return output
  } } as unknown as LanguageIntelligenceService
  const results = await Promise.all([entry.call(service, first), entry.call(service, second), entry.call(service)])
  expect(calls.map(call => call.params)).toEqual([entry.params, entry.params, entry.params])
  expect(calls[0].context).toBe(first)
  expect(calls[1].context).toBe(second)
  expect(calls[2].context).toBeUndefined()
  for (const result of results) expect(result).toBe(output)
})

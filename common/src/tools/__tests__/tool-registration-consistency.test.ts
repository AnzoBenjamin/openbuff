import { readFileSync } from 'fs'
import { join } from 'path'

import z from 'zod/v4'

import { describe, expect, it } from 'bun:test'

import { publishedTools, quarantinedToolNames, toolNames } from '../constants'
import { compileToolDefinitions } from '../compile-tool-definitions'
import { toolParams } from '../list'

import type { $ToolParams } from '../constants'

/**
 * Guards against the "added here but missing there" failure mode that caused the
 * edit_transaction rollout to break: a tool name present in one registry but
 * absent from another. This test fails loudly whenever a tool is added/removed
 * from one place without being synced everywhere else.
 *
 * Note: the runtime handler map (packages/agent-runtime) is intentionally NOT
 * imported here to keep common free of agent-runtime deps; the readiness script
 * (scripts/check-tool-registration.ts) covers the handler dimension.
 */
describe('tool registration consistency', () => {
  const repoRoot = join(import.meta.dir, '..', '..', '..', '..')

  const readToolNameUnion = (relativePath: string): Set<string> => {
    const source = readFileSync(join(repoRoot, relativePath), 'utf8')
    const unionMatch = source.match(/export type ToolName =([\s\S]*?)\n\n/)
    expect(unionMatch).not.toBeNull()
    const names = (unionMatch?.[1] ?? '')
      .split('|')
      .map((part) => part.trim().replace(/['"]/g, ''))
      .filter((part) => part.length > 0)
    return new Set(names)
  }

  it('toolParams (list.ts) has exactly the tools in toolNames (constants.ts)', () => {
    const paramKeys = Object.keys(toolParams).sort()
    expect(paramKeys).toEqual([...toolNames].sort())
  })

  it('each toolParams entry self-reports its own tool name', () => {
    for (const name of toolNames) {
      expect(toolParams[name].toolName).toBe(name)
    }
  })

  it('quarantined compatibility tools remain registered and published', () => {
    for (const toolName of quarantinedToolNames) {
      expect(toolNames).toContain(toolName)
      expect(publishedTools).toContain(toolName)
      expect(toolParams[toolName].toolName).toBe(toolName)
    }
  })

  it('read_docs max_tokens default matches its descriptions', () => {
    const parsed = toolParams.read_docs.inputSchema.parse({
      libraryTitle: 'React',
      topic: 'hooks',
    })

    expect(parsed.max_tokens).toBe(10_000)
    expect(toolParams.read_docs.description).not.toContain('Defaults to 20000')

    const generatedFiles = [
      'agents/types/tools.ts',
      'common/src/templates/initial-agents-dir/types/tools.ts',
    ]
    for (const file of generatedFiles) {
      const source = readFileSync(join(repoRoot, file), 'utf8')
      expect(source).not.toContain('Defaults to 20000')
      expect(source).toContain('Defaults to 10000')
    }
  })

  it('generated agent tool types include every published-style tool name', () => {
    // These generated type files are what custom agents type-check against.
    // They must stay in sync with the canonical toolNames so agents can never
    // reference a tool name that the type surface does not recognize.
    const generatedFiles = [
      'agents/types/tools.ts',
      'common/src/templates/initial-agents-dir/types/tools.ts',
    ]

    // The generated types intentionally omit a few internal-only tools.
    const internalOnlyTools = new Set([
      'add_subgoal',
      'browser_logs',
      'create_plan',
      'replace_range',
      'spawn_agent_inline',
      'update_subgoal',
    ])
    const expected = new Set(
      [...toolNames].filter((name) => !internalOnlyTools.has(name)),
    )

    for (const file of generatedFiles) {
      const declared = readToolNameUnion(file)
      const missing = [...expected].filter((name) => !declared.has(name))
      const unexpected = [...declared].filter(
        (name) => !toolNames.includes(name as (typeof toolNames)[number]),
      )
      expect({ file, missing, unexpected }).toEqual({
        file,
        missing: [],
        unexpected: [],
      })
    }
  })

  it('generated agent and fresh-install template tool types do not drift', () => {
    expect(readFileSync(join(repoRoot, 'agents/types/tools.ts'), 'utf8')).toBe(
      readFileSync(
        join(
          repoRoot,
          'common/src/templates/initial-agents-dir/types/tools.ts',
        ),
        'utf8',
      ),
    )
  })

  it('wire tool schemas use only portable regex patterns', () => {
    // Strict provider-side JSON Schema validators reject non-portable
    // ECMAScript extensions such as Unicode property escapes (\p{Cc} / \p{Cf})
    // at request time: the write_audit_findings patterns built from them killed
    // every run with a provider 400 before any generation. Convert the same
    // surface compileToolDefinitions sends on the wire — providerInputSchema ??
    // inputSchema — and require every emitted pattern to be a plain RegExp any
    // validator can compile.
    const patterns: string[] = []
    const converted: string[] = []
    const unrepresentable: string[] = []

    const collectPatterns = (node: unknown): void => {
      if (Array.isArray(node)) {
        for (const entry of node) {
          collectPatterns(entry)
        }
        return
      }
      if (node === null || typeof node !== 'object') return
      for (const [key, value] of Object.entries(node)) {
        if (key === 'pattern' && typeof value === 'string') {
          patterns.push(value)
        } else {
          collectPatterns(value)
        }
      }
    }

    for (const [name, toolDef] of Object.entries(toolParams)) {
      const params = toolDef as $ToolParams
      const schema = (params.providerInputSchema ??
        params.inputSchema) as z.ZodType
      try {
        collectPatterns(z.toJSONSchema(schema, { io: 'input' }))
        converted.push(name)
      } catch {
        // A few pre-existing schemas (e.g. z.preprocess-based input like
        // evaluate_audit_coverage) are not JSON-Schema representable at all;
        // those conversion throws are recorded here, never asserted.
        unrepresentable.push(name)
      }
    }

    // write_audit_findings must convert cleanly: its declared wire schema is
    // what every provider request carries, so an unrepresentable surface would
    // regress the harness back to the pre-generation 400s.
    expect(converted).toContain('write_audit_findings')
    expect(unrepresentable).not.toContain('write_audit_findings')

    expect(patterns.length).toBeGreaterThan(0)
    for (const pattern of patterns) {
      expect(pattern).not.toContain('\\p{')
      expect(pattern).not.toContain('\\P{')
      expect(() => new RegExp(pattern)).not.toThrow()
    }
  })
})

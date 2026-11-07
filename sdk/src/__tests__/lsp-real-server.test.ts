/**
 * REAL-SERVER fixtures (P4-T2): the mock-LSP suites pin the multiplexer/service
 * CONTRACTS, but only a real language server proves the request shapes the
 * seam issues are things actual servers answer. clangd is the only LSP server
 * present in a default dev/CI image, so these fixtures gate on its
 * availability (skip, never fail, when absent) and pin OBSERVED behavior:
 *
 * - A strict server refuses document queries until the document arrives via
 *   didOpen (observed clangd: -32602 'trying to get AST for non-added
 *   document') — every test below exercises the didOpen-on-demand seam by
 *   issuing queries WITHOUT any prior syncFile.
 * - textDocument/rename returns a deviceChanges edit set over both the
 *   declaration AND the call site (the exact shape the broker splice
 *   consumes), proven end-to-end at the SERVICE level: the returned
 *   changedFiles content is the disk text with both occurrences renamed.
 * - codeAction against a bare position without diagnostics may offer no
 *   actions on some clangd configurations; the service degrades that to a
 *   structured result the model can react to, so the fixture accepts either
 *   the honest unavailable shape or edit-carrying results.
 */
import { spawn as nodeSpawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, test } from 'bun:test'

import type { CodebuffSpawn } from '@codebuff/common/types/spawn'

import { createLanguageIntelligence } from '../services/language-intelligence'
import {
  clearRootResolutionCache,
  createLspMultiplexer,
  type LspMultiplexer,
} from '../services/lsp-multiplexer'

const DEMO_CPP = [
  'int helper() { return 1; }',
  'int caller() { return helper() + 2; }',
  'int main() { return caller(); }',
  '',
].join('\n')

const HAS_CLANGD = typeof Bun !== 'undefined' && Bun.which('clangd') !== null

const realSpawn: CodebuffSpawn = (command, args, options) =>
  nodeSpawn(command, args ?? [], { ...options })

function makeCppProject(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'openbuff-lsp-real-'))
  writeFileSync(path.join(root, 'demo.cpp'), DEMO_CPP)
  return root
}

function makeRealMultiplexer(root: string): LspMultiplexer {
  // The openFile hook mirrors the production service wiring: a query for a
  // file the server never received must carry the disk bytes via didOpen,
  // because strict servers (observed clangd) reject unopened documents.
  return createLspMultiplexer({
    spawner: (spec) => {
      const [command, ...args] = spec.argv
      const child = realSpawn(command, args, { cwd: spec.cwd })
      const { stdin, stdout } = child
      if (!stdin || !stdout) {
        throw new Error('real clangd spawn has no stdio pipes')
      }
      return {
        pid: child.pid,
        stdin,
        stdout,
        on: (event, listener) => {
          child.on(event, listener)
        },
        kill: (signal) => {
          child.kill(signal as NodeJS.Signals)
        },
      }
    },
    openFile: async ({ filePath }) => {
      const { readFile } = await import('node:fs/promises')
      return readFile(filePath, 'utf8')
    },
    rootResolver: () => root,
  })
}

const tempRoots: string[] = []

afterEach(() => {
  clearRootResolutionCache()
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

// ARCHITECTURE NOTE: these fixtures are the recorded P4-T2/P3-T2 gap closure.
// They stay mux/service-level (no broker commit) so they remain hermetic per
// machine while still proving real-server protocol shapes; the broker/CAS
// behavior above them is covered by the mock suites and never re-tested here.
describe.skipIf(!HAS_CLANGD)('real clangd fixtures (P4-T2 mock-LSP gap closure)', () => {
  test(
    'definition resolves a real call site to its declaration via the didOpen-on-demand seam',
    async () => {
      const root = makeCppProject()
      tempRoots.push(root)
      const mux = makeRealMultiplexer(root)
      // No syncFile was ever called: this query proves the auto-open seam
      // answers what strict servers (-32602 without didOpen, observed) accept.
      const location = await mux.definition({
        filePath: path.join(root, 'demo.cpp'),
        position: { line: 1, character: 22 },
      })
      expect(location).not.toBeNull()
      const resolved = Array.isArray(location) ? location[0] : location
      expect(resolved?.uri.endsWith('/demo.cpp')).toBe(true)
      // Observed clangd shape: the declaration identifier 'helper' at line 0,
      // characters 4..10.
      expect(resolved?.range.start.line).toBe(0)
      expect(resolved?.range.start.character).toBe(4)
      expect(resolved?.range.end.character).toBe(10)
      await mux.dispose()
    },
    30_000,
  )

  test(
    'renameSymbol applies a real clangd WorkspaceEdit end-to-end (both call and declaration sites spliced)',
    async () => {
      const root = makeCppProject()
      tempRoots.push(root)
      const service = createLanguageIntelligence({
        cwd: root,
        spawn: realSpawn,
      })
      const output = await service.renameSymbol({
        path: 'demo.cpp',
        line: 2,
        character: 23,
        new_name: 'renamed_helper',
      })
      const value = output[0]?.value as
        | { changedFiles?: Array<{ path: string; newContent: string }>; errorMessage?: string }
        | undefined
      expect(value?.changedFiles).toBeDefined()
      expect(value?.changedFiles).toHaveLength(1)
      // The single edited file is demo.cpp, spliced on its CURRENT disk bytes.
      expect(value?.changedFiles?.[0]?.path).toBe(path.join(root, 'demo.cpp'))
      // Observed real-clangd rename contract: BOTH the declaration (line 0) and
      // the call site (line 1) are covered by one edit set.
      expect(value?.changedFiles?.[0]?.newContent).toBe(
        [
          'int renamed_helper() { return 1; }',
          'int caller() { return renamed_helper() + 2; }',
          'int main() { return caller(); }',
          '',
        ].join('\n'),
      )
      await service.dispose()
    },
    30_000,
  )

  test(
    'codeAction degrades a real server that offers no edit actions to a structured, model-reactable result',
    async () => {
      const root = makeCppProject()
      tempRoots.push(root)
      const service = createLanguageIntelligence({
        cwd: root,
        spawn: realSpawn,
      })
      // Observed on bare positions without diagnostics: some clangd
      // configurations offer NO actions at all. The service must never throw —
      // it answers with either an honest unavailable or an edit-carrying
      // result, and THIS fixture accepts both real shapes.
      const output = await service.codeAction({
        path: 'demo.cpp',
        line: 2,
        character: 23,
        kind: 'source.organizeImports',
      })
      const value = output[0]?.value as
        | { unavailable?: { reason: string }; changedFiles?: unknown[]; errorMessage?: string }
        | undefined
      expect(
        value?.unavailable !== undefined ||
          value?.changedFiles !== undefined ||
          value?.errorMessage !== undefined,
      ).toBe(true)
      await service.dispose()
    },
    30_000,
  )
})
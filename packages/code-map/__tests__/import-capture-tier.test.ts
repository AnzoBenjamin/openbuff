/**
 * P3-T5 AST import-capture tier tests.
 *
 * Pins the mapping from tree-sitter @import.* captures (emitted by the same
 * tags queries the parse pipeline runs) to the exact specifier shapes the
 * line-based extractor emits, per tier language, plus the parse-pipeline
 * surfacing via parseTokensWithImports and the no-capture fallback signal.
 * Mock-driven so these cases run without a local WASM grammar; real-grammar
 * query validity for the edited .scm files is covered by the WASM integration
 * tests (integration.test.ts / all-language-wasm.test.ts).
 */
import {
  createMockTree,
  createMockTreeSitterCaptures,
  createMockTreeSitterParser,
  createMockTreeSitterQuery,
} from '@codebuff/common/testing/mocks/tree-sitter'
import { describe, expect, it } from 'bun:test'

import {
  extractImportSitesFromLines,
  importSpecifiersFromAstCaptures,
} from '../src/import-sites'
import { parseTokensWithImports } from '../src/parse'

import type { LanguageConfig } from '../src/languages-common'

function configFor(captures: Array<{ name: string; text: string }>): LanguageConfig {
  return {
    extensions: ['.ts'],
    wasmFile: 'tree-sitter-typescript.wasm',
    queryText: 'mock query',
    parser: createMockTreeSitterParser({ tree: createMockTree() }),
    query: createMockTreeSitterQuery({
      captures: createMockTreeSitterCaptures(captures),
    }),
  }
}

describe('importSpecifiersFromAstCaptures (P3-T5 AST tier mapping)', () => {
  it('maps TS/JS specifier and require-call captures to the raw unquoted shape', () => {
    expect(
      importSpecifiersFromAstCaptures(
        ['"./b"', "'./inner'"],
        ["require('node:fs')", 'fetch("./not-an-import")'],
        'src/a.ts',
      ),
    ).toEqual(['./b', './inner', 'node:fs'])
  })

  it('maps Python dotted and relative module captures (from x import y)', () => {
    expect(
      importSpecifiersFromAstCaptures(
        ['os.path', 'from .utils'],
        [],
        'pkg/module.py',
      ),
    ).toEqual(['os.path', '.utils'])
  })

  it('maps Go single and block import path captures without quotes', () => {
    expect(
      importSpecifiersFromAstCaptures(
        ['"fmt"', '"encoding/json"'],
        [],
        'main.go',
      ),
    ).toEqual(['fmt', 'encoding/json'])
  })

  it('reduces Rust use trees and mod items to the raw :: path shape', () => {
    expect(
      importSpecifiersFromAstCaptures(
        [
          'crate::config::Config',
          'crate::mod::{a, b}',
          'std::io::*',
          'std::fs as sysfs',
          'utils',
          'crate::{a, b}',
        ],
        [],
        'src/lib.rs',
      ),
    ).toEqual([
      'crate::config::Config',
      'crate::mod',
      'std::io::*',
      'std::fs',
      'utils',
      'crate',
    ])
  })

  it('caps the mapped specifier list like the line-based extractor', () => {
    const captures = Array.from({ length: 150 }, (_, i) => `"./mod${i}"`)
    expect(importSpecifiersFromAstCaptures(captures, [], 'src/a.ts')).toHaveLength(
      100,
    )
  })

  it('yields [] for languages outside the tier (fallback signal)', () => {
    expect(
      importSpecifiersFromAstCaptures(['com.acme.User'], [], 'Main.java'),
    ).toEqual([])
    expect(importSpecifiersFromAstCaptures(['"fmt"'], [], 'main.c')).toEqual([])
  })
})

describe('parseTokensWithImports (AST tier through the parse pipeline)', () => {
  it('resolves a multiline named TS import from the AST capture', () => {
    const source = 'import {\n  helper,\n  util,\n} from "./helper"\n'
    const result = parseTokensWithImports(
      'src/a.ts',
      configFor([{ name: 'import.specifier', text: '"./helper"' }]),
      () => source,
    )
    expect(result.imports).toEqual(['./helper'])
  })

  it('covers the multiline named import the per-line extractor misses', () => {
    const source = 'import {\n  helper,\n} from "./helper"\n'
    // The line-based per-line pass finds nothing here (this shape is only
    // covered by the indexer's multiline IMPORT_REGEX supplement).
    expect(extractImportSitesFromLines(source.split('\n'), 'src/a.ts')).toEqual(
      [],
    )
    // The AST tier resolves it directly from the import_statement capture.
    expect(
      importSpecifiersFromAstCaptures(['"./helper"'], [], 'src/a.ts'),
    ).toEqual(['./helper'])
  })

  it('surfaces Python from-import captures', () => {
    const result = parseTokensWithImports(
      'pkg/module.py',
      configFor([{ name: 'import.specifier', text: 'from .utils' }]),
      () => 'from .utils import helper\n',
    )
    expect(result.imports).toEqual(['.utils'])
  })

  it('surfaces Go block-import path captures', () => {
    const result = parseTokensWithImports(
      'main.go',
      configFor([
        { name: 'import.specifier', text: '"fmt"' },
        { name: 'import.specifier', text: '"errors"' },
      ]),
      () => 'import (\n\t"fmt"\n\t"errors"\n)\n',
    )
    expect(result.imports).toEqual(['fmt', 'errors'])
  })

  it('surfaces Rust use and mod captures', () => {
    const result = parseTokensWithImports(
      'src/lib.rs',
      configFor([
        { name: 'import.specifier', text: 'crate::config::Config' },
        { name: 'import.specifier', text: 'utils' },
      ]),
      () => 'use crate::config::Config;\nmod utils;\n',
    )
    expect(result.imports).toEqual(['crate::config::Config', 'utils'])
  })

  it('returns [] imports when the query exposes no @import captures', () => {
    const result = parseTokensWithImports(
      'src/a.ts',
      configFor([{ name: 'identifier', text: 'helper' }]),
      () => 'const helper = 1\n',
    )
    expect(result.imports).toEqual([])
  })

  it('does not leak @import captures into identifiers or calls', () => {
    const result = parseTokensWithImports(
      'src/a.ts',
      configFor([
        { name: 'identifier', text: 'helper' },
        { name: 'import.specifier', text: '"./helper"' },
        { name: 'import.call', text: 'require("x")' },
      ]),
      () => 'const helper = require("x")\n',
    )
    expect(result.identifiers).toEqual(['helper'])
    expect(result.calls).toEqual([])
  })
})

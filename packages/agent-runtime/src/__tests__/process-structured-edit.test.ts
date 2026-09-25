import { describe, expect, it } from 'bun:test'

import { processStructuredEdit } from '../process-structured-edit'

import type {
  StructuredTransactionEdit,
} from '../process-structured-edit'
import type { Logger } from '@codebuff/common/types/contracts/logger'

/**
 * Failure-path campaign for the 12-language import logic in
 * process-structured-edit.ts. Everything is driven through the
 * processStructuredEdit entry point against pure content strings — no
 * filesystem, no tmux, fully hermetic.
 */

const throwingLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

async function run(
  operation: StructuredTransactionEdit['operation'],
  content: string,
  filePath = './src/x.ts',
) {
  return processStructuredEdit({
    edit: { type: 'structured', path: filePath, operation },
    initialContentPromise: Promise.resolve(content),
    logger: throwingLogger,
  })
}

function expectError(result: Awaited<ReturnType<typeof run>>): string {
  if ('error' in result) return result.error
  throw new Error(`expected an error result, got ${JSON.stringify(result)}`)
}

function expectContent(result: Awaited<ReturnType<typeof run>>): string {
  if ('content' in result) return result.content
  throw new Error(`expected a content result, got: ${JSON.stringify(result)}`)
}

const insertText = (line: number, column: number, text = 'X') =>
  ({ kind: 'insert_text', position: { line, column }, text }) as const

const insertImport = (importStatement: string) =>
  ({ kind: 'insert_import', importStatement }) as const

const removeImport = (statementOrSpecifier: string) =>
  ({ kind: 'remove_import', moduleSpecifier: statementOrSpecifier }) as const

describe('processStructuredEdit insert_text bounds', () => {
  it('rejects non-existent target files', async () => {
    const result = await processStructuredEdit({
      edit: {
        type: 'structured',
        path: './missing.ts',
        operation: insertImport('import { x } from "./x"'),
      },
      initialContentPromise: Promise.resolve(null),
      logger: throwingLogger,
    })
    expect(expectError(result)).toContain('file does not exist or could not be read')
  })

  it('rejects 1-indexed positions below 1 (line/column)', async () => {
    for (const [line, column, bad] of [
      [0, 1, 'line'],
      [1, 0, 'column'],
      [-2, 1, 'line'],
      [1, -1, 'column'],
    ] as const) {
      const error = expectError(await run(insertText(line, column), 'a\n'))
      expect(error).toContain('1-indexed and must be >= 1')
      expect(error).toContain(bad)
    }
  })

  it('rejects a line past end of file and reports the real line count', async () => {
    const error = expectError(await run(insertText(3, 1), 'a\nb'))
    expect(error).toContain('line 3 is past end of file (2 line(s))')
  })

  it('rejects a column past the end of the line without clamping', async () => {
    const error = expectError(await run(insertText(1, 4), 'ab'))
    expect(error).toContain('column 4 is past end of line (3)')
  })

  it('accepts column == lineLength+1 (pure append at EOL)', async () => {
    expect(expectContent(await run(insertText(1, 3), 'ab'))).toBe('abX')
  })

  it('does not consume the CR of a CRLF line when checking bounds', async () => {
    // lineLength for 'X\r\nX' is 2 (the \r is excluded), so column 3 is
    // valid and the insertion must land before \r\n, not corrupt it.
    expect(expectContent(await run(insertText(1, 3), 'ab\r\ncd'))).toBe('abX\r\ncd')
    // One past that (column 4) is still out of bounds even on CRLF.
    expect(expectError(await run(insertText(1, 4), 'ab\r\ncd'))).toContain('past end of line')
  })

  it('inserts mid-line and preserves surrounding content', async () => {
    expect(expectContent(await run(insertText(2, 2), 'ab\ncd'))).toBe('ab\ncXd')
  })
})

describe('processStructuredEdit insert_import (typescript family)', () => {
  it('rejects an invalid statement with a structured error', async () => {
    expect(expectError(await run(insertImport('const x = 1'), ''))).toContain(
      'Invalid insert_import statement',
    )
  })

  it('rejects an already-present import (dedupe failure path)', async () => {
    const existing = 'import { a } from "./a"\nimport { b } from "./b"\n'
    expect(expectError(await run(insertImport('import { b } from "./b"'), existing))).toContain(
      'import already exists',
    )
  })

  it('treats a trailing semicolon as already-present (normalize step)', async () => {
    const existing = 'import { a } from "./a"\n'
    expect(
      expectError(await run(insertImport('import { a } from "./a";'), existing)),
    ).toContain('import already exists')
  })

  it('appends after the last existing import (not at the top)', async () => {
    const existing = 'import { a } from "./a"\nexport const keep = 1\nimport { b } from "./b"\n'
    expect(expectContent(await run(insertImport('import { c } from "./c"'), existing))).toBe(
      'import { a } from "./a"\nexport const keep = 1\nimport { b } from "./b"\nimport { c } from "./c"\n',
    )
  })

  it('inserts after the shebang in a modern-ts file', async () => {
    const existing = '#!/usr/bin/env node\nimport { a } from "./a"\n'
    expect(expectContent(await run(insertImport('import { y } from "./y"'), existing))).toBe(
      '#!/usr/bin/env node\nimport { a } from "./a"\nimport { y } from "./y"\n',
    )
  })

  it('appends to side-effect-import style statements', async () => {
    expect(expectContent(await run(insertImport('import "./side"'), 'import "./a"\n'))).toContain(
      'import "./a"\nimport "./side"',
    )
  })

  it('appends after `use strict` in js when imports exist', async () => {
    const existing = '"use strict";\nimport { a } from "./a"\n'
    expect(expectContent(await run(insertImport('import { z } from "./z"'), existing))).toBe(
      '"use strict";\nimport { a } from "./a"\nimport { z } from "./z"\n',
    )
  })
})

describe('processStructuredEdit insert_import (other languages)', () => {
  const cases: Array<{
    name: string
    filePath: string
    content: string
    statement: string
    expectedIncludes: string[]
  }> = [
    {
      name: 'js',
      filePath: './src/x.js',
      content: 'import helper from "./helper"\n',
      statement: 'import other from "./other"',
      expectedIncludes: ['import other from "./other"'],
    },
    {
      name: 'tsx',
      filePath: './src/x.tsx',
      content: 'import { Component } from "react"\n',
      statement: 'import type { Props } from "./props"',
      expectedIncludes: ['import type { Props } from "./props"'],
    },
    {
      name: 'python (after existing import)',
      filePath: 'a.py',
      content: '#!/usr/bin/env python3\nimport sys\n',
      statement: 'import os',
      expectedIncludes: ['import sys\nimport os'],
    },
    {
      name: 'rust',
      filePath: 'lib.rs',
      content: 'use std::vec;\n',
      statement: 'use std::collections::HashMap;',
      expectedIncludes: ['use std::collections::HashMap;'],
    },
    {
      name: 'java (after package line)',
      filePath: 'App.java',
      content: 'package com.example;\n',
      statement: 'import java.util.List;',
      expectedIncludes: ['package com.example;\nimport java.util.List;'],
    },
    {
      name: 'c#',
      filePath: 'File.cs',
      content: '// header\n',
      statement: 'using System.Text;',
      expectedIncludes: ['using System.Text;'],
    },
    {
      name: 'c++',
      filePath: 'main.cpp',
      content: '#include <string>\n',
      statement: '#include <vector>',
      expectedIncludes: ['#include <string>\n#include <vector>'],
    },
    {
      name: 'ruby',
      filePath: 'app.rb',
      content: 'require "json"\n',
      statement: "require 'yaml'",
      expectedIncludes: ["require 'yaml'"],
    },
    {
      name: 'php (after <?php tag)',
      filePath: 'x.php',
      content: '<?php\n',
      statement: 'use App\\Models\\User;',
      expectedIncludes: ['<?php\nuse App\\Models\\User;'],
    },
    {
      name: 'swift',
      filePath: 'App.swift',
      content: 'import Foundation\n',
      statement: 'import SwiftUI',
      expectedIncludes: ['import SwiftUI'],
    },
    {
      name: 'godot (after extends header)',
      filePath: 'Player.gd',
      content: 'extends Node2D\n',
      statement: 'const icon = preload("res://icon.png")',
      expectedIncludes: ['const icon = preload("res://icon.png")'],
    },
    {
      name: 'kotlin',
      filePath: 'Main.kt',
      content: 'package com.demo\n',
      statement: 'import kotlin.io.path.Path',
      expectedIncludes: ['import kotlin.io.path.Path'],
    },
  ]

  for (const { name, filePath, content: inputContent, statement, expectedIncludes } of cases) {
    it(`inserts imports for ${name}`, async () => {
      const next = expectContent(
        await run(insertImport(statement), inputContent, filePath),
      )
      for (const include of expectedIncludes) {
        expect(next).toContain(include)
      }
    })
  }
})

describe('processStructuredEdit go import blocks and inline statements', () => {
  it('inserts an inline import into an existing block', async () => {
    const content = 'package main\n\nimport (\n\t"fmt"\n)\n'
    expect(expectContent(await run(insertImport('import "os"'), content, 'main.go'))).toContain(
      '\t"fmt"\n\t"os"\n)',
    )
  })

  it('rejects an import whose specifier is already in the block', async () => {
    const content = 'package main\n\nimport (\n\t"fmt"\n)\n'
    expect(
      expectError(await run(insertImport('import "fmt"'), content, 'main.go')),
    ).toContain('import already exists')
  })

  it('appends an inline go import after the last existing statement', async () => {
    const content = 'package main\n\nimport "fmt"\n'
    expect(expectContent(await run(insertImport('import "os"'), content, 'main.go'))).toContain(
      'import "fmt"\nimport "os"',
    )
  })

  it('accepts a named (aliased) inline go import', async () => {
    const content = 'package main\n\nimport "fmt"\n'
    expect(
      expectContent(await run(insertImport('import ai "github.com/x/ai"'), content, 'main.go')),
    ).toContain('ai "github.com/x/ai"')
  })
})

describe('processStructuredEdit regex edge cases', () => {
  it('treats a raw-string (backtick) go import as a valid statement', async () => {
    const content = 'package main\n\nimport `fmt`\n'
    expect(
      expectContent(await run(insertImport('import `os`'), content, 'main.go')),
    ).toContain('`os`')
  })

  it('links imports so a comment after an inline go import is preserved on removal-by-statement', async () => {
    const content = 'package main\n\nimport "fmt" // stdlib\n'
    // No block: statement-based removal removes the whole line range only when
    // the (trimmed) statement matches exactly; comment-bearing lines are
    // intentionally NOT silently stripped by the statement matcher.
    expect(
      expectError(await run(removeImport('os'), content, 'main.go')),
    ).toContain('no matching import declaration found')
  })

  it('preserves the inline comment handler through a backtick go import round-trip', async () => {
    const existing = 'package main\n\nimport `fmt`\n'
    expect(
      expectContent(await run(insertImport('import `os`'), existing, 'main.go')),
    ).toContain('`fmt`\nimport `os`')
  })

  it('keeps inline comments that trail the removed line of a go import block', async () => {
    const content = 'package main\n\nimport (\n\t"fmt" // stdlib\n\t"os"\n)\n'
    const next = expectContent(await run(removeImport('fmt'), content, 'main.go'))
    expect(next).not.toContain('fmt')
    expect(next).toContain('"os"')
    expect(next).toContain(')\n')
  })

  it('round-trips plain statement-only ts imports without cross-language leakage', async () => {
    const existing = 'import x from "./x"\n'
    expect(expectContent(await run(insertImport('import y from "./y"'), existing))).toContain(
      'import y from "./y"',
    )
  })
})

describe('processStructuredEdit remove_import failure modes', () => {
  it('rejects an operation that specifies neither statement nor specifier', async () => {
    const error = expectError(await run({ kind: 'remove_import' }, 'import { a } from "./a"\n'))
    expect(error).toContain('provide importStatement or moduleSpecifier')
  })

  it('rejects an invalid statement', async () => {
    const error = expectError(
      await run({ kind: 'remove_import', importStatement: 'let x = 1' }, 'import { a } from "./a"\n'),
    )
    expect(error).toContain('Invalid remove_import statement')
  })

  it('reports a structured error when no matching import exists', async () => {
    const error = expectError(
      await run(removeImport('./missing'), 'import { a } from "./a"\n', './src/a.ts'),
    )
    expect(error).toContain('no matching import declaration found')
  })

  it('reports a structured error when the statement is ambiguous (multi-match)', async () => {
    const content = 'import { a } from "./a"\nimport { a } from "./a"\n'
    const error = expectError(await run(removeImport('./a'), content, './src/a.ts'))
    expect(error).toContain('2 matching import declarations found')
  })

  it('removes by module specifier when the statement could differ in formatting', async () => {
    const content = 'import { helper } from "./helper"\nexport const keep = 1\n'
    expect(expectContent(await run(removeImport('./helper'), content, './src/a.ts'))).toBe(
      'export const keep = 1\n',
    )
  })
})

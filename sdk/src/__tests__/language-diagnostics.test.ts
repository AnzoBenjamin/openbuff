import { describe, expect, test } from 'bun:test'

import {
  parseLanguageDiagnostics,
  type DiagnosticParser,
  type LanguageDiagnostic,
} from '../tools/language-diagnostics'
// The root SDK barrel must publish the applicability union alongside
// LanguageDiagnosticTextEdit so consumers importing from the package root can
// branch on `applicability` instead of falling back to an indexed-access type.
import type {
  LanguageDiagnosticTextEdit,
  LanguageDiagnosticTextEditApplicability,
} from '../index'

describe('parseLanguageDiagnostics', () => {
  test('normalizes compiler diagnostics to project-relative, 1-indexed ranges', () => {
    const diagnostics = parseLanguageDiagnostics({
      command: 'npx --no-install tsc --noEmit',
      cwd: '/repo',
      stderr: '/repo/src/index.ts(4,7): error TS2322: Type mismatch',
    })

    expect(diagnostics).toEqual([
      {
        file: 'src/index.ts',
        range: {
          start: { line: 4, column: 7 },
          end: { line: 4, column: 7 },
        },
        severity: 'error',
        code: 'TS2322',
        message: 'Type mismatch',
        command: 'npx --no-install tsc --noEmit',
        source: 'compiler',
      },
    ])
  })

  test('parses cargo diagnostics with their following source location', () => {
    const diagnostics = parseLanguageDiagnostics({
      command: 'cargo clippy --all-targets',
      stderr: [
        'error[E0308]: mismatched types',
        '  --> src/lib.rs:12:9',
        '   |',
      ].join('\n'),
    })

    expect(diagnostics).toMatchObject([
      {
        file: 'src/lib.rs',
        range: { start: { line: 12, column: 9 } },
        severity: 'error',
        code: 'E0308',
        message: 'mismatched types',
        source: 'cargo',
      },
    ])
  })

  test('parses JVM, Python, PHPStan, and Godot output', () => {
    const cases = [
      {
        command: './gradlew check',
        stderr: 'e: file:///repo/src/App.kt:8:3 Unresolved reference: value',
        expected: { file: 'src/App.kt', source: 'kotlin', line: 8 },
      },
      {
        command: 'pyright',
        stdout:
          '/repo/app.py:3:5 - error: Unknown name (reportUndefinedVariable)',
        expected: { file: 'app.py', source: 'python', line: 3 },
      },
      {
        command: 'vendor/bin/phpstan analyse --error-format=raw',
        stdout: '/repo/src/App.php:19:Call to an undefined method',
        expected: { file: 'src/App.php', source: 'phpstan', line: 19 },
      },
      {
        command: 'godot --headless --editor --quit --path .',
        stderr:
          'SCRIPT ERROR: Parse Error: Expected expression.\n   at: GDScript::reload (res://scripts/player.gd:6)',
        expected: { file: 'scripts/player.gd', source: 'godot', line: 6 },
      },
    ]

    for (const item of cases) {
      const [diagnostic] = parseLanguageDiagnostics({
        command: item.command,
        cwd: '/repo',
        stdout: item.stdout,
        stderr: item.stderr,
      })
      expect(diagnostic).toMatchObject({
        file: item.expected.file,
        source: item.expected.source,
        range: { start: { line: item.expected.line } },
      })
    }
  })

  test('derives JVM source from the tool token or file extension, not regex precedence', () => {
    const parse = (stderr: string) =>
      parseLanguageDiagnostics({
        command: './gradlew check',
        cwd: '/repo',
        stderr,
      })

    // The Maven line format carries no tool token, so a Maven-wrapped
    // kotlinc diagnostic for a .kt file must persist source 'kotlin' derived
    // from the file extension rather than the 'java' value implied by which
    // regex matched.
    const mavenKotlin = parse(
      '[ERROR] /repo/src/App.kt:[8,3] Unresolved reference: value',
    )
    expect(mavenKotlin).toHaveLength(1)
    expect(mavenKotlin[0]).toMatchObject({
      file: 'src/App.kt',
      source: 'kotlin',
      severity: 'error',
    })

    const mavenJava = parse(
      '[ERROR] /repo/src/Main.java:[10,5] cannot find symbol',
    )
    expect(mavenJava).toHaveLength(1)
    expect(mavenJava[0]).toMatchObject({
      file: 'src/Main.java',
      source: 'java',
    })

    // The javac line format also names no tool; its persisted source must
    // not depend on regex precedence either.
    const javac = parse('src/Main.java:10: error: cannot find symbol')
    expect(javac).toHaveLength(1)
    expect(javac[0]).toMatchObject({
      file: 'src/Main.java',
      source: 'java',
      severity: 'error',
    })
  })

  test('does not turn unlocated log lines into diagnostics', () => {
    expect(
      parseLanguageDiagnostics({
        command: 'gradle check',
        stderr: 'Build failed because a task returned a non-zero exit code.',
      }),
    ).toEqual([])
  })
})

describe('structured diagnostic parsers', () => {
  test('parses cargo NDJSON with primary span and suggested fix', () => {
    const diagnostics = parseLanguageDiagnostics({
      command: 'cargo check --message-format=json',
      stdout: [
        JSON.stringify({
          reason: 'compiler-message',
          message: {
            level: 'error',
            code: { code: 'E0308' },
            message: 'mismatched types',
            spans: [
              {
                file_name: 'src/lib.rs',
                line_start: 11,
                line_end: 11,
                column_start: 8,
                column_end: 9,
                is_primary: true,
                suggested_replacement: null,
              },
            ],
            children: [
              {
                message: 'help: try `u32`',
                spans: [
                  {
                    file_name: 'src/lib.rs',
                    line_start: 11,
                    line_end: 11,
                    column_start: 8,
                    column_end: 9,
                    suggested_replacement: 'u32',
                  },
                ],
              },
            ],
          },
        }),
      ].join('\n'),
    })

    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0]).toMatchObject({
      file: 'src/lib.rs',
      severity: 'error',
      code: 'E0308',
      message: 'mismatched types',
      source: 'cargo',
      range: {
        start: { line: 11, column: 8 },
        end: { line: 11, column: 9 },
      },
      fixes: [
        {
          file: 'src/lib.rs',
          newText: 'u32',
          range: {
            start: { line: 11, column: 8 },
            end: { line: 11, column: 9 },
          },
        },
      ],
    })
  })

  test('parses ruff JSON output including fix edits', () => {
    const diagnostics = parseLanguageDiagnostics({
      command: 'ruff check --output-format=json',
      cwd: '/repo',
      stdout: JSON.stringify([
        {
          code: 'F401',
          message: "'os' imported but unused",
          filename: '/repo/app.py',
          location: { row: 1, column: 8 },
          end_location: { row: 1, column: 10 },
          severity: null,
          fix: {
            edits: [
              {
                content: '',
                location: { row: 1, column: 8 },
                end_location: { row: 1, column: 10 },
              },
            ],
          },
        },
      ]),
    })

    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0]).toMatchObject({
      file: 'app.py',
      severity: 'warning',
      code: 'F401',
      source: 'ruff',
      range: { start: { line: 1, column: 8 }, end: { line: 1, column: 10 } },
      fixes: [
        {
          file: 'app.py',
          newText: '',
          range: { start: { line: 1, column: 8 }, end: { line: 1, column: 10 } },
        },
      ],
    })
  })

  test('parses pyright --outputjson diagnostics', () => {
    const diagnostics = parseLanguageDiagnostics({
      command: 'pyright --outputjson',
      cwd: '/repo',
      stdout: JSON.stringify({
        diagnostics: [
          {
            file: '/repo/app.py',
            severity: 'error',
            message: '"x" is not defined',
            rule: 'reportUndefinedVariable',
            range: {
              start: { line: 2, character: 4 },
              end: { line: 2, character: 10 },
            },
          },
        ],
      }),
    })

    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0]).toMatchObject({
      file: 'app.py',
      severity: 'error',
      code: 'reportUndefinedVariable',
      source: 'pyright',
      range: { start: { line: 3, column: 5 }, end: { line: 3, column: 11 } },
    })

    // Real `pyright --outputjson` emits LSP-style positions keyed
    // `character` (0-based); a `column`-keyed range is a shape pyright never
    // emits and must not be silently accepted.
    expect(
      parseLanguageDiagnostics({
        command: 'pyright --outputjson',
        stdout: JSON.stringify({
          diagnostics: [
            {
              file: '/repo/app.py',
              severity: 'error',
              message: 'column-keyed shape pyright never emits',
              range: { start: { line: 2, column: 4 } },
            },
          ],
        }),
      }),
    ).toEqual([])
  })

  test('parses eslint -f json without fabricating fix ranges', () => {
    const diagnostics = parseLanguageDiagnostics({
      command: 'eslint -f json src',
      cwd: '/repo',
      stdout: JSON.stringify([
        {
          filePath: '/repo/src/index.js',
          messages: [
            {
              ruleId: 'no-unused-vars',
              severity: 2,
              message: "'x' is defined but never used.",
              line: 3,
              column: 7,
              endLine: 3,
              endColumn: 8,
              fix: { range: [30, 31], text: 'y' },
            },
          ],
        },
      ]),
    })

    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0]).toMatchObject({
      file: 'src/index.js',
      severity: 'error',
      code: 'no-unused-vars',
      source: 'eslint',
      range: { start: { line: 3, column: 7 }, end: { line: 3, column: 8 } },
    })
    // eslint fix.range holds character offsets into the file; without the
    // file content the parser must not substitute the message range as a
    // fix range.
    expect(diagnostics[0].fixes).toBeUndefined()
  })

  test('captures eslint fix-its by mapping fix offsets against the included source', () => {
    const diagnostics = parseLanguageDiagnostics({
      command: 'eslint -f json src',
      cwd: '/repo',
      stdout: JSON.stringify([
        {
          filePath: '/repo/src/index.js',
          source: 'const a = 1\nconst b = 2\nlet x = 3\n',
          messages: [
            {
              ruleId: 'prefer-const',
              severity: 1,
              message: "'x' is never reassigned.",
              line: 3,
              column: 5,
              endLine: 3,
              endColumn: 6,
              fix: { range: [24, 27], text: 'const' },
            },
          ],
        },
      ]),
    })

    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0]).toMatchObject({
      file: 'src/index.js',
      severity: 'warning',
      code: 'prefer-const',
      source: 'eslint',
      fixes: [
        {
          file: 'src/index.js',
          newText: 'const',
          range: {
            start: { line: 3, column: 1 },
            end: { line: 3, column: 4 },
          },
        },
      ],
    })
  })

  test('maps uppercase ruff severity tokens to error, not warning', () => {
    const diagnostics = parseLanguageDiagnostics({
      command: 'ruff check --output-format=json',
      stdout: JSON.stringify([
        {
          code: 'E501',
          message: 'line too long',
          filename: '/repo/big.py',
          location: { row: 2, column: 1 },
          end_location: { row: 2, column: 90 },
          severity: 'ERROR',
        },
      ]),
    })

    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0]).toMatchObject({
      severity: 'error',
      code: 'E501',
      source: 'ruff',
    })
  })

  test('parses golangci-lint --out-format=json', () => {
    const diagnostics = parseLanguageDiagnostics({
      command: 'golangci-lint run --out-format=json',
      stdout: JSON.stringify({
        Issues: [
          {
            FromLinter: 'errcheck',
            Text: 'Error return value is not checked',
            Pos: { Filename: 'main.go', Line: 10, Column: 2 },
          },
        ],
      }),
    })

    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0]).toMatchObject({
      file: 'main.go',
      severity: 'error',
      code: 'errcheck',
      message: 'Error return value is not checked',
      source: 'golangci-lint',
      range: { start: { line: 10, column: 2 } },
    })
  })

  test('parses go vet -json positions defensively', () => {
    const diagnostics = parseLanguageDiagnostics({
      command: 'go vet ./...',
      stdout: JSON.stringify({
        'example.com/pkg': {
          'go vet': {
            pois: [
              { posn: 'main.go:10:2', msg: 'fmt.Errorf call needs 1 arg' },
            ],
          },
        },
      }),
    })

    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0]).toMatchObject({
      file: 'main.go',
      severity: 'error',
      message: 'fmt.Errorf call needs 1 arg',
      source: 'go vet',
      range: { start: { line: 10, column: 2 } },
    })
  })

  test('parses SARIF 2.1.0 results, fixes, and related locations', () => {
    const diagnostics = parseLanguageDiagnostics({
      command: 'dotnet build -p:ErrorLog=sarif.json',
      cwd: '/repo',
      stdout: JSON.stringify({
        version: '2.1.0',
        runs: [
          {
            results: [
              {
                ruleId: 'CS0168',
                level: 'warning',
                message: { text: 'Variable is declared but never used' },
                locations: [
                  {
                    physicalLocation: {
                      artifactLocation: {
                        uri: 'file:///repo/src/Program.cs',
                      },
                      region: {
                        startLine: 5,
                        startColumn: 9,
                        endLine: 5,
                        endColumn: 13,
                      },
                    },
                  },
                ],
                fixes: [
                  {
                    artifactChanges: [
                      {
                        artifactLocation: {
                          uri: 'file:///repo/src/Program.cs',
                        },
                        replacements: [
                          {
                            deletedRegion: {
                              startLine: 5,
                              startColumn: 9,
                              endLine: 5,
                              endColumn: 13,
                            },
                            insertedContent: { text: 'int y' },
                          },
                        ],
                      },
                    ],
                  },
                ],
                relatedLocations: [
                  {
                    physicalLocation: {
                      artifactLocation: { uri: 'src/util.cs' },
                      region: {
                        startLine: 7,
                        startColumn: 1,
                        endLine: 7,
                        endColumn: 4,
                      },
                    },
                    message: { text: 'See related method' },
                  },
                ],
              },
            ],
          },
        ],
      }),
    })

    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0]).toMatchObject({
      file: 'src/Program.cs',
      severity: 'warning',
      code: 'CS0168',
      source: 'sarif',
      range: { start: { line: 5, column: 9 }, end: { line: 5, column: 13 } },
      fixes: [
        {
          file: 'src/Program.cs',
          newText: 'int y',
          range: { start: { line: 5, column: 9 }, end: { line: 5, column: 13 } },
        },
      ],
      relatedInformation: [
        {
          file: 'src/util.cs',
          range: { start: { line: 7, column: 1 }, end: { line: 7, column: 4 } },
          message: 'See related method',
        },
      ],
    })
  })

  test('maps SARIF results with no explicit level to info, not error', () => {
    const diagnostics = parseLanguageDiagnostics({
      command: 'semgrep --sarif',
      stdout: JSON.stringify({
        version: '2.1.0',
        runs: [
          {
            results: [
              {
                ruleId: 'rule-1',
                message: { text: 'Spec-default severity' },
                locations: [
                  {
                    physicalLocation: {
                      artifactLocation: { uri: 'src/a.py' },
                      region: { startLine: 2, startColumn: 1 },
                    },
                  },
                ],
              },
            ],
          },
        ],
      }),
    })

    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0]).toMatchObject({
      severity: 'info',
      range: { start: { line: 2, column: 1 }, end: { line: 2, column: 1 } },
    })
  })

  test('normalizes SARIF levels through the shared severity() mapping', () => {
    const sarifWithLevel = (level: string) =>
      JSON.stringify({
        version: '2.1.0',
        runs: [
          {
            results: [
              {
                ruleId: 'rule-1',
                level,
                message: { text: `Level ${level}` },
                locations: [
                  {
                    physicalLocation: {
                      artifactLocation: { uri: 'src/a.py' },
                      region: { startLine: 2, startColumn: 1 },
                    },
                  },
                ],
              },
            ],
          },
        ],
      })

    // SARIF 'note' must normalize to 'info' exactly like a plain-text
    // 'note' so equivalent compiler severities persist the same severity
    // across the SARIF and text paths.
    const note = parseLanguageDiagnostics({
      command: 'semgrep --sarif',
      stdout: sarifWithLevel('note'),
    })
    expect(note).toHaveLength(1)
    expect(note[0].severity).toBe('info')

    // 'none' and unrecognized extension tokens must not be silently
    // downgraded to 'info': they take the shared severity() default, the
    // same fail-loud mapping an unknown plain-text severity token gets.
    const none = parseLanguageDiagnostics({
      command: 'semgrep --sarif',
      stdout: sarifWithLevel('none'),
    })
    expect(none).toHaveLength(1)
    expect(none[0].severity).toBe('error')

    const extensionToken = parseLanguageDiagnostics({
      command: 'semgrep --sarif',
      stdout: sarifWithLevel('vendor-custom-level'),
    })
    expect(extensionToken).toHaveLength(1)
    expect(extensionToken[0].severity).toBe('error')
  })

  test('stays a pure parser when an ErrorLog command emits no SARIF on the streams', () => {
    const diagnostics = parseLanguageDiagnostics({
      command: 'dotnet build -p:ErrorLog=/tmp/msbuild.sarif.json',
      cwd: '/repo',
    })

    expect(diagnostics).toEqual([])
  })

  test('falls back to the cargo regex parser for plain-text output', () => {
    const diagnostics = parseLanguageDiagnostics({
      command: 'cargo check',
      stderr: [
        'error[E0308]: mismatched types',
        '  --> src/lib.rs:12:9',
        '   |',
      ].join('\n'),
    })

    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0]).toMatchObject({
      file: 'src/lib.rs',
      severity: 'error',
      code: 'E0308',
      source: 'cargo',
      range: { start: { line: 12, column: 9 } },
    })
    expect(diagnostics[0].fixes).toBeUndefined()
  })

  test('still parses pyright plain-text output via the regex parser', () => {
    const diagnostics = parseLanguageDiagnostics({
      command: 'pyright',
      cwd: '/repo',
      stdout: '/repo/app.py:3:5 - error: Unknown name (reportUndefinedVariable)',
    })

    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0]).toMatchObject({
      file: 'app.py',
      source: 'python',
      range: { start: { line: 3, column: 5 } },
    })
  })

  test('honors an explicitly supplied parsers list instead of forcing structured parsers', () => {
    const sentinel: LanguageDiagnostic = {
      file: 'src/custom.ts',
      range: {
        start: { line: 1, column: 1 },
        end: { line: 1, column: 1 },
      },
      severity: 'error',
      code: null,
      message: 'custom parser diagnostic',
      command: 'cargo check --message-format=json',
      source: 'custom',
    }
    const customParser: DiagnosticParser = {
      id: 'custom',
      parse: () => [sentinel],
    }
    // The structured cargo parser would parse this NDJSON output; the
    // caller-supplied list must take precedence instead of being suppressed
    // by structured parsers that produce output.
    const diagnostics = parseLanguageDiagnostics(
      {
        command: 'cargo check --message-format=json',
        stdout: [
          JSON.stringify({
            reason: 'compiler-message',
            message: {
              level: 'error',
              message: 'mismatched types',
              spans: [
                {
                  file_name: 'src/lib.rs',
                  line_start: 11,
                  line_end: 11,
                  column_start: 8,
                  column_end: 9,
                  is_primary: true,
                },
              ],
            },
          }),
        ].join('\n'),
      },
      [customParser],
    )

    expect(diagnostics).toEqual([sentinel])
  })

  test('keeps distinct diagnostics that differ only in fix-it content', () => {
    const result = (replacement: string) => ({
      reason: 'compiler-message',
      message: {
        level: 'error',
        code: { code: 'E0308' },
        message: 'mismatched types',
        spans: [
          {
            file_name: 'src/lib.rs',
            line_start: 11,
            line_end: 11,
            column_start: 8,
            column_end: 9,
            is_primary: true,
          },
        ],
        children: [
          {
            message: 'help',
            spans: [
              {
                file_name: 'src/lib.rs',
                line_start: 11,
                line_end: 11,
                column_start: 8,
                column_end: 9,
                suggested_replacement: replacement,
              },
            ],
          },
        ],
      },
    })
    const diagnostics = parseLanguageDiagnostics({
      command: 'cargo check --message-format=json',
      stdout: [result('u32'), result('i64')]
        .map((item) => JSON.stringify(item))
        .join('\n'),
    })

    expect(diagnostics).toHaveLength(2)
    expect(diagnostics[0].fixes?.[0]?.newText).toBe('u32')
    expect(diagnostics[1].fixes?.[0]?.newText).toBe('i64')
  })

  test('resolves SARIF uriBaseId against originalUriBaseIds', () => {
    const diagnostics = parseLanguageDiagnostics({
      command: 'dotnet build -p:ErrorLog=sarif.json',
      cwd: '/repo',
      stdout: JSON.stringify({
        version: '2.1.0',
        runs: [
          {
            originalUriBaseIds: {
              SRCROOT: { uri: 'file:///repo/' },
            },
            results: [
              {
                ruleId: 'CS0168',
                level: 'warning',
                message: { text: 'Variable is declared but never used' },
                locations: [
                  {
                    physicalLocation: {
                      artifactLocation: {
                        uri: '/src/Program.cs',
                        uriBaseId: 'SRCROOT',
                      },
                      region: { startLine: 5, startColumn: 9 },
                    },
                  },
                ],
              },
            ],
          },
        ],
      }),
    })

    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0].file).toBe('src/Program.cs')
  })

  test('strips unresolved %SRCROOT%-style placeholders so file paths stay matchable', () => {
    const diagnostics = parseLanguageDiagnostics({
      command: 'semgrep --sarif',
      stdout: JSON.stringify({
        version: '2.1.0',
        runs: [
          {
            results: [
              {
                ruleId: 'rule-1',
                level: 'error',
                message: { text: 'Placeholder uri' },
                locations: [
                  {
                    physicalLocation: {
                      artifactLocation: { uri: '%SRCROOT%/src/a.py' },
                      region: { startLine: 2, startColumn: 1 },
                    },
                  },
                ],
              },
            ],
          },
        ],
      }),
    })

    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0].file).toBe('src/a.py')
  })

  test('parses clang -fdiagnostics-format=sarif diagnostics with fix-its', () => {
    // clang's JSON mode emits SARIF 2.1 results with fix-it hints as
    // `fixes`, so clang diagnostics carry real ranges and fix-its through
    // the same generic SARIF contract as MSBuild's /errorlog output.
    const diagnostics = parseLanguageDiagnostics({
      command: 'clang -fdiagnostics-format=sarif -c src/main.c',
      cwd: '/repo',
      stdout: JSON.stringify({
        version: '2.1.0',
        runs: [
          {
            results: [
              {
                ruleId: 'unused-variable',
                level: 'warning',
                message: { text: "Unused variable 'x'" },
                locations: [
                  {
                    physicalLocation: {
                      artifactLocation: { uri: 'file:///repo/src/main.c' },
                      region: {
                        startLine: 3,
                        startColumn: 7,
                        endLine: 3,
                        endColumn: 8,
                      },
                    },
                  },
                ],
                fixes: [
                  {
                    artifactChanges: [
                      {
                        artifactLocation: { uri: 'file:///repo/src/main.c' },
                        replacements: [
                          {
                            deletedRegion: {
                              startLine: 3,
                              startColumn: 7,
                              endLine: 3,
                              endColumn: 8,
                            },
                            insertedContent: { text: '(void)x' },
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      }),
    })

    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0]).toMatchObject({
      file: 'src/main.c',
      severity: 'warning',
      code: 'unused-variable',
      source: 'sarif',
      range: { start: { line: 3, column: 7 }, end: { line: 3, column: 8 } },
      fixes: [
        {
          file: 'src/main.c',
          newText: '(void)x',
          range: { start: { line: 3, column: 7 }, end: { line: 3, column: 8 } },
        },
      ],
    })
  })

  test('keeps plain-text clang output on the regex parser when SARIF mode is off', () => {
    const diagnostics = parseLanguageDiagnostics({
      command: 'clang -c src/main.c',
      stderr: "src/main.c:3:7: error: use of undeclared identifier 'y'",
    })

    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0]).toMatchObject({
      file: 'src/main.c',
      severity: 'error',
      source: 'compiler',
      range: { start: { line: 3, column: 7 } },
    })
  })

  test('captures plain-text diagnostics alongside structured JSON from one run', () => {
    // `go vet -json` emits analysis diagnostics as JSON on stdout while build
    // and type errors for failing packages stay plain text on stderr; the
    // structured output must not suppress the plain-text diagnostics.
    const diagnostics = parseLanguageDiagnostics({
      command: 'go vet -json ./...',
      stdout: JSON.stringify({
        'example.com/pkg': {
          'go vet': {
            pois: [
              { posn: 'main.go:10:2', msg: 'fmt.Errorf call needs 1 arg' },
            ],
          },
        },
      }),
      stderr: 'pkg/other.go:7:2: undefined: helper',
    })

    expect(diagnostics).toHaveLength(2)
    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          file: 'main.go',
          severity: 'error',
          message: 'fmt.Errorf call needs 1 arg',
          source: 'go vet',
          range: expect.objectContaining({
            start: { line: 10, column: 2 },
          }),
        }),
        expect.objectContaining({
          file: 'pkg/other.go',
          severity: 'error',
          message: 'undefined: helper',
          source: 'go',
          range: expect.objectContaining({
            start: { line: 7, column: 2 },
          }),
        }),
      ]),
    )
  })

  test('does not fabricate plain-text diagnostics from indented go vet -json bodies', () => {
    // A pretty-printed `go vet -json` body is one JSON document. The
    // plain-text go pass must not re-parse its indented lines, or keys like
    // `"posn": "main.go:10:2",` fabricate diagnostics with garbage file
    // paths in the persisted LanguageDiagnostic contract.
    const diagnostics = parseLanguageDiagnostics({
      command: 'go vet -json ./...',
      stdout: JSON.stringify(
        {
          'example.com/pkg': {
            'go vet': {
              pois: [
                { posn: 'main.go:10:2', msg: 'fmt.Errorf call needs 1 arg' },
              ],
            },
          },
        },
        null,
        2,
      ),
      stderr: 'pkg/other.go:7:2: undefined: helper',
    })

    expect(diagnostics).toHaveLength(2)
    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          file: 'main.go',
          severity: 'error',
          message: 'fmt.Errorf call needs 1 arg',
          source: 'go vet',
          range: expect.objectContaining({
            start: { line: 10, column: 2 },
          }),
        }),
        expect.objectContaining({
          file: 'pkg/other.go',
          severity: 'error',
          message: 'undefined: helper',
          source: 'go',
          range: expect.objectContaining({
            start: { line: 7, column: 2 },
          }),
        }),
      ]),
    )
    for (const diagnostic of diagnostics) {
      expect(diagnostic.file).not.toMatch(/posn|"/)
    }
  })

  test('percent-decodes SARIF artifact URIs so encoded paths stay matchable', () => {
    const diagnostics = parseLanguageDiagnostics({
      command: 'dotnet build -p:ErrorLog=sarif.json',
      cwd: '/repo',
      stdout: JSON.stringify({
        version: '2.1.0',
        runs: [
          {
            results: [
              {
                ruleId: 'CS0168',
                level: 'warning',
                message: { text: 'Variable is declared but never used' },
                locations: [
                  {
                    physicalLocation: {
                      artifactLocation: {
                        uri: 'file:///repo/src/my%20module/caf%C3%A9.cs',
                      },
                      region: { startLine: 5, startColumn: 9 },
                    },
                  },
                ],
              },
            ],
          },
        ],
      }),
    })

    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0].file).toBe('src/my module/café.cs')
  })

  test('records rustc suggestion_applicability on cargo fix-its', () => {
    const line = (applicability: string | null, replacement: string) =>
      JSON.stringify({
        reason: 'compiler-message',
        message: {
          level: 'warning',
          code: { code: 'E0308' },
          message: 'mismatched types',
          spans: [
            {
              file_name: 'src/lib.rs',
              line_start: 11,
              line_end: 11,
              column_start: 8,
              column_end: 9,
              is_primary: true,
            },
          ],
          children: [
            {
              message: 'help',
              spans: [
                {
                  file_name: 'src/lib.rs',
                  line_start: 11,
                  line_end: 11,
                  column_start: 8,
                  column_end: 9,
                  suggested_replacement: replacement,
                  ...(applicability
                    ? { suggestion_applicability: applicability }
                    : {}),
                },
              ],
            },
          ],
        },
      })
    const diagnostics = parseLanguageDiagnostics({
      command: 'cargo check --message-format=json',
      stdout: [
        line('MachineApplicable', 'u32'),
        line('MaybeIncorrect', 'i64'),
        line(null, 'f64'),
      ].join('\n'),
    })

    expect(diagnostics).toHaveLength(3)
    expect(diagnostics[0].fixes?.[0]?.applicability).toBe('machineApplicable')
    expect(diagnostics[1].fixes?.[0]?.applicability).toBe('maybeIncorrect')
    // A span without suggestion_applicability must not masquerade as
    // machine-applicable: consumers gate automated fix application on this.
    expect(diagnostics[2].fixes?.[0]?.applicability).toBe('unspecified')
  })

  test('does not let structured diagnostics starve plain-text ones at the cap', () => {
    // 210 structured go vet diagnostics exceed the shared MAX_DIAGNOSTICS
    // budget; the plain-text build error on stderr must still be reported
    // instead of being silently dropped by a structured-first ordering.
    const pois = Array.from({ length: 210 }, (_, index) => ({
      posn: `main.go:${index + 1}:2`,
      msg: `structured issue ${index + 1}`,
    }))
    const diagnostics = parseLanguageDiagnostics({
      command: 'go vet -json ./...',
      stdout: JSON.stringify({
        'example.com/pkg': {
          'go vet': { pois },
        },
      }),
      stderr: 'pkg/other.go:7:2: undefined: helper',
    })

    // The shared cap still applies, but interleaving guarantees the
    // plain-text diagnostic is represented rather than appended after the
    // structured ones and truncated away.
    expect(diagnostics.length).toBeLessThanOrEqual(200)
    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          file: 'pkg/other.go',
          severity: 'error',
          message: 'undefined: helper',
          source: 'go',
          range: expect.objectContaining({
            start: { line: 7, column: 2 },
          }),
        }),
      ]),
    )
    expect(diagnostics[0]).toMatchObject({
      file: 'main.go',
      message: 'structured issue 1',
    })
    expect(diagnostics[1]).toMatchObject({
      file: 'pkg/other.go',
      message: 'undefined: helper',
    })
  })
})

describe('LanguageDiagnosticTextEdit export surface', () => {
  test('names the applicability union from the package root barrel', () => {
    // Compile-time contract: `LanguageDiagnosticTextEditApplicability` must be
    // exported from the root barrel, not just the tools barrel, or consumers
    // cannot name the union when branching on `applicability`.
    const applicability: LanguageDiagnosticTextEditApplicability =
      'machineApplicable'
    const edit: LanguageDiagnosticTextEdit = {
      file: 'src/lib.rs',
      newText: 'u32',
      range: {
        start: { line: 1, column: 1 },
        end: { line: 1, column: 1 },
      },
      applicability,
    }

    // A missing applicability must behave like 'unspecified': the edit is not
    // machine-applicable, so consumers must not auto-apply it.
    const unspecified: LanguageDiagnosticTextEdit = { ...edit }
    delete unspecified.applicability
    const autoApplyable = unspecified.applicability === 'machineApplicable'

    expect(edit.applicability).toBe('machineApplicable')
    expect(autoApplyable).toBe(false)
  })
})

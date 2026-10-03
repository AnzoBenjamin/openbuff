import path from 'node:path'

export type LanguageDiagnosticSeverity = 'error' | 'warning' | 'info' | 'hint'

export type LanguageDiagnosticPosition = {
  /** 1-indexed line number, matching native compiler output. */
  line: number
  /** 1-indexed column number, matching native compiler output. */
  column: number
}

export type LanguageDiagnosticRange = {
  start: LanguageDiagnosticPosition
  end: LanguageDiagnosticPosition
}

export type LanguageDiagnostic = {
  file: string | null
  range: LanguageDiagnosticRange | null
  severity: LanguageDiagnosticSeverity
  code: string | null
  message: string
  command: string
  source: string
  /** Tool/compiler-suggested fix-it edits (structured parsers only). */
  fixes?: LanguageDiagnosticTextEdit[]
  /** Related locations referenced by the diagnostic (structured parsers only). */
  relatedInformation?: LanguageDiagnosticRelatedInfo[]
}

export type LanguageDiagnosticTextEditApplicability =
  | 'machineApplicable'
  | 'maybeIncorrect'
  | 'unspecified'

export type LanguageDiagnosticTextEdit = {
  /** File the edit applies to, normalized like LanguageDiagnostic.file. */
  file: string
  newText: string
  /** 1-indexed line/column range, same convention as LanguageDiagnosticRange. */
  range: LanguageDiagnosticRange
  /**
   * rustc's `suggestion_applicability` for cargo/rustc fix-its. Structured
   * parsers that carry no applicability information omit this field; consumers
   * must treat a missing applicability like 'unspecified' and must not
   * auto-apply suggestions that are not 'machineApplicable'.
   */
  applicability?: LanguageDiagnosticTextEditApplicability
}

export type LanguageDiagnosticRelatedInfo = {
  file: string | null
  range: LanguageDiagnosticRange | null
  message: string
  code?: string
}

export type DiagnosticParserInput = {
  command: string
  cwd?: string
  stdout?: string
  stderr?: string
}

export type DiagnosticParser = {
  id: string
  parse: (input: DiagnosticParserInput) => LanguageDiagnostic[]
}

const MAX_DIAGNOSTICS = 200

type LocatedDiagnostic = {
  file: string
  line: number
  column?: number
  endLine?: number
  endColumn?: number
  severity: LanguageDiagnosticSeverity
  code?: string | null
  message: string
  source: string
  fixes?: LanguageDiagnosticTextEdit[]
  relatedInformation?: LanguageDiagnosticRelatedInfo[]
}

function severity(value: string): LanguageDiagnosticSeverity {
  const normalized = value.toLowerCase()
  if (normalized.includes('warn') || normalized === 'w') return 'warning'
  if (normalized === 'info' || normalized === 'note' || normalized === 'c') {
    return 'info'
  }
  if (normalized === 'hint') return 'hint'
  return 'error'
}

function normalizeFile(file: string, cwd?: string): string {
  const withoutUri = file.replace(/^file:\/\//, '').replace(/^res:\/\//, '')
  if (!cwd || !path.isAbsolute(withoutUri)) return withoutUri
  const relative = path.relative(cwd, withoutUri)
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative)
    ? relative
    : withoutUri
}

function toDiagnostic(
  item: LocatedDiagnostic,
  input: DiagnosticParserInput,
): LanguageDiagnostic {
  const column = item.column && item.column > 0 ? item.column : 1
  const start = { line: item.line, column }
  const end =
    item.endLine === undefined
      ? start
      : {
          line: item.endLine,
          column: item.endColumn && item.endColumn > 0 ? item.endColumn : column,
        }
  return {
    file: normalizeFile(item.file, input.cwd),
    range: { start, end },
    severity: item.severity,
    code: item.code ?? null,
    message: item.message.trim(),
    command: input.command,
    source: item.source,
    ...(item.fixes && item.fixes.length > 0 ? { fixes: item.fixes } : {}),
    ...(item.relatedInformation && item.relatedInformation.length > 0
      ? { relatedInformation: item.relatedInformation }
      : {}),
  }
}

function outputLines(input: DiagnosticParserInput): string[] {
  return `${input.stdout ?? ''}\n${input.stderr ?? ''}`
    .split(/\r?\n/)
    .map((line) => line.replace(/\x1b\[[0-9;]*m/g, ''))
}

function isJsonDocument(text: string | undefined): boolean {
  if (!text || !text.trim()) return false
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}

// A stream whose whole body parses as a single JSON document is
// machine-format output (e.g. pretty-printed `go vet -json`), so the
// plain-text regex passes must not re-parse its body line by line: indented
// keys like `"posn": "main.go:10:2",` match the loose file:line regexes and
// fabricate diagnostics with garbage file paths in the persisted
// LanguageDiagnostic contract. NDJSON streams (one JSON value per line) do
// not parse as a single document and keep the per-line JSON guard inside
// commandSpecificParser.
function plainTextLines(input: DiagnosticParserInput): string[] {
  return [input.stdout, input.stderr]
    .filter((text) => !isJsonDocument(text))
    .join('\n')
    .split(/\r?\n/)
    .map((line) => line.replace(/\x1b\[[0-9;]*m/g, ''))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function parseJsonOutput(input: DiagnosticParserInput): unknown {
  for (const text of [input.stdout, input.stderr]) {
    if (!text || !text.trim()) continue
    try {
      return JSON.parse(text)
    } catch {
      // Try the next stream; the regex fallback still runs when both fail.
    }
  }
  return undefined
}

const parenthesizedParser: DiagnosticParser = {
  id: 'parenthesized-compiler',
  parse(input) {
    const diagnostics: LanguageDiagnostic[] = []
    for (const line of outputLines(input)) {
      const match = line.match(
        /^(.+?)\((\d+),(\d+)\):\s*(error|warning|info)\s+([A-Za-z]+\d+):\s*(.+?)(?:\s+\[[^\]]+\])?$/i,
      )
      if (!match) continue
      diagnostics.push(
        toDiagnostic(
          {
            file: match[1],
            line: Number(match[2]),
            column: Number(match[3]),
            severity: severity(match[4]),
            code: match[5],
            message: match[6],
            source: 'compiler',
          },
          input,
        ),
      )
    }
    return diagnostics
  },
}

const colonCompilerParser: DiagnosticParser = {
  id: 'colon-compiler',
  parse(input) {
    const diagnostics: LanguageDiagnostic[] = []
    for (const line of outputLines(input)) {
      const match = line.match(
        /^(.+?):(\d+):(\d+):\s*(fatal error|error|warning|note|info):\s*(.+?)(?:\s+\[([^\]]+)\])?$/i,
      )
      if (!match) continue
      diagnostics.push(
        toDiagnostic(
          {
            file: match[1],
            line: Number(match[2]),
            column: Number(match[3]),
            severity: severity(match[4]),
            code: match[6],
            message: match[5],
            source: 'compiler',
          },
          input,
        ),
      )
    }
    return diagnostics
  },
}

const pythonParser: DiagnosticParser = {
  id: 'python',
  parse(input) {
    const diagnostics: LanguageDiagnostic[] = []
    for (const line of outputLines(input)) {
      const match = line.match(
        /^(.+?):(\d+):(\d+)\s+-\s+(error|warning|information|hint):\s*(.+?)(?:\s+\(([^)]+)\))?$/i,
      )
      if (!match) continue
      diagnostics.push(
        toDiagnostic(
          {
            file: match[1],
            line: Number(match[2]),
            column: Number(match[3]),
            severity: severity(match[4] === 'information' ? 'info' : match[4]),
            code: match[6],
            message: match[5],
            source: 'python',
          },
          input,
        ),
      )
    }
    return diagnostics
  },
}

const lintParser: DiagnosticParser = {
  id: 'language-linters',
  parse(input) {
    const diagnostics: LanguageDiagnostic[] = []
    let eslintFile: string | undefined
    for (const line of outputLines(input)) {
      if (/^[^\s].*\.(?:[cm]?[jt]sx?)$/.test(line.trim())) {
        eslintFile = line.trim()
        continue
      }

      const eslint = line.match(
        /^\s*(\d+):(\d+)\s+(error|warning)\s+(.+?)\s+([@\w][\w/-]+)\s*$/i,
      )
      if (eslint && eslintFile) {
        diagnostics.push(
          toDiagnostic(
            {
              file: eslintFile,
              line: Number(eslint[1]),
              column: Number(eslint[2]),
              severity: severity(eslint[3]),
              code: eslint[5],
              message: eslint[4],
              source: 'eslint',
            },
            input,
          ),
        )
        continue
      }

      const ruff = line.match(
        /^(.+?):(\d+):(\d+):\s*([A-Z][A-Z0-9]*\d{2,4})\s+(.+)$/,
      )
      if (ruff) {
        diagnostics.push(
          toDiagnostic(
            {
              file: ruff[1],
              line: Number(ruff[2]),
              column: Number(ruff[3]),
              severity: 'warning',
              code: ruff[4],
              message: ruff[5],
              source: 'ruff',
            },
            input,
          ),
        )
        continue
      }

      const rubocop = line.match(
        /^(.+?):(\d+):(\d+):\s*([CWEF]):\s*(.+?)(?:\s+\[([^\]]+)\])?$/,
      )
      if (rubocop) {
        diagnostics.push(
          toDiagnostic(
            {
              file: rubocop[1],
              line: Number(rubocop[2]),
              column: Number(rubocop[3]),
              severity: severity(rubocop[4] === 'W' ? 'warning' : rubocop[4]),
              code: rubocop[6],
              message: rubocop[5],
              source: 'rubocop',
            },
            input,
          ),
        )
      }
    }
    return diagnostics
  },
}

const jvmParser: DiagnosticParser = {
  id: 'jvm',
  parse(input) {
    const diagnostics: LanguageDiagnostic[] = []
    for (const line of outputLines(input)) {
      const maven = line.match(/^\[ERROR\]\s+(.+?):\[(\d+),(\d+)\]\s+(.+)$/)
      const kotlin = line.match(/^e:\s+(?:file:\/\/)?(.+?):(\d+):(\d+)\s+(.+)$/)
      const javac = line.match(/^(.+?\.java):(\d+):\s*error:\s*(.+)$/)
      const match = maven ?? kotlin ?? javac
      if (!match) continue
      const file = match[1]
      diagnostics.push(
        toDiagnostic(
          {
            file,
            line: Number(match[2]),
            column: match === javac ? 1 : Number(match[3]),
            severity: 'error',
            message: match === javac ? match[3] : match[4],
            // The Maven and javac line formats carry no token identifying
            // the emitting tool, so a source value taken from which regex
            // happened to match would attribute e.g. a Maven-wrapped kotlinc
            // diagnostic for a .kt file to 'java'. Derive the persisted
            // source from the tool token when the line carries one
            // (kotlinc's `e:` prefix) and otherwise from the file extension,
            // the only remaining in-line evidence.
            source:
              /^e:\s/.test(line) || /\.kts?$/i.test(file)
                ? 'kotlin'
                : 'java',
          },
          input,
        ),
      )
    }
    return diagnostics
  },
}

const cargoParser: DiagnosticParser = {
  id: 'cargo',
  parse(input) {
    const lines = outputLines(input)
    const diagnostics: LanguageDiagnostic[] = []
    for (let index = 0; index < lines.length; index += 1) {
      const header = lines[index].match(
        /^(error|warning)(?:\[([^\]]+)\])?:\s*(.+)$/,
      )
      if (!header) continue
      for (
        let offset = 1;
        offset <= 4 && index + offset < lines.length;
        offset++
      ) {
        const location = lines[index + offset].match(
          /^\s*-->\s+(.+?):(\d+):(\d+)\s*$/,
        )
        if (!location) continue
        diagnostics.push(
          toDiagnostic(
            {
              file: location[1],
              line: Number(location[2]),
              column: Number(location[3]),
              severity: severity(header[1]),
              code: header[2],
              message: header[3],
              source: 'cargo',
            },
            input,
          ),
        )
        break
      }
    }
    return diagnostics
  },
}

const commandSpecificParser: DiagnosticParser = {
  id: 'command-specific',
  parse(input) {
    const diagnostics: LanguageDiagnostic[] = []
    const command = input.command.toLowerCase()
    for (const line of plainTextLines(input)) {
      // A line that is itself JSON belongs to a machine-format output stream
      // handled by the structured parsers. Without this guard the structured
      // + regex dual pass (needed so mixed machine+plain-text runs are fully
      // captured, e.g. `go vet -json`) re-parses the JSON line as plain text
      // and double-counts the diagnostic.
      if (/^\s*[{[]/.test(line)) {
        try {
          JSON.parse(line)
          continue
        } catch {
          // Not valid JSON — treat as plain text below.
        }
      }
      if (/\bphpstan\b/.test(command)) {
        const match = line.match(/^(.+?):(\d+):\s*(.+)$/)
        if (match) {
          diagnostics.push(
            toDiagnostic(
              {
                file: match[1],
                line: Number(match[2]),
                severity: 'error',
                message: match[3],
                source: 'phpstan',
              },
              input,
            ),
          )
        }
      } else if (/\b(?:go\s+(?:test|vet)|php\s+-l)\b/.test(command)) {
        const match = line.match(/^(.+?):(\d+)(?::(\d+))?:\s*(.+)$/)
        if (match) {
          diagnostics.push(
            toDiagnostic(
              {
                file: match[1],
                line: Number(match[2]),
                column: match[3] ? Number(match[3]) : 1,
                severity: 'error',
                message: match[4],
                source: command.includes('php') ? 'php' : 'go',
              },
              input,
            ),
          )
        }
      }
    }
    return diagnostics
  },
}

const godotParser: DiagnosticParser = {
  id: 'godot',
  parse(input) {
    if (!/\bgodot\b/i.test(input.command)) return []
    const lines = outputLines(input)
    const diagnostics: LanguageDiagnostic[] = []
    for (let index = 0; index < lines.length; index += 1) {
      const header = lines[index].match(
        /^(?:SCRIPT ERROR:\s*)?(Parse Error|Error|Warning):\s*(.+)$/i,
      )
      if (!header) continue
      const nearby = lines.slice(index, index + 3).join(' ')
      const location = nearby.match(/(?:res:\/\/)?([^\s()]+\.gd):(\d+)/)
      if (!location) continue
      diagnostics.push(
        toDiagnostic(
          {
            file: location[1],
            line: Number(location[2]),
            severity: severity(header[1]),
            message: header[2],
            source: 'godot',
          },
          input,
        ),
      )
    }
    return diagnostics
  },
}

// --- Structured (machine-format) parsers -----------------------------------
// These parsers are tried BEFORE the regex parsers below. Each one is gated
// on (a) the command string matching its tool and (b) the output actually
// parsing as JSON with the expected shape; on any mismatch they return [] and
// the regex fallback parsers still run.

function recordAt(
  value: unknown,
  key: string,
): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined
  const nested = value[key]
  return isRecord(nested) ? nested : undefined
}

function stringAt(value: Record<string, unknown>, key: string): string | undefined {
  const item = value[key]
  return typeof item === 'string' ? item : undefined
}

function numberAt(value: Record<string, unknown>, key: string): number | undefined {
  return asNumber(value[key])
}

function arrayAt(value: unknown, key: string): unknown[] | undefined {
  if (!isRecord(value)) return undefined
  const item = value[key]
  return Array.isArray(item) ? item : undefined
}

function offsetToPosition(
  source: string,
  offset: number,
): LanguageDiagnosticPosition | undefined {
  if (!Number.isInteger(offset) || offset < 0 || offset > source.length) {
    return undefined
  }
  let line = 1
  let lineStart = 0
  for (let index = 0; index < offset; index += 1) {
    if (source.charCodeAt(index) === 10 /* \n */) {
      line += 1
      lineStart = index + 1
    }
  }
  return { line, column: offset - lineStart + 1 }
}

function dedupeTextEdits(
  edits: LanguageDiagnosticTextEdit[],
): LanguageDiagnosticTextEdit[] {
  const seen = new Set<string>()
  const unique: LanguageDiagnosticTextEdit[] = []
  for (const edit of edits) {
    const key = JSON.stringify(edit)
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(edit)
  }
  return unique
}

// rustc grades every suggestion with `suggestion_applicability`; surface it
// so consumers can distinguish machine-applicable fix-its from speculative
// ones before applying them automatically.
function cargoApplicability(
  value: string | undefined,
): LanguageDiagnosticTextEditApplicability {
  switch (value) {
    case 'MachineApplicable':
    case 'MachineApplicableOnly':
      return 'machineApplicable'
    case 'MaybeIncorrect':
    case 'HasPlaceholders':
      return 'maybeIncorrect'
    default:
      return 'unspecified'
  }
}

const cargoJsonParser: DiagnosticParser = {
  id: 'cargo-json',
  parse(input) {
    if (!/\b(?:cargo|rustc)\b/i.test(input.command)) return []
    const lines = outputLines(input)
    const diagnostics: LanguageDiagnostic[] = []
    for (const line of lines) {
      if (!line.trim().startsWith('{')) continue
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        continue
      }
      if (!isRecord(parsed) || parsed.reason !== 'compiler-message') continue
      const message = recordAt(parsed, 'message')
      if (!message) continue
      const spans = arrayAt(message, 'spans') ?? []
      const primarySpan =
        spans.find((span) => isRecord(span) && span.is_primary === true) ??
        spans.find(
          (span) =>
            isRecord(span) && stringAt(span, 'file_name') !== undefined,
        )
      if (!isRecord(primarySpan)) continue
      const file = stringAt(primarySpan, 'file_name')
      const lineStart = numberAt(primarySpan, 'line_start')
      const columnStart = numberAt(primarySpan, 'column_start')
      if (!file || lineStart === undefined || columnStart === undefined) {
        continue
      }

      // rustc attaches suggested fix-its to spans via `suggested_replacement`
      // and grades them with `suggestion_applicability`; collect them from the
      // message spans and from any child spans (notes/suggestions under the
      // primary diagnostic).
      const fixes: LanguageDiagnosticTextEdit[] = []
      const spanFix = (span: Record<string, unknown>) => {
        const replacement = stringAt(span, 'suggested_replacement')
        if (replacement === undefined) return
        const applicability = cargoApplicability(
          stringAt(span, 'suggestion_applicability'),
        )
        const fixFile = stringAt(span, 'file_name') ?? file
        const fixLineStart = numberAt(span, 'line_start')
        if (fixLineStart === undefined) return
        const fixLineEnd = numberAt(span, 'line_end') ?? fixLineStart
        const fixColumnStart = numberAt(span, 'column_start') ?? 1
        const fixColumnEnd = numberAt(span, 'column_end') ?? fixColumnStart
        fixes.push({
          file: normalizeFile(fixFile, input.cwd),
          newText: replacement,
          range: {
            start: { line: fixLineStart, column: fixColumnStart },
            end: { line: fixLineEnd, column: fixColumnEnd },
          },
          applicability,
        })
      }
      for (const span of spans) {
        if (isRecord(span)) spanFix(span)
      }
      for (const child of arrayAt(message, 'children') ?? []) {
        if (!isRecord(child)) continue
        for (const span of arrayAt(child, 'spans') ?? []) {
          if (isRecord(span)) spanFix(span)
        }
      }

      const codeRecord = recordAt(message, 'code')
      diagnostics.push(
        toDiagnostic(
          {
            file,
            line: lineStart,
            column: columnStart,
            endLine: numberAt(primarySpan, 'line_end') ?? lineStart,
            endColumn: numberAt(primarySpan, 'column_end') ?? columnStart,
            severity: severity(stringAt(message, 'level') ?? 'error'),
            code: codeRecord ? stringAt(codeRecord, 'code') ?? null : null,
            message: stringAt(message, 'message') ?? '',
            source: 'cargo',
            fixes: dedupeTextEdits(fixes),
          },
          input,
        ),
      )
    }
    return diagnostics
  },
}

const ruffJsonParser: DiagnosticParser = {
  id: 'ruff-json',
  parse(input) {
    if (!/\bruff\b/i.test(input.command)) return []
    const parsed = parseJsonOutput(input)
    if (!Array.isArray(parsed)) return []
    const diagnostics: LanguageDiagnostic[] = []
    for (const item of parsed) {
      if (!isRecord(item)) continue
      const filename = stringAt(item, 'filename')
      const message = stringAt(item, 'message')
      const location = recordAt(item, 'location')
      if (!filename || !message || !location) continue
      const line = numberAt(location, 'row')
      const column = numberAt(location, 'column')
      if (line === undefined || column === undefined) continue
      const endLocation = recordAt(item, 'end_location')
      const endLine = endLocation ? numberAt(endLocation, 'row') : undefined
      const endColumn = endLocation
        ? numberAt(endLocation, 'column')
        : undefined

      const fixes: LanguageDiagnosticTextEdit[] = []
      const fix = recordAt(item, 'fix')
      for (const edit of fix ? (arrayAt(fix, 'edits') ?? []) : []) {
        if (!isRecord(edit)) continue
        const content = stringAt(edit, 'content')
        const editStart = recordAt(edit, 'location')
        if (content === undefined || !editStart) continue
        const editLine = numberAt(editStart, 'row')
        const editColumn = numberAt(editStart, 'column')
        if (editLine === undefined || editColumn === undefined) continue
        const editEnd = recordAt(edit, 'end_location')
        fixes.push({
          file: normalizeFile(filename, input.cwd),
          newText: content,
          range: {
            start: { line: editLine, column: editColumn },
            end: {
              line: (editEnd ? numberAt(editEnd, 'row') : undefined) ?? editLine,
              column:
                (editEnd ? numberAt(editEnd, 'column') : undefined) ??
                editColumn,
            },
          },
        })
      }

      diagnostics.push(
        toDiagnostic(
          {
            file: filename,
            line,
            column,
            endLine,
            endColumn,
            // Severity tokens must be matched case-insensitively so a ruff
            // build serializing 'ERROR' is not downgraded to 'warning' in
            // the persisted LanguageDiagnostic contract.
            severity:
              stringAt(item, 'severity')?.toLowerCase() === 'error'
                ? 'error'
                : 'warning',
            code: stringAt(item, 'code'),
            message,
            source: 'ruff',
            fixes: dedupeTextEdits(fixes),
          },
          input,
        ),
      )
    }
    return diagnostics
  },
}

const pyrightJsonParser: DiagnosticParser = {
  id: 'pyright-json',
  parse(input) {
    if (!/\bpyright\b/i.test(input.command)) return []
    const parsed = parseJsonOutput(input)
    if (!isRecord(parsed)) return []
    const entries = arrayAt(parsed, 'diagnostics')
    if (!entries) return []
    const diagnostics: LanguageDiagnostic[] = []
    for (const item of entries) {
      if (!isRecord(item)) continue
      const file = stringAt(item, 'file')
      const message = stringAt(item, 'message')
      const range = recordAt(item, 'range')
      if (!file || !message || !range) continue
      const start = recordAt(range, 'start')
      const end = recordAt(range, 'end')
      // `pyright --outputjson` emits LSP-style positions: 0-based `line` and
      // `character` keys. It never emits a `column` key, so reading one would
      // silently drop every real diagnostic.
      const line = start ? numberAt(start, 'line') : undefined
      const character = start ? numberAt(start, 'character') : undefined
      if (line === undefined || character === undefined) continue
      diagnostics.push(
        toDiagnostic(
          {
            file,
            line: line + 1,
            column: character + 1,
            endLine: ((end ? numberAt(end, 'line') : undefined) ?? line) + 1,
            endColumn:
              ((end ? numberAt(end, 'character') : undefined) ?? character) +
              1,
            severity: severity(
              stringAt(item, 'severity') === 'information'
                ? 'info'
                : stringAt(item, 'severity') ?? 'error',
            ),
            code: stringAt(item, 'rule'),
            message,
            source: 'pyright',
          },
          input,
        ),
      )
    }
    return diagnostics
  },
}

const eslintJsonParser: DiagnosticParser = {
  id: 'eslint-json',
  parse(input) {
    if (!/\beslint\b/i.test(input.command)) return []
    const parsed = parseJsonOutput(input)
    if (!Array.isArray(parsed)) return []
    const diagnostics: LanguageDiagnostic[] = []
    for (const fileResult of parsed) {
      if (!isRecord(fileResult)) continue
      const filePath = stringAt(fileResult, 'filePath')
      const messages = arrayAt(fileResult, 'messages')
      if (!filePath || !messages) continue
      for (const message of messages) {
        if (!isRecord(message)) continue
        const text = stringAt(message, 'message')
        const line = numberAt(message, 'line')
        const column = numberAt(message, 'column')
        if (!text || line === undefined || column === undefined) continue
        const endLine = numberAt(message, 'endLine')
        const endColumn = numberAt(message, 'endColumn')
        // eslint's fix.range holds [startOffset, endOffset] character offsets
        // into the file. When eslint includes the file's original source in
        // the same JSON payload (`source` on the file result), those offsets
        // map to exact 1-indexed line/column positions. Without the source
        // text the offsets cannot be mapped, so no fix edit is emitted;
        // substituting the message's line/column range would splice fix text
        // into the wrong span.
        const fixes: LanguageDiagnosticTextEdit[] = []
        const fix = recordAt(message, 'fix')
        const fixRange = fix ? arrayAt(fix, 'range') : undefined
        const fixText = fix ? stringAt(fix, 'text') : undefined
        const sourceText = stringAt(fileResult, 'source')
        if (sourceText && fixRange && fixText !== undefined) {
          const startOffset = asNumber(fixRange[0])
          const endOffset = asNumber(fixRange[1])
          const start =
            startOffset !== undefined &&
            endOffset !== undefined &&
            endOffset >= startOffset
              ? offsetToPosition(sourceText, startOffset)
              : undefined
          const end =
            start && endOffset !== undefined
              ? offsetToPosition(sourceText, endOffset)
              : undefined
          if (start && end) {
            fixes.push({
              file: normalizeFile(filePath, input.cwd),
              newText: fixText,
              range: { start, end },
            })
          }
        }
        diagnostics.push(
          toDiagnostic(
            {
              file: filePath,
              line,
              column,
              endLine,
              endColumn,
              severity: numberAt(message, 'severity') === 2 ? 'error' : 'warning',
              code: stringAt(message, 'ruleId'),
              message: text,
              source: 'eslint',
              fixes: dedupeTextEdits(fixes),
            },
            input,
          ),
        )
      }
    }
    return diagnostics
  },
}

function walkForPosnEntries(
  value: unknown,
  depth: number,
  out: Record<string, unknown>[],
): void {
  if (depth > 4) return
  if (Array.isArray(value)) {
    for (const item of value) walkForPosnEntries(item, depth + 1, out)
    return
  }
  if (!isRecord(value)) return
  if (typeof value.posn === 'string' && typeof value.msg === 'string') {
    out.push(value)
    return
  }
  for (const item of Object.values(value)) {
    walkForPosnEntries(item, depth + 1, out)
  }
}

const golangciJsonParser: DiagnosticParser = {
  id: 'golangci-json',
  parse(input) {
    const command = input.command.toLowerCase()
    const isGolangciLint = /\bgolangci-lint\b/.test(command)
    const isGoVet = /\bgo\b/.test(command) && /\bvet\b/.test(command)
    if (!isGolangciLint && !isGoVet) return []
    const parsed = parseJsonOutput(input)
    if (!isRecord(parsed)) return []
    const diagnostics: LanguageDiagnostic[] = []
    if (isGolangciLint) {
      const issues = arrayAt(parsed, 'Issues')
      if (!issues) return []
      for (const issue of issues) {
        if (!isRecord(issue)) continue
        const pos = recordAt(issue, 'Pos')
        const text = stringAt(issue, 'Text')
        if (!pos || !text) continue
        const filename = stringAt(pos, 'Filename')
        const line = numberAt(pos, 'Line')
        if (!filename || line === undefined) continue
        diagnostics.push(
          toDiagnostic(
            {
              file: filename,
              line,
              column: numberAt(pos, 'Column') ?? 1,
              severity: 'error',
              code: stringAt(issue, 'FromLinter'),
              message: text,
              source: 'golangci-lint',
            },
            input,
          ),
        )
      }
      return diagnostics
    }

    // go vet -json: either { package: { tool, pois: [{ posn, msg }] } } (go
    // vet <= 1.24) or the newer { packages: {...} } layout. Walk defensively.
    const issues: Record<string, unknown>[] = []
    walkForPosnEntries(parsed, 0, issues)
    for (const issue of issues) {
      const posn = stringAt(issue, 'posn')
      const message = stringAt(issue, 'msg')
      if (!posn || !message) continue
      const match = posn.match(/^(.+?):(\d+)(?::(\d+))?$/)
      if (!match) continue
      diagnostics.push(
        toDiagnostic(
          {
            file: match[1],
            line: Number(match[2]),
            column: match[3] ? Number(match[3]) : 1,
            severity: 'error',
            message,
            source: 'go vet',
          },
          input,
        ),
      )
    }
    return diagnostics
  },
}

function sarifRegionToRange(
  region: Record<string, unknown>,
): LanguageDiagnosticRange {
  const line = numberAt(region, 'startLine') ?? 1
  const column = numberAt(region, 'startColumn') ?? 1
  return {
    start: { line, column },
    end: {
      line: numberAt(region, 'endLine') ?? line,
      column: numberAt(region, 'endColumn') ?? column,
    },
  }
}

function sarifArtifactUri(
  physicalLocation: Record<string, unknown>,
): string | undefined {
  const artifactLocation = recordAt(physicalLocation, 'artifactLocation')
  return artifactLocation ? stringAt(artifactLocation, 'uri') : undefined
}

function sarifBaseUri(
  run: Record<string, unknown>,
  key: string,
): string | undefined {
  const bases = recordAt(run, 'originalUriBaseIds')
  const entry = bases ? recordAt(bases, key) : undefined
  return entry ? stringAt(entry, 'uri') : undefined
}

function joinUriBase(base: string, uri: string): string {
  const relative = uri.replace(/^\//, '')
  return base.endsWith('/') ? `${base}${relative}` : `${base}/${relative}`
}

/**
 * Percent-decodes a SARIF artifactLocation.uri per RFC 3986 so encoded path
 * segments (spaces, non-ASCII characters) resolve to the workspace paths they
 * denote. Malformed escape sequences are left as-is rather than throwing.
 */
function decodeUriPath(uri: string): string {
  try {
    return decodeURIComponent(uri)
  } catch {
    return uri
  }
}

/**
 * Resolves an artifactLocation.uri against the run's originalUriBaseIds: an
 * explicit uriBaseId maps to its declared base, and `%KEY%/path` placeholders
 * resolve (or are stripped) so the resulting path can be matched to workspace
 * files instead of persisting the raw placeholder verbatim. The result is
 * percent-decoded so RFC 3986-encoded path segments match real file paths.
 */
function sarifResolvedArtifactUri(
  run: Record<string, unknown>,
  artifactLocation: Record<string, unknown>,
): string | undefined {
  const uri = stringAt(artifactLocation, 'uri')
  if (!uri) return undefined
  const uriBaseId = stringAt(artifactLocation, 'uriBaseId')
  if (uriBaseId) {
    const base = sarifBaseUri(run, uriBaseId)
    if (base) return decodeUriPath(joinUriBase(base, uri))
  }
  const placeholder = uri.match(/^%([^%/]+)%(\/.*)$/)
  if (placeholder) {
    const base = sarifBaseUri(run, placeholder[1])
    if (base) return decodeUriPath(joinUriBase(base, placeholder[2]))
    return decodeUriPath(placeholder[2].replace(/^\//, ''))
  }
  return decodeUriPath(uri)
}

const sarifParser: DiagnosticParser = {
  id: 'sarif',
  parse(input) {
    const command = input.command.toLowerCase()
    // clang emits SARIF 2.1 diagnostics — including fix-it hints as `fixes`
    // — under -fdiagnostics-format=sarif, which the sarif term below matches,
    // so clang diagnostics reuse the same contract as MSBuild /errorlog SARIF
    // output. clang without the SARIF format flag falls through so its
    // plain-text output stays with the regex parsers.
    if (
      !/sarif/.test(command) &&
      !/\berrorlog\b/.test(command) &&
      !/\bsemgrep\b/.test(command)
    ) {
      return []
    }
    // The parser stays pure: it reads only the captured stdout/stderr
    // streams, never the filesystem.
    const parsed = parseJsonOutput(input)
    if (!isRecord(parsed) || parsed.version !== '2.1.0') return []
    const runs = arrayAt(parsed, 'runs')
    if (!runs) return []
    const diagnostics: LanguageDiagnostic[] = []
    for (const run of runs) {
      if (!isRecord(run)) continue
      for (const result of arrayAt(run, 'results') ?? []) {
        if (!isRecord(result)) continue
        const messageRecord = recordAt(result, 'message')
        const messageText = messageRecord
          ? stringAt(messageRecord, 'text')
          : undefined
        if (!messageRecord || messageText === undefined) continue
        const primaryLocation = (arrayAt(result, 'locations') ?? []).find(
          (location) =>
            isRecord(location) &&
            isRecord(location.physicalLocation) &&
            sarifArtifactUri(location.physicalLocation) !== undefined,
        )
        if (!isRecord(primaryLocation)) continue
        const physicalLocation = recordAt(primaryLocation, 'physicalLocation')
        if (!physicalLocation) continue
        const artifactLocation = recordAt(physicalLocation, 'artifactLocation')
        const uri = artifactLocation
          ? sarifResolvedArtifactUri(run, artifactLocation)
          : undefined
        if (!uri) continue
        const region = recordAt(physicalLocation, 'region')

        const fixes: LanguageDiagnosticTextEdit[] = []
        for (const fix of arrayAt(result, 'fixes') ?? []) {
          if (!isRecord(fix)) continue
          for (const artifactChange of arrayAt(fix, 'artifactChanges') ?? []) {
            if (!isRecord(artifactChange)) continue
            const artifactLocation = recordAt(
              artifactChange,
              'artifactLocation',
            )
            const fixUri = artifactLocation
              ? sarifResolvedArtifactUri(run, artifactLocation)
              : undefined
            if (!fixUri) continue
            for (const replacement of arrayAt(
              artifactChange,
              'replacements',
            ) ?? []) {
              if (!isRecord(replacement)) continue
              const deletedRegion = recordAt(replacement, 'deletedRegion')
              if (!deletedRegion) continue
              const insertedContent = recordAt(
                replacement,
                'insertedContent',
              )
              fixes.push({
                file: normalizeFile(fixUri, input.cwd),
                newText: insertedContent
                  ? stringAt(insertedContent, 'text') ?? ''
                  : '',
                range: sarifRegionToRange(deletedRegion),
              })
            }
          }
        }

        const relatedInformation: LanguageDiagnosticRelatedInfo[] = []
        for (const related of arrayAt(result, 'relatedLocations') ?? []) {
          if (!isRecord(related)) continue
          const relatedPhysical = recordAt(related, 'physicalLocation')
          const relatedMessage = recordAt(related, 'message')
          let relatedFile: string | null = null
          let relatedRange: LanguageDiagnosticRange | null = null
          if (relatedPhysical) {
            const relatedArtifact = recordAt(
              relatedPhysical,
              'artifactLocation',
            )
            const relatedUri = relatedArtifact
              ? sarifResolvedArtifactUri(run, relatedArtifact)
              : undefined
            if (relatedUri) relatedFile = normalizeFile(relatedUri, input.cwd)
            const relatedRegion = recordAt(relatedPhysical, 'region')
            if (relatedRegion) relatedRange = sarifRegionToRange(relatedRegion)
          }
          relatedInformation.push({
            file: relatedFile,
            range: relatedRange,
            message: relatedMessage
              ? stringAt(relatedMessage, 'text') ?? ''
              : '',
          })
        }

        const level = stringAt(result, 'level')
        const resultRange = region ? sarifRegionToRange(region) : undefined
        diagnostics.push(
          toDiagnostic(
            {
              file: uri,
              line: resultRange?.start.line ?? 1,
              column: resultRange?.start.column ?? 1,
              endLine: resultRange?.end.line,
              endColumn: resultRange?.end.column,
              // Route the SARIF result level through the same severity()
              // normalization the plain-text parsers use: SARIF 'note' maps
              // to 'info' exactly like a plain-text 'note', while any other
              // token ('none', future/extension levels) is not silently
              // downgraded to 'info' and takes the shared severity() default.
              // A result with no level keeps the persisted 'info' default.
              severity: severity(level ?? 'info'),
              code: stringAt(result, 'ruleId'),
              message: messageText,
              source: 'sarif',
              fixes: dedupeTextEdits(fixes),
              relatedInformation,
            },
            input,
          ),
        )
      }
    }
    return diagnostics
  },
}

export const structuredDiagnosticParsers: readonly DiagnosticParser[] = [
  cargoJsonParser,
  ruffJsonParser,
  pyrightJsonParser,
  eslintJsonParser,
  golangciJsonParser,
  sarifParser,
]

export const diagnosticParsers: readonly DiagnosticParser[] = [
  parenthesizedParser,
  colonCompilerParser,
  pythonParser,
  lintParser,
  jvmParser,
  cargoParser,
  commandSpecificParser,
  godotParser,
]

function diagnosticKey(diagnostic: LanguageDiagnostic): string {
  return JSON.stringify([
    diagnostic.file,
    diagnostic.range,
    diagnostic.severity,
    diagnostic.code,
    diagnostic.message,
    diagnostic.fixes ?? [],
    diagnostic.relatedInformation ?? [],
  ])
}

// The structured and plain-text passes share the MAX_DIAGNOSTICS budget, so
// their results are interleaved round-robin instead of appending the
// plain-text pass after the structured one: a run with more structured
// diagnostics than the cap must not starve the plain-text pass entirely.
function interleaveDiagnostics(
  structured: readonly LanguageDiagnostic[],
  plainText: readonly LanguageDiagnostic[],
): LanguageDiagnostic[] {
  const combined: LanguageDiagnostic[] = []
  const longest = Math.max(structured.length, plainText.length)
  for (let index = 0; index < longest; index += 1) {
    if (index < structured.length) combined.push(structured[index])
    if (index < plainText.length) combined.push(plainText[index])
  }
  return combined
}

export function parseLanguageDiagnostics(
  input: DiagnosticParserInput,
  parsers?: readonly DiagnosticParser[],
): LanguageDiagnostic[] {
  let diagnostics: LanguageDiagnostic[]
  if (parsers) {
    // An explicitly supplied parser list is authoritative: run exactly those
    // parsers instead of forcing the structured parsers ahead of them.
    diagnostics = parsers.flatMap((parser) => parser.parse(input))
  } else {
    // Structured (JSON/SARIF) parsers run first, and the regex parsers run
    // too: a single tool run can mix machine-format and plain-text output
    // (e.g. `go vet -json` emits analysis diagnostics as JSON on stdout while
    // build/type errors for failing packages stay plain text on stderr), so
    // neither format may suppress the other. The dedupe pass below collapses
    // any diagnostics captured identically by both formats.
    const structured = structuredDiagnosticParsers.flatMap((parser) =>
      parser.parse(input),
    )
    // Structured results win dedupe (they carry fixes and related
    // information), so the plain-text pass is filtered against the structured
    // keys before the two passes are interleaved round-robin under the shared
    // MAX_DIAGNOSTICS cap: a strictly structured-first ordering would let a
    // run with more structured diagnostics than the cap consume the whole
    // budget and silently drop every plain-text diagnostic (including
    // build/type errors on stderr).
    const structuredKeys = new Set(structured.map(diagnosticKey))
    const plainText = diagnosticParsers
      .flatMap((parser) => parser.parse(input))
      .filter((diagnostic) => !structuredKeys.has(diagnosticKey(diagnostic)))
    diagnostics = interleaveDiagnostics(structured, plainText)
  }
  const seen = new Set<string>()
  const unique: LanguageDiagnostic[] = []
  for (const diagnostic of diagnostics) {
    const key = diagnosticKey(diagnostic)
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(diagnostic)
    if (unique.length >= MAX_DIAGNOSTICS) break
  }
  return unique
}

import { getLanguageConfig } from './languages'

import type { Node } from 'web-tree-sitter'

/**
 * A single structural definition (function, class, method, type, …) extracted
 * from a source file, with its 1-indexed inclusive line span.
 *
 * Produced by walking the tree-sitter AST (not regex), so it is accurate across
 * every language code-map has a grammar for. `depth` is the nesting level by
 * range containment (0 = top level, 1 = e.g. a method inside a class).
 */
export interface SymbolRange {
  name: string
  kind: string
  startLine: number
  endLine: number
  depth: number
  /** 1-indexed columns (tree-sitter col + 1). */
  startCol?: number
  endCol?: number
  /** Byte offsets into the source (tree-sitter startIndex/endIndex). */
  startByte?: number
  endByte?: number
  /** True when declared under an export statement or with an export/pub modifier. */
  exported?: boolean
  /** Language family tag for the file (e.g. `typescript`, `python`). */
  language?: string
  /** Full multi-line header/declarator span text (untruncated). */
  signatureText?: string
  signatureStartLine?: number
  signatureEndLine?: number
  /** Normalized preceding doc-comment text ('' when absent). */
  docText?: string
  docStartLine?: number
  docEndLine?: number
  typeInfo?: SymbolTypeInfo
  modifiers?: SymbolModifiers
}

export interface SymbolParam {
  name: string
  type?: string
}

export interface SymbolTypeInfo {
  params?: SymbolParam[]
  returnType?: string
  detail?: string
}

export interface SymbolModifiers {
  visibility?: string
  exported?: boolean
  static?: boolean
  async?: boolean
}

export interface StructureDiagnostic {
  filePath: string
  stage: 'language' | 'parse'
  message: string
}

/**
 * AST node types that introduce a named definition, mapped to a normalized
 * `kind`. Reference/usage captures (calls, type uses) are intentionally absent
 * so they never show up as definitions. Shared types (e.g. `function_definition`
 * in both Python and C/C++) map to the same kind. Keep keys unique.
 */
const DEFINITION_NODE_KINDS: Record<string, string> = {
  // JavaScript / TypeScript
  function_declaration: 'function',
  generator_function_declaration: 'function',
  function_signature: 'function',
  method_definition: 'method',
  method_signature: 'method',
  abstract_method_signature: 'method',
  class_declaration: 'class',
  object_declaration: 'class',
  abstract_class_declaration: 'class',
  interface_declaration: 'interface',
  protocol_declaration: 'interface',
  type_alias_declaration: 'type',
  enum_declaration: 'enum',
  // Python (function_definition/class_definition)
  function_definition: 'function',
  class_definition: 'class',
  // Java / C#
  method_declaration: 'method',
  constructor_declaration: 'method',
  record_declaration: 'class',
  struct_declaration: 'struct',
  namespace_declaration: 'module',
  // C / C++
  struct_specifier: 'struct',
  class_specifier: 'class',
  union_specifier: 'union',
  enum_specifier: 'enum',
  type_definition: 'type',
  // Rust
  function_item: 'function',
  struct_item: 'struct',
  enum_item: 'enum',
  union_item: 'union',
  type_item: 'type',
  trait_item: 'trait',
  mod_item: 'module',
  const_item: 'constant',
  static_item: 'variable',
  macro_definition: 'macro',
  impl_item: 'impl',
  // Ruby
  method: 'method',
  singleton_method: 'method',
  class: 'class',
  module: 'module',
  // GDScript (Godot)
  class_name_statement: 'class',
  variable_statement: 'variable',
  const_statement: 'constant',
  signal_statement: 'signal',
  enum_definition: 'enum',
  // Go
  type_spec: 'type',
}

const IDENTIFIER_NODE_TYPES = new Set([
  'identifier',
  'simple_identifier',
  'type_identifier',
  'field_identifier',
  'property_identifier',
  'constant',
])

function firstLine(text: string): string {
  const line = text.split(/\r?\n/, 1)[0] ?? text
  return line.trim()
}

/** Last segment of a scoped/qualified name (e.g. `foo::bar::Baz` -> `Baz`). */
function lastSegment(text: string): string {
  const cleaned = firstLine(text)
  const parts = cleaned.split(/::|\./).filter(Boolean)
  return parts.length ? parts[parts.length - 1] : cleaned
}

/** Shallow search for the first identifier-like descendant of a node. */
function findIdentifier(node: Node, maxDepth = 3): Node | null {
  const stack: Array<{ node: Node; depth: number }> = [{ node, depth: 0 }]
  while (stack.length > 0) {
    const { node: current, depth } = stack.shift()!
    if (IDENTIFIER_NODE_TYPES.has(current.type)) return current
    if (depth >= maxDepth) continue
    for (const child of current.namedChildren) {
      if (child) stack.push({ node: child, depth: depth + 1 })
    }
  }
  return null
}

/**
 * Resolve the declared name of a definition node across grammars:
 * 1. the explicit `name` field (most languages),
 * 2. the `declarator` field, drilling through nested declarators (C/C++),
 * 3. the `type` field (Rust `impl` blocks have no name),
 * 4. the first identifier-like descendant as a last resort.
 */
function extractDefName(node: Node): string | null {
  // Rust impl blocks have no name of their own; label them by the type they
  // implement (and trait, if any) so they read naturally in an outline and do
  // not collide with the struct/enum of the same name.
  if (node.type === 'impl_item') {
    const typeField = safeField(node, 'type')
    const typeName = typeField ? lastSegment(typeField.text) : ''
    if (!typeName) return null
    const traitField = safeField(node, 'trait')
    return traitField
      ? `impl ${lastSegment(traitField.text)} for ${typeName}`
      : `impl ${typeName}`
  }

  const nameField = safeField(node, 'name')
  if (nameField) return lastSegment(nameField.text)

  let declarator = safeField(node, 'declarator')
  for (let i = 0; declarator && i < 4; i++) {
    if (IDENTIFIER_NODE_TYPES.has(declarator.type)) {
      return lastSegment(declarator.text)
    }
    const nested = safeField(declarator, 'declarator')
    if (!nested) break
    declarator = nested
  }
  if (declarator) {
    const id = findIdentifier(declarator)
    if (id) return lastSegment(id.text)
  }

  const typeField = safeField(node, 'type')
  if (typeField) return lastSegment(typeField.text)

  const id = findIdentifier(node)
  return id ? lastSegment(id.text) : null
}

function definitionKind(node: Node): string | undefined {
  const base = DEFINITION_NODE_KINDS[node.type]
  if (node.type !== 'class_declaration') return base
  // Swift and Kotlin share class_declaration across class/struct/enum and
  // class/interface respectively. Preserve the language-level kind by reading
  // the declaration keyword child instead of flattening every type to class.
  const keywordKinds: Record<string, string> = {
    class: 'class',
    struct: 'struct',
    enum: 'enum',
    interface: 'interface',
  }
  for (const child of node.children) {
    if (!child) continue
    const kind = keywordKinds[child.type]
    if (kind) return kind
  }
  return base
}

// Definition kinds that turn a contained free function into a "method".
const METHOD_CONTAINER_KINDS = new Set([
  'class',
  'struct',
  'interface',
  'trait',
  'impl',
])

const FUNCTION_VALUE_TYPES = new Set([
  'arrow_function',
  'function',
  'function_expression',
  'generator_function',
  'generator_function_expression',
])
const CLASS_VALUE_TYPES = new Set(['class', 'class_expression'])

/**
 * Is this variable_declarator declared at module top level (so it is a real
 * module member worth outlining), rather than a local inside a function/block?
 * Accepts `const x = …` and `export const x = …` at the program root.
 */
function isTopLevelDeclarator(node: Node): boolean {
  const declaration = node.parent // lexical_declaration | variable_declaration
  if (!declaration) return false
  const container = declaration.parent
  if (!container) return false
  if (container.type === 'program') return true
  if (container.type === 'export_statement') {
    return container.parent?.type === 'program'
  }
  return false
}

/**
 * Classify a JS/TS `variable_declarator`. Function/arrow/class initializers are
 * real definitions the tag grammar's declaration patterns miss (e.g. the very
 * common `export const f = () => {}` and non-exported module helpers). Plain
 * value consts are surfaced only at top level (module constants/config), not
 * for every local.
 */
function variableDeclaratorKind(node: Node): string | null {
  const value = safeField(node, 'value')
  if (!value) return null
  if (!isTopLevelDeclarator(node)) return null
  if (FUNCTION_VALUE_TYPES.has(value.type)) return 'function'
  if (CLASS_VALUE_TYPES.has(value.type)) return 'class'
  return 'variable'
}

function safeField(node: Node, name: string): Node | null {
  try {
    if (typeof node.childForFieldName !== 'function') return null
    return node.childForFieldName(name) ?? null
  } catch {
    return null
  }
}

function nodeStartIndex(node: Node): number | undefined {
  const v = (node as unknown as Record<string, unknown>)['startIndex']
  return typeof v === 'number' ? v : undefined
}

function nodeEndIndex(node: Node): number | undefined {
  const v = (node as unknown as Record<string, unknown>)['endIndex']
  return typeof v === 'number' ? v : undefined
}

export function getLanguageTag(filePath: string): string {
  const dot = filePath.lastIndexOf('.')
  const ext = dot >= 0 ? filePath.slice(dot).toLowerCase() : ''
  if (['.ts', '.tsx', '.mts', '.cts'].includes(ext)) return 'typescript'
  if (['.js', '.jsx', '.mjs', '.cjs'].includes(ext)) return 'javascript'
  if (['.c', '.h'].includes(ext)) return 'c'
  if (['.cc', '.cpp', '.cxx', '.hpp', '.hh', '.hxx'].includes(ext)) return 'cpp'
  if (['.kt', '.kts'].includes(ext)) return 'kotlin'
  if (['.py', '.pyi'].includes(ext)) return 'python'
  if (['.rs'].includes(ext)) return 'rust'
  if (['.go'].includes(ext)) return 'go'
  if (['.java'].includes(ext)) return 'java'
  if (['.cs'].includes(ext)) return 'csharp'
  if (['.rb'].includes(ext)) return 'ruby'
  if (['.php'].includes(ext)) return 'php'
  if (['.swift'].includes(ext)) return 'swift'
  if (['.gd'].includes(ext)) return 'gdscript'
  return ext ? ext.slice(1) : 'unknown'
}

/** Strict range containment shared by depths and qualified names. */
export function isStrictContainer(
  parent: Pick<SymbolRange, 'startLine' | 'endLine'>,
  child: Pick<SymbolRange, 'startLine' | 'endLine'>,
): boolean {
  if (parent === child) return false
  return (
    parent.startLine <= child.startLine &&
    parent.endLine >= child.endLine &&
    (parent.startLine < child.startLine || parent.endLine > child.endLine)
  )
}

export function findContainers(
  symbols: SymbolRange[],
  sym: SymbolRange,
): SymbolRange[] {
  return symbols
    .filter((other) => other !== sym && isStrictContainer(other, sym))
    .sort(
      (a, b) =>
        a.depth - b.depth || b.endLine - b.startLine - (a.endLine - a.startLine),
    )
}

export function buildQualifiedName(
  symbols: SymbolRange[],
  sym: SymbolRange,
): string {
  const containers = findContainers(symbols, sym)
  return [...containers.map((c) => c.name), sym.name].join('/')
}

function assignDepths(symbols: SymbolRange[]): SymbolRange[] {
  const sorted = [...symbols].sort(
    (a, b) => a.startLine - b.startLine || b.endLine - a.endLine,
  )
  for (const sym of sorted) {
    const containers = sorted.filter(
      (other) => other !== sym && isStrictContainer(other, sym),
    )
    sym.depth = containers.length
    // Languages without a distinct method node (Python, Rust impl fns, Ruby)
    // model methods as plain functions. Relabel a function whose nearest
    // enclosing definition is a type/impl container so outlines read uniformly.
    if (sym.kind === 'function' && containers.length > 0) {
      const nearest = containers.reduce((a, b) =>
        b.endLine - b.startLine < a.endLine - a.startLine ? b : a,
      )
      if (METHOD_CONTAINER_KINDS.has(nearest.kind)) sym.kind = 'method'
    }
  }
  return sorted
}

const BODY_TYPE_HINTS = [
  'body',
  'block',
  'suite',
  'compound_statement',
  'declaration_list',
  'field_declaration_list',
]

function looksLikeBody(type: string): boolean {
  if (type.endsWith('_body') || type.endsWith('_block')) return true
  return BODY_TYPE_HINTS.includes(type)
}

function extractHeaderSpan(
  node: Node,
  lines: string[],
): { text: string; startLine: number; endLine: number } {
  const startRow = node.startPosition.row
  const endRow = node.endPosition.row
  const fallback = lines[startRow] ?? ''
  let headerEndRow = startRow
  try {
    let bodyRow: number | undefined
    for (const child of node.namedChildren) {
      if (!child) continue
      if (looksLikeBody(child.type) && child.startPosition.row > startRow) {
        if (bodyRow === undefined || child.startPosition.row < bodyRow) {
          bodyRow = child.startPosition.row
        }
      }
      // Recurse one level for declarator/value wrappers (e.g.
      // variable_declarator -> arrow_function -> block).
      for (const grand of child.namedChildren) {
        if (!grand) continue
        if (
          looksLikeBody(grand.type) &&
          grand.startPosition.row > startRow
        ) {
          if (bodyRow === undefined || grand.startPosition.row < bodyRow) {
            bodyRow = grand.startPosition.row
          }
        }
      }
    }
    if (bodyRow !== undefined) {
      headerEndRow = Math.min(Math.max(bodyRow, startRow), endRow)
    } else {
      // No body node: use the furthest header-ish field end.
      let maxRow = startRow
      for (const field of [
        'parameters',
        'formal_parameters',
        'type_parameters',
        'return_type',
        'result',
        'type',
        'declarator',
        'name',
      ]) {
        const f = safeField(node, field)
        if (f && f.endPosition.row > maxRow) maxRow = f.endPosition.row
      }
      headerEndRow = Math.min(Math.max(maxRow, startRow), endRow)
    }
  } catch {
    headerEndRow = startRow
  }
  const slice = lines.slice(startRow, Math.min(headerEndRow + 1, lines.length))
  const text = slice.join('\n').trim() || fallback.trim()
  return {
    text,
    startLine: startRow + 1,
    endLine: headerEndRow + 1,
  }
}

function isCommentLine(trimmed: string): boolean {
  return (
    trimmed.startsWith('//') ||
    trimmed.startsWith('/*') ||
    trimmed.startsWith('*') ||
    trimmed.startsWith('#') ||
    trimmed.startsWith('"""') ||
    trimmed.startsWith("'''") ||
    trimmed.startsWith('<!--') ||
    trimmed.startsWith('--')
  )
}

function normalizeDocLine(raw: string): string {
  let s = raw.trim()
  if (s.startsWith('///')) s = s.slice(3)
  else if (s.startsWith('//')) s = s.slice(2)
  else if (s.startsWith('/**')) s = s.slice(3)
  else if (s.startsWith('/*')) s = s.slice(2)
  else if (s.startsWith('*')) s = s.slice(1)
  else if (s.startsWith('#')) s = s.slice(1)
  else if (s.startsWith('"""')) s = s.slice(3)
  else if (s.startsWith("'''")) s = s.slice(3)
  else if (s.startsWith('<!--')) s = s.slice(4)
  s = s.trim()
  if (s.endsWith('*/')) s = s.slice(0, -2).trim()
  if (s.endsWith('-->')) s = s.slice(0, -3).trim()
  if (s.endsWith('"""')) s = s.slice(0, -3).trim()
  if (s.endsWith("'''")) s = s.slice(0, -3).trim()
  if (s.startsWith('*')) s = s.slice(1).trim()
  return s
}

export function extractDocForLine(
  lines: string[],
  startLine: number,
): { text: string; startLine: number; endLine: number } | null {
  const window = 5
  const endIdx = startLine - 2 // 0-indexed line above the definition
  if (endIdx < 0) return null
  const startIdx = Math.max(0, endIdx - window)
  // Walk backwards collecting a contiguous leading comment block.
  let blockStart: number | undefined
  for (let i = endIdx; i >= startIdx; i--) {
    const trimmed = (lines[i] ?? '').trim()
    if (trimmed === '') {
      // A blank line ends the adjacent block unless we haven't started yet
      // (skip at most one blank directly above the definition).
      if (blockStart !== undefined) break
      continue
    }
    if (!isCommentLine(trimmed)) break
    blockStart = i
  }
  if (blockStart === undefined) return null
  // Extend forward to the line directly above the definition while comment.
  let blockEnd = blockStart
  for (let i = blockStart; i <= endIdx; i++) {
    const trimmed = (lines[i] ?? '').trim()
    if (trimmed === '') {
      if (i === endIdx) break
      continue
    }
    if (!isCommentLine(trimmed)) break
    blockEnd = i
  }
  const raw = lines.slice(blockStart, blockEnd + 1)
  const normalized = raw.map(normalizeDocLine).filter((l) => l.length > 0)
  if (normalized.length === 0) return null
  return {
    text: normalized.join('\n'),
    startLine: blockStart + 1,
    endLine: blockEnd + 1,
  }
}

function extractTypeInfo(node: Node): SymbolTypeInfo | undefined {
  try {
    let params: SymbolParam[] | undefined
    for (const field of [
      'parameters',
      'formal_parameters',
      'parameter_list',
    ]) {
      const p = safeField(node, field)
      if (p) {
        const list: SymbolParam[] = []
        for (const child of p.namedChildren) {
          if (!child) continue
          if (child.type === ',' || child.type === '(' || child.type === ')')
            continue
          const nameNode =
            safeField(child, 'name') ??
            safeField(child, 'pattern') ??
            findIdentifier(child, 1) ??
            (IDENTIFIER_NODE_TYPES.has(child.type) ? child : null)
          if (!nameNode) continue
          const rawName = lastSegment(nameNode.text)
          if (!rawName || rawName.length > 128) continue
          const typeNode =
            safeField(child, 'type') ??
            safeField(child, 'type_annotation') ??
            safeField(child, 'annotation')
          const typeText = typeNode
            ? firstLine(typeNode.text).replace(/^[:=]\s*/, '').slice(0, 256)
            : undefined
          list.push(typeText ? { name: rawName, type: typeText } : { name: rawName })
          if (list.length >= 25) break
        }
        params = list
        break
      }
    }
    let returnType: string | undefined
    for (const field of [
      'return_type',
      'type_annotation',
      'result',
      'type',
    ]) {
      // `type` is a name fallback for non-functions; only treat it as a
      // return type for function-like nodes.
      if (field === 'type' && node.type !== 'function_item') {
        // Still allow explicit return annotations on method/function nodes.
        if (
          node.type !== 'function_definition' &&
          node.type !== 'function_declaration' &&
          node.type !== 'method_definition' &&
          node.type !== 'method_declaration'
        )
          continue
      }
      const r = safeField(node, field)
      if (r) {
        const cleaned = firstLine(r.text)
          .replace(/^\s*(->|:)\s*/, '')
          .trim()
          .slice(0, 256)
        if (cleaned) {
          returnType = cleaned
          break
        }
      }
    }
    if (params !== undefined || returnType !== undefined) {
      const detailParts: string[] = []
      if (params !== undefined)
        detailParts.push(
          `(${params.map((p) => (p.type ? `${p.name}: ${p.type}` : p.name)).join(', ')})`,
        )
      if (returnType) detailParts.push(`-> ${returnType}`)
      return {
        ...(params !== undefined ? { params } : {}),
        ...(returnType ? { returnType } : {}),
        detail: detailParts.join(' ').slice(0, 512) || undefined,
      }
    }
    return undefined
  } catch {
    return undefined
  }
}

function extractModifiers(node: Node, exported: boolean): SymbolModifiers | undefined {
  try {
    let visibility: string | undefined
    let isStatic: boolean | undefined
    let isAsync: boolean | undefined
    const seen = new Set<string>()
    const checkText = (t: string) => {
      const low = t.trim().toLowerCase()
      if (low === 'public' || low === 'private' || low === 'protected') {
        if (!visibility) visibility = low
      } else if (low === 'pub') {
        if (!visibility) visibility = 'public'
      } else if (low === 'static') {
        isStatic = true
      } else if (low === 'async') {
        isAsync = true
      }
    }
    for (const child of node.children.slice(0, 8)) {
      if (!child) continue
      const anonType = (child.type ?? '').trim().toLowerCase()
      if (anonType && !seen.has(anonType)) {
        seen.add(anonType)
        checkText(anonType)
      }
      const anonText = (child.text ?? '').trim().toLowerCase()
      if (anonText.length > 0 && anonText.length <= 16 && !seen.has(`t:${anonText}`)) {
        seen.add(`t:${anonText}`)
        checkText(anonText)
      }
      if (
        child.type === 'visibility_modifier' ||
        child.type === 'modifiers' ||
        child.type === 'modifier'
      ) {
        checkText(child.text)
      }
    }
    const prefix = firstLine(node.text).slice(0, 64).toLowerCase()
    if (prefix.startsWith('async ') || prefix.includes(' async ')) isAsync = true
    if (/(^|\s)static(\s|\()/.test(prefix)) isStatic = true
    if (
      visibility === undefined &&
      isStatic === undefined &&
      isAsync === undefined &&
      !exported
    )
      return undefined
    return {
      ...(visibility ? { visibility } : {}),
      ...(exported ? { exported: true } : {}),
      ...(isStatic ? { static: true } : {}),
      ...(isAsync ? { async: true } : {}),
    }
  } catch {
    return undefined
  }
}

function isExportedNode(node: Node): boolean {
  try {
    let cur: Node | null | undefined = node.parent
    for (let i = 0; i < 3 && cur; i++) {
      if (cur.type === 'export_statement') return true
      cur = cur.parent
    }
    const prefix = firstLine(node.text).slice(0, 32).toLowerCase()
    if (prefix.startsWith('export ') || prefix.startsWith('export{')) return true
    if (prefix.startsWith('pub ')) return true
    return false
  } catch {
    return false
  }
}

/**
 * Extract structural definitions from source content using tree-sitter.
 *
 * Returns `null` when no grammar is available for the file's extension (or
 * tree-sitter could not initialize), so callers can fall back to a heuristic.
 * Returns `[]` for a parseable file with no top-level definitions.
 * When `diagnostics` is supplied, unsupported/failed parses push an entry
 * instead of failing silently.
 */
export async function parseFileStructure(
  content: string,
  filePath: string,
  diagnostics?: StructureDiagnostic[],
): Promise<SymbolRange[] | null> {
  let cfg
  try {
    cfg = await getLanguageConfig(filePath)
  } catch {
    diagnostics?.push({
      filePath,
      stage: 'language',
      message: `Tree-sitter grammar failed to load for ${filePath}`,
    })
    return null
  }
  if (!cfg?.parser) {
    diagnostics?.push({
      filePath,
      stage: 'language',
      message: `No tree-sitter language configuration available for ${filePath}`,
    })
    return null
  }

  let tree
  try {
    tree = cfg.parser.parse(content)
  } catch {
    diagnostics?.push({
      filePath,
      stage: 'parse',
      message: `Tree-sitter parse failed for ${filePath}`,
    })
    return null
  }
  if (!tree) {
    diagnostics?.push({
      filePath,
      stage: 'parse',
      message: `Tree-sitter returned no tree for ${filePath}`,
    })
    return null
  }

  try {
    const lines = content.split(/\r?\n/)
    const language = getLanguageTag(filePath)
    const symbols: SymbolRange[] = []
    const seen = new Set<string>()
    // Iterative DFS to avoid deep recursion on large files.
    // Skip the root node itself: some grammars (e.g. Python `module`)
    // collide with definition kinds and would classify the whole file.
    const stack: Node[] = tree.rootNode.namedChildren.filter(
      (child): child is Node => child !== null,
    )
    while (stack.length > 0) {
      const node = stack.pop()!
      const kind = definitionKind(node)
      if (kind && !node.hasError) {
        const name = extractDefName(node)
        if (name) {
          const startLine = node.startPosition.row + 1
          const endLine = node.endPosition.row + 1
          const startCol = node.startPosition.column + 1
          const endCol = node.endPosition.column + 1
          // Dedupe includes kind+col so overloads with the same name/span
          // do not collide.
          const key = `${kind}:${name}:${startLine}:${startCol}:${endLine}:${endCol}`
          if (!seen.has(key)) {
            seen.add(key)
            const header = extractHeaderSpan(node, lines)
            const doc = extractDocForLine(lines, startLine)
            const exported = isExportedNode(node)
            const typeInfo = extractTypeInfo(node)
            const modifiers = extractModifiers(node, exported)
            symbols.push({
              name,
              kind,
              startLine,
              endLine,
              depth: 0,
              startCol,
              endCol,
              ...(nodeStartIndex(node) !== undefined
                ? { startByte: nodeStartIndex(node)! }
                : {}),
              ...(nodeEndIndex(node) !== undefined
                ? { endByte: nodeEndIndex(node)! }
                : {}),
              ...(exported ? { exported: true as const } : {}),
              language,
              signatureText: header.text,
              signatureStartLine: header.startLine,
              signatureEndLine: header.endLine,
              ...(doc
                ? {
                    docText: doc.text,
                    docStartLine: doc.startLine,
                    docEndLine: doc.endLine,
                  }
                : {}),
              ...(typeInfo ? { typeInfo } : {}),
              ...(modifiers ? { modifiers } : {}),
            })
          }
        }
      } else if (node.type === 'variable_declarator' && !node.hasError) {
        // Function/arrow/class consts + top-level value consts — the grammar's
        // declaration patterns don't cover these (incl. non-exported ones).
        const vkind = variableDeclaratorKind(node)
        const nameNode = safeField(node, 'name')
        if (vkind && nameNode) {
          const name = lastSegment(nameNode.text)
          const startLine = node.startPosition.row + 1
          const endLine = node.endPosition.row + 1
          const startCol = node.startPosition.column + 1
          const endCol = node.endPosition.column + 1
          const key = `${vkind}:${name}:${startLine}:${startCol}:${endLine}:${endCol}`
          if (name && !seen.has(key)) {
            seen.add(key)
            const header = extractHeaderSpan(node, lines)
            const doc = extractDocForLine(lines, startLine)
            const exported = isExportedNode(node)
            const typeInfo = extractTypeInfo(node)
            const modifiers = extractModifiers(node, exported)
            symbols.push({
              name,
              kind: vkind,
              startLine,
              endLine,
              depth: 0,
              startCol,
              endCol,
              ...(nodeStartIndex(node) !== undefined
                ? { startByte: nodeStartIndex(node)! }
                : {}),
              ...(nodeEndIndex(node) !== undefined
                ? { endByte: nodeEndIndex(node)! }
                : {}),
              ...(exported ? { exported: true as const } : {}),
              language,
              signatureText: header.text,
              signatureStartLine: header.startLine,
              signatureEndLine: header.endLine,
              ...(doc
                ? {
                    docText: doc.text,
                    docStartLine: doc.startLine,
                    docEndLine: doc.endLine,
                  }
                : {}),
              ...(typeInfo ? { typeInfo } : {}),
              ...(modifiers ? { modifiers } : {}),
            })
          }
        }
      }
      for (const child of node.namedChildren) {
        if (child) stack.push(child)
      }
    }
    return assignDepths(symbols)
  } catch {
    diagnostics?.push({
      filePath,
      stage: 'parse',
      message: `Tree-sitter structure walk failed for ${filePath}`,
    })
    return null
  } finally {
    ;(tree as { delete?: () => void }).delete?.()
  }
}

export async function parseFileStructureDetailed(
  content: string,
  filePath: string,
): Promise<{ symbols: SymbolRange[] | null; diagnostics: StructureDiagnostic[] }> {
  const diagnostics: StructureDiagnostic[] = []
  const symbols = await parseFileStructure(content, filePath, diagnostics)
  return { symbols, diagnostics }
}

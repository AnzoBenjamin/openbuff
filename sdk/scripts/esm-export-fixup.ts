import ts from 'typescript'

type Edit = { start: number; end: number; text: string }

function applyEdits(content: string, edits: Edit[]): string {
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    content = content.slice(0, edit.start) + edit.text + content.slice(edit.end)
  }
  return content
}

function parse(content: string, kind = ts.ScriptKind.JS) {
  return ts.createSourceFile('bundle.js', content, ts.ScriptTarget.Latest, true, kind)
}

function topLevelBindings(source: ts.SourceFile): Set<string> {
  const names = new Set<string>()
  const binding = (name: ts.BindingName) => {
    if (ts.isIdentifier(name)) names.add(name.text)
    else for (const element of name.elements) {
      if (ts.isBindingElement(element)) binding(element.name)
    }
  }
  for (const statement of source.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) binding(declaration.name)
    } else if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name) {
      names.add(statement.name.text)
    } else if (ts.isImportDeclaration(statement) && statement.importClause) {
      const clause = statement.importClause
      if (clause.name) names.add(clause.name.text)
      if (clause.namedBindings) {
        if (ts.isNamespaceImport(clause.namedBindings)) names.add(clause.namedBindings.name.text)
        else for (const element of clause.namedBindings.elements) names.add(element.name.text)
      }
    }
  }
  return names
}

/** Give Bun local live bindings for named entry reexports before tree shaking. */
export function normalizeEntryReexports(content: string): string {
  const source = parse(content, ts.ScriptKind.TS)
  const edits: Edit[] = []
  let nextId = 0
  for (const statement of source.statements) {
    if (!ts.isExportDeclaration(statement) || statement.isTypeOnly || !statement.moduleSpecifier ||
      !statement.exportClause || !ts.isNamedExports(statement.exportClause)) continue
    const values = statement.exportClause.elements.filter(element => !element.isTypeOnly)
    if (!values.length) continue
    const aliases = values.map(() => {
      let name: string
      do { name = `__sdkReexport${nextId++}` } while (content.includes(name))
      return name
    })
    const imports = values.map((element, index) => `${(element.propertyName ?? element.name).getText(source)} as ${aliases[index]}`)
    const exports = values.map((element, index) => `${aliases[index]} as ${element.name.getText(source)}`)
    const module = statement.moduleSpecifier.getText(source)
    const attributes = statement.attributes ? ` ${statement.attributes.getText(source)}` : ''
    const types = statement.exportClause.elements.filter(element => element.isTypeOnly)
      .map(element => `${element.propertyName ? `${element.propertyName.getText(source)} as ` : ''}${element.name.getText(source)}`)
    edits.push({ start: statement.getStart(source), end: statement.end, text:
      `import { ${imports.join(', ')} } from ${module}${attributes};\nexport { ${exports.join(', ')} };` +
      (types.length ? `\nexport type { ${types.join(', ')} } from ${module}${attributes};` : ''),
    })
  }
  return applyEdits(content, edits)
}

export function repairEsmExportRenames(content: string): {
  content: string
  fixCount: number
  removalCount: number
} {
  const source = parse(content)
  const declared = topLevelBindings(source)
  const edits: Edit[] = []
  const unresolved: string[] = []
  for (const statement of source.statements) {
    if (!ts.isExportDeclaration(statement) || statement.moduleSpecifier || !statement.exportClause ||
      !ts.isNamedExports(statement.exportClause)) continue
    for (const element of statement.exportClause.elements) {
      const local = element.propertyName ?? element.name
      if (declared.has(local.text)) continue
      // Bun may keep a deduplicated alias after merging its declaration into
      // the unsuffixed binding. Do not guess from the public export name:
      // legitimate aliases can differ from their local binding entirely.
      const original = local.text.replace(/\d+$/, '')
      if (element.propertyName && original !== local.text && declared.has(original)) {
        edits.push({ start: local.getStart(source), end: local.end, text: original })
      } else unresolved.push(`${local.text} as ${element.name.text}`)
    }
  }
  if (unresolved.length) throw new Error(`Unresolved ESM exports: ${unresolved.join(', ')}`)
  return { content: applyEdits(content, edits), fixCount: edits.length, removalCount: 0 }
}

/** Repair only unresolved import namespaces in generated __export getters. */
export function repairCjsExportGetters(content: string): { content: string; fixCount: number } {
  const source = parse(content)
  const declared = topLevelBindings(source)
  const mainObjects = new Set<string>()
  for (const statement of source.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isBinaryExpression(statement.expression)) continue
    const { left, right } = statement.expression
    if (left.getText(source) === 'module.exports' && ts.isCallExpression(right) &&
      right.expression.getText(source) === '__toCommonJS' && right.arguments[0] && ts.isIdentifier(right.arguments[0])) {
      mainObjects.add(right.arguments[0].text)
    }
  }
  const getters: Array<{ owner: string; name: string; body: ts.Expression }> = []
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === '__export' &&
      node.arguments.length === 2 && ts.isIdentifier(node.arguments[0]) && declared.has(node.arguments[0].text) &&
      ts.isObjectLiteralExpression(node.arguments[1])) {
      for (const property of node.arguments[1].properties) {
        if (ts.isPropertyAssignment(property) && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
          ts.isArrowFunction(property.initializer) && !ts.isBlock(property.initializer.body)) {
          getters.push({ owner: node.arguments[0].text, name: property.name.text, body: property.initializer.body })
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  const isBound = (expression: ts.Expression): boolean =>
    ts.isIdentifier(expression) ? declared.has(expression.text) :
    ts.isPropertyAccessExpression(expression) && isBound(expression.expression)
  const edits: Edit[] = []
  const unresolved: string[] = []
  for (const getter of getters) {
    const body = getter.body
    if (!ts.isPropertyAccessExpression(body) || !ts.isIdentifier(body.expression) ||
      !body.expression.text.startsWith('import_') || declared.has(body.expression.text)) continue
    const symbol = body.name.text
    const candidates = new Set(getters.filter(candidate => candidate.owner !== getter.owner &&
      !mainObjects.has(candidate.owner) && candidate.name === symbol && isBound(candidate.body))
      .map(candidate => candidate.body.getText(source)))
    if (candidates.size === 0 && declared.has(symbol)) candidates.add(symbol)
    if (candidates.size !== 1) {
      unresolved.push(`${getter.name}: ${body.getText(source)}${candidates.size > 1 ? ' (ambiguous)' : ''}`)
      continue
    }
    edits.push({ start: body.getStart(source), end: body.end, text: [...candidates][0] })
  }
  if (unresolved.length) throw new Error(`Unresolved CJS exports: ${unresolved.join(', ')}`)
  return { content: applyEdits(content, edits), fixCount: edits.length }
}

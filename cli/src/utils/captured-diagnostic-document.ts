import { createJsonDocument, type OutputDocument } from './output-document'

// Object identity follows retained message data across windowing. Weak keys
// release documents with their source; projections are created only on Inspect.
const documents = new WeakMap<object, Map<string, OutputDocument>>()
let nextIdentity = 0

export function capturedDiagnosticDocument(
  kind: string,
  title: string,
  source: object,
): OutputDocument {
  let byKind = documents.get(source)
  if (!byKind) {
    byKind = new Map()
    documents.set(source, byKind)
  }
  let document = byKind.get(kind)
  if (!document) {
    document = createJsonDocument(`${kind}:${++nextIdentity}`, title, source)
    byKind.set(kind, document)
  }
  return document
}

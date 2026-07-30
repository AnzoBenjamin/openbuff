import { createCodeEditor } from './editor'

import type { AgentDefinition } from '../types/agent-definition'

const base = createCodeEditor({ model: 'opus' })

const definition: AgentDefinition = {
  ...base,
  id: 'repair-editor',
  displayName: 'Repair Editor',
  // Narrow tool set: diagnosis reads (including subtree within authorized
  // patterns) plus edit_transaction. Do not broaden to the full editor set.
  toolNames: [
    'read_files',
    'read_outline',
    'read_blocks',
    'read_subtree',
    'edit_transaction',
  ],
  spawnerPrompt:
    'Repairs exact validation diagnostics or stable reviewer finding IDs. May only make finding-scoped edits and must not perform unrelated cleanup.',
  instructionsPrompt: `${base.instructionsPrompt}

Repair specialization:
- The spawn prompt must name exact validation diagnostics or stable reviewer finding IDs.
- Every edit must map to at least one supplied finding/diagnostic.
- Edit only implicated files and the narrowest directly required tests.
- Read-only scope may include the containing directories, package roots, and path citations from finding/diagnostic text so you can inspect causally relevant imports, types, fixtures, schemas, and conventions. Treat that as diagnostic context only; never edit an adjacent file unless it is also explicitly writable and tied to a supplied finding. Use read_subtree within authorized read patterns when package-root or cited-path context helps diagnosis. read_blocks is ok within authorized read patterns for large-file diagnosis.
- File paths that appear only as literals or fixture data inside an authorized test file are synthetic data, not separately authorized files. Do not read those paths unless they are independently authorized; inspect the owning authorized test file instead.
- Do not perform unrelated cleanup, refactors, documentation, or feature work.
- Reviewer snapshot/file-attestation mismatches are protocol failures, not source findings; do not edit files for them. Report the finding as unresolved so the parent can retry or explicitly bypass the reviewer gate.
- Return which finding IDs were addressed and which remain unresolved.`,
}

export default definition

import { publisher } from '../constants'

import type { AgentDefinition } from '../types/agent-definition'
import { qualitySection } from '../base2/quality-prompt-section'
import { PLACEHOLDER } from '@codebuff/agent-runtime/templates/types'

type CodeEditorVariant =
  | 'gpt-5'
  | 'opus'
  | 'glm'
  | 'kimi'
  | 'deepseek'
  | 'minimax'

// Only Opus gets <think>-tag scaffolding in its instructions; the other
// variants either have native reasoning (deepseek) or are non-reasoning
// models where the extra prose just bloats the prompt without helping.
const EDITOR_VARIANTS_WITH_THINK_TAGS: ReadonlySet<CodeEditorVariant> = new Set(
  ['opus'],
)
// Smaller / reasoning-first variants that are more prone to landing zero
// committed edits from a strict read-before-edit harness. These get explicit
// recovery guidance so they stop looping and emit a precise `blockedReason`
// (or a partial result) instead of making the parent guess why nothing changed.
const EDITOR_VARIANTS_WITH_RECOVERY_GUIDANCE: ReadonlySet<CodeEditorVariant> =
  new Set(['gpt-5', 'glm', 'kimi', 'deepseek', 'minimax'])
const EDITOR_MODELS: Record<CodeEditorVariant, AgentDefinition['model']> = {
  'gpt-5': 'openai/gpt-5.3',
  opus: 'anthropic/claude-opus-4.7',
  glm: 'z-ai/glm-4.7',
  kimi: 'moonshotai/kimi-k2.6',
  deepseek: 'deepseek/deepseek-v4-pro',
  minimax: 'minimax/minimax-m2.7',
}

export const createCodeEditor = (options: {
  model: CodeEditorVariant
}): Omit<AgentDefinition, 'id'> => {
  const { model } = options
  return {
    publisher,
    model: EDITOR_MODELS[model],
    displayName: 'Code Editor',
    spawnerPrompt:
      'Expert code editor that implements code changes. Spawn this agent with a compact, self-contained implementation brief containing requirements, target files, constraints/non-goals, relevant patterns, and code-level risks. Do not include validation commands, terminal cleanup, visual checks, review, git operations, or other parent-only work. The editor can read exact target files to recover missing or stale context and performs every mutation through edit_transaction, including capability-anchored range and symbol edits.',
    outputMode: 'structured_output',
    outputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['completed', 'partial', 'blocked'],
        },
        // Why the editor ended with status `blocked` (or reported partial)
        // despite its attempts: helps a cheap/fast parent model decide how to
        // retry without re-deriving the cause from raw tool transcripts.
        blockedReason: { type: 'string' },
        messages: { type: 'array', items: {} },
        changedFiles: { type: 'array', items: { type: 'string' } },
        targetFileProgress: {
          type: 'object',
          properties: {
            targetFiles: { type: 'array', items: { type: 'string' } },
            changedTargetFiles: { type: 'array', items: { type: 'string' } },
            pendingTargetFiles: { type: 'array', items: { type: 'string' } },
          },
          required: ['targetFiles', 'changedTargetFiles', 'pendingTargetFiles'],
        },
        requirementsAddressed: { type: 'array', items: { type: 'string' } },
        acceptanceCriteriaAddressed: {
          type: 'array',
          items: { type: 'string' },
        },
        findingsAddressed: { type: 'array', items: { type: 'string' } },
        unresolved: { type: 'array', items: { type: 'string' } },
        requestedValidation: { type: 'array', items: { type: 'string' } },
      },
      required: [
        'status',
        'messages',
        'changedFiles',
        'requirementsAddressed',
        'acceptanceCriteriaAddressed',
        'findingsAddressed',
        'unresolved',
        'requestedValidation',
      ],
    },
    toolNames: ['read_files', 'read_outline', 'edit_transaction'],

    includeMessageHistory: false,
    inheritParentSystemPrompt: false,

    instructionsPrompt: `You are an expert code editor with deep understanding of software engineering principles. You were spawned to generate an implementation for the user's request. Do not spawn an editor agent, you are the editor agent and have already been spawned.
    
Your task is to write out ALL the code changes needed to complete the implementation-scoped portion of the user's request, across every file that must change. Treat the spawn prompt's implementation-scoped requirements, target files, constraints/non-goals, relevant patterns, and code-level risks as the source of truth. Treat changed tests as first-class review targets, and report missing coverage only when no covering test exists.

Before a non-trivial edit, establish a compact source-backed implementation hypothesis: current behavior, desired behavior, exact evidence, intended change, expected observable result, and the signal that would falsify the approach. Do not edit when there is no causal link between evidence and the proposed change. Preserve stated invariants, failure behavior, compatibility expectations, acceptance cases, and explicit unknowns.

Prefer the smallest vertical slice (type/schema -> implementation -> direct test -> callers). If the same hypothesis or diagnostic survives two targeted attempts, stop repeating it, re-read the causal path, and switch strategy.

Do not perform or attempt parent-orchestrator responsibilities. You cannot run validation, typechecks, tests, terminal commands, visual smoke tests, code review, git operations, or shell-based cleanup/deletion. If parent-only tasks are mentioned anywhere in the spawn prompt, ignore them as parent responsibilities after you return. Do not create placeholder/no-op files to work around unavailable tools.

You may make edits across multiple turns. After each edit you will see whether it applied successfully:
- Call only edit_transaction for mutations. Choose edit intent precisely: default to str_replace for localized exact edits; use rewrite_symbol only when replacing a complete function, class, method, type, or other whole symbol; use replace_range for an authenticated range returned directly by read_files. Use structured for import-only changes, create for new files, patch for a complete unified diff, and write_file only for a necessary whole-file rewrite. For write_file overwrites of existing files, pass a whole-file-covering basedOnRead (or rely on sticky whole-file auth from a complete paths/full-file range read); never invent same-step sticky authority. If create fails because the path exists, retry with write_file using the echoed basedOnRead capability from that failure — do not exploratory re-read first when a fresh cap.v3 is already in the diagnostic.
- Same-file mixed edit modes are allowed only when their original spans are disjoint and provenance maps unambiguously. The runtime rejects overlap or ambiguous provenance. For large files, prefer read_files windows/around/symbol selectors for complete cap.v3 blocks; use read_files ranges when you need an exact arbitrary line range. Use read_outline to discover structure, and pull a complete symbol only when rewrite_symbol is the intended edit. Otherwise submit replace_range with editAnchor.readCapability.
- If a str_replace edit fails because oldString is stale, missing, or ambiguous, re-read the exact current range (or use the fresh capability in the diagnostic) before retrying. A syntax-only preflight failure may retry corrected new content without re-reading because oldString already matched.
- If edit_transaction aborts, no files changed. When failures include basedOnRead (or basedOnRead= in the diagnostic text), retry with that capability first (write_file basedOnRead, or basedOnRead on every str_replace replacement / replace_range readCapability) — do not exploratory re-read first when a fresh cap.v3 is already echoed. Re-read only when no capability is available, for ambiguous oldString (longer anchor / occurrenceIndex), or when the diagnostic explicitly requires a fresh range re-read. When re-read is required, rebuild the whole related transaction from one coherent snapshot.
- Never use ultra-broad anchors such as a lone closing brace plus newline, blank lines, or common punctuation. If a diagnostic reports many occurrences, use rewrite_symbol, a capability-anchored replace_range, or occurrenceIndex only when the exact occurrence is known from the read/diagnostic.
- Put dependent edits in one transaction so they preflight together. A simple one-file change is also a one-edit transaction.
- Keep editing until the entire request is implemented across all files. Do not stop after a single file when more files still need changes.
- Do not create scratch, placeholder, sentinel, or no-op files just to test whether editing works or to signal completion. Only create files that are explicitly requested or directly required by the implementation.
- When every change has been made and all edits have applied successfully, stop: respond with a brief one-line confirmation and make no further tool calls.

Important: You may call read_files only for exact files you need to edit or to recover after a failed/stale edit. You cannot search, write todos, spawn agents, or set output. set_output in particular should not be used. Do not call any unsupported tools!

Deterministic large-file editing (follow this exactly to avoid edits that fail for no apparent reason):
- Before the first edit to a large file, prefer read_files windows/around/symbol selectors to mint complete cap.v3 blocks; use read_files ranges only for an exact arbitrary line range. Pass basedOnRead / readCapability from that read on the edit; never invent same-step sticky authority.
- For a medium/large block replacement, copy editAnchor.readCapability from the directly read block/range into a replace_range edit. Do not also send startLine, endLine, or expectedHash; the capability already binds all three.
- For a large-file str_replace edit, use the available whole-file authorization or copy editAnchor.readCapability into basedOnRead on each replacement. When a failure mints basedOnRead in the diagnostic, paste it into the next write_file/str_replace retry instead of an exploratory re-read.
- If a single edit's newString or replacement content would exceed roughly 30-50 KB (e.g. inserting or moving hundreds of lines), do not submit it as one monolithic edit: oversized payloads can be truncated in transport and then fail preflight with a misleading syntax error. Instead split the change into several bounded, capability-anchored edits: re-read the exact target with read_files windows/around/symbol selectors or ranges, then apply replace_range (readCapability) or str_replace (basedOnRead) in forward-ordered chunks, each anchored on a unique declaration and small enough to transmit safely, keeping the file syntactically valid between steps when possible.
- Put several non-overlapping changes in one edit_transaction. Same-file mixed modes must refer to disjoint original spans with unambiguous mapping. Replacements within one str_replace edit apply sequentially, so consolidate overlapping expectations into one larger edit.
- After a successful mutation, prefer the runtime's automatic confirmed whole-file authorization or the action's post-edit editAnchor.readCapability. Re-read only when you need a different region, the action anchor is missing or oversized, filesystem state may be external or stale, or explicit diagnostics require it. Do not re-read after every success and never reuse a pre-edit capability for changed content.
- If an edit is rejected because the anchor/line count looks stale, do not retry from memory: re-read the exact current range first, then make one edit based on that fresh read.
- If oldString appears multiple times, prefer occurrenceIndex (1-indexed) or a more specific oldString rather than re-reading solely to disambiguate; combine occurrenceIndex with a fresh basedOnRead when editing within an anchored large-file range.

Write every mutation using this tool call shape:

<codebuff_tool_call>
{
  "cb_tool_name": "edit_transaction",
  "edits": [
    {
      "type": "str_replace",
      "path": "path/to/file",
      "replacements": [
        {
          "oldString": "exact old code",
          "newString": "exact new code"
        }
      ]
    },
    {
      "type": "structured",
      "path": "path/to/file",
      "operation": {
        "kind": "insert_import",
        "importStatement": "import { helper } from './helper'"
      }
    },
    {
      "type": "replace_range",
      "path": "path/to/large-file.ts",
      "readCapability": "cap.v3.from-editAnchor",
      "newContent": "complete replacement content"
    }
  ]
}
</codebuff_tool_call>

${
  EDITOR_VARIANTS_WITH_THINK_TAGS.has(model)
    ? `Before you start writing your implementation, you should use <think> tags to think about the best way to implement the changes.

You can also use <think> tags interspersed between tool calls to think about the best way to implement the changes.

<example>

<think>
[ Long think about the best way to implement the changes ]
</think>

<codebuff_tool_call>
[ First tool call to implement the feature ]
</codebuff_tool_call>

<codebuff_tool_call>
[ Second tool call to implement the feature ]
</codebuff_tool_call>

<think>
[ Thoughts about a tricky part of the implementation ]
</think>

<codebuff_tool_call>
[ Third tool call to implement the feature ]
</codebuff_tool_call>

</example>`
    : ''
}

${
  EDITOR_VARIANTS_WITH_RECOVERY_GUIDANCE.has(model)
    ? '\n\nRecovery guidance: if an edit_transaction repeatedly fails to commit, re-read the exact target (or use the failure capability) and retry once. If it still does not land, stop and return status "blocked" with a precise blockedReason and unresolved note so the orchestrator knows exactly what stalled.\n'
    : ''
}

Your implementation should:
- Be complete and comprehensive
- Include all necessary changes to fulfill the user's request
- Follow the project's conventions and patterns
- Be as simple and maintainable as possible
- Reuse existing code wherever possible
- Be well-structured and organized

More style notes:
- Extra try/catch blocks clutter the code -- use them sparingly.
- Use required arguments when they represent real invariants; use defaults, optionals, builders, or overloads when they are idiomatic for the active language and match the surrounding API.
- Preserve the project's file-organization conventions. Split a new component or module only when that improves cohesion in this ecosystem.

Write out your complete implementation now, formatting all changes as tool calls as shown above.

${qualitySection}

${PLACEHOLDER.LANGUAGE_PROFILE}

${PLACEHOLDER.FRONTEND_SECTION}`,

    handleSteps: function* ({ agentState: initialAgentState, prompt, params }) {
      const targetFiles = extractTargetFiles(
        prompt,
        initialAgentState.messageHistory,
      )

      let agentState = initialAgentState

      // Prime the editor with the exact declared targets before its first model
      // step. This both gives the model current source context and lets the
      // strict read-before-edit harness mint whole-file authorization for files
      // that exist. Missing targets remain eligible for create edits.
      if (targetFiles.length > 0) {
        const preRead = yield {
          toolName: 'read_files',
          input: { paths: targetFiles },
        }
        agentState = preRead.agentState
      }

      const initialMessageHistoryLength = agentState.messageHistory.length

      // Keep stepping while the model is still emitting edit tool calls so it
      // can implement multi-file changes and recover from failed transactions.
      // Productive steps are unlimited by default. The runtime's repeated-step
      // watchdog, cancellation, budgets, and subagent timeout bound runaway work.
      while (true) {
        const result = yield 'STEP'
        agentState = result.agentState
        if (result.stepsComplete) break
      }

      const { messageHistory } = agentState

      const newMessages = messageHistory.slice(initialMessageHistoryLength)
      const changedFiles = extractChangedFiles(newMessages)
      const targetFileProgress = buildTargetFileProgress(
        targetFiles,
        changedFiles,
      )
      const unresolved = targetFileProgress?.pendingTargetFiles ?? []
      const status =
        changedFiles.length === 0
          ? 'blocked'
          : unresolved.length > 0
            ? 'partial'
            : 'completed'
      // When nothing committed, surface why so the parent can retry precisely
      // instead of re-deriving the cause from raw tool transcripts. A cheap,
      // explicit diagnostic only — never a security/authority statement.
      const blockedReason =
        changedFiles.length === 0
          ? collectFailedEditReason(newMessages)
          : undefined
      // Changed paths prove only that mutations committed, not that a reviewer
      // finding was semantically addressed. Leave finding attestation to the
      // parent reviewer gate until an explicit trustworthy evidence channel exists.
      const findingsAddressed: string[] = []

      yield {
        toolName: 'set_output',
        input: {
          output: {
            status,
            messages: newMessages,
            changedFiles,
            ...(blockedReason !== undefined ? { blockedReason } : {}),
            ...(targetFileProgress ? { targetFileProgress } : {}),
            requirementsAddressed: [],
            acceptanceCriteriaAddressed: [],
            findingsAddressed,
            unresolved,
            requestedValidation: [],
          },
        },
        includeToolCall: false,
      }

      function extractChangedFiles(messages: unknown[]): string[] {
        const files = new Set<string>()
        visit(messages, files)
        return [...files]
      }

      // Called only when `changedFiles.length === 0` (so the status resolves to
      // `blocked`). Produces a deterministic, cheap diagnostic for why no edit
      // landed without inspecting any authority/security internals — just two
      // boolean flags derived from the edit_transaction tool messages.
      function collectFailedEditReason(messages: unknown[]): string {
        let sawEditTransaction = false
        let committedUnrecognized = false
        for (const message of messages) {
          if (!message || typeof message !== 'object') continue
          const record = message as Record<string, unknown>
          if (
            record.role !== 'tool' ||
            record.toolName !== 'edit_transaction'
          ) {
            continue
          }
          sawEditTransaction = true
          const parts = Array.isArray(record.content) ? record.content : []
          for (const part of parts) {
            if (!part || typeof part !== 'object') continue
            const partRecord = part as Record<string, unknown>
            if (
              partRecord.type !== 'json' ||
              !partRecord.value ||
              typeof partRecord.value !== 'object'
            ) {
              continue
            }
            const value = partRecord.value as Record<string, unknown>
            if (
              (value.kind === 'commit_receipt' &&
                value.version === 1 &&
                value.status === 'committed') ||
              (value.kind === 'file_mutation_result' &&
                value.version === 1 &&
                (value.outcome === 'applied' || value.outcome === 'partial'))
            ) {
              committedUnrecognized = true
            }
          }
        }
        if (committedUnrecognized) {
          return 'edit_transaction committed but the change was not recognized as an edited file. Check that the receipt finalHashes/actions all correlate and the target path matches what you intended to change.'
        }
        if (sawEditTransaction) {
          return 'edit_transaction was attempted but no edit committed. Re-read the exact target range (or the failure diagnostic capability) and retry with a precise anchor.'
        }
        return 'no edit_transaction was submitted; no file changes were produced.'
      }

      // NOTE: these helpers are inlined here (rather than imported from
      // agents/base2/gate-files) because `handleSteps` is serialized via
      // `.toString()` and reconstructed with `new Function(...)`, which drops
      // the module closure. Any module-scope reference would be `undefined`
      // at runtime. Keep these in sync with agents/base2/gate-files.ts and
      // the parallel inline copies in agents/base2/base2.ts.
      function isFileChangingTool(toolName: string): boolean {
        return (
          toolName === 'apply_patch' ||
          toolName === 'apply_smart_patch' ||
          toolName === 'edit_transaction' ||
          toolName === 'replace_range' ||
          toolName === 'rewrite_symbol' ||
          toolName === 'str_replace' ||
          toolName === 'write_file'
        )
      }

      // Mutation evidence is accepted only from canonical committed receipts.
      // For partial results, each applied action is correlated independently so
      // a committed subset remains reportable without trusting failed actions.
      function getCorrelatedReceiptAction(
        receiptActions: unknown[],
        action: Record<string, unknown>,
      ): Record<string, unknown> | null {
        if (
          !Number.isInteger(action.index) ||
          (action.index as number) < 0 ||
          typeof action.actionId !== 'string' ||
          action.actionId.length === 0
        ) {
          return null
        }
        const indexMatches = receiptActions.filter(
          (candidate) =>
            candidate &&
            typeof candidate === 'object' &&
            (candidate as Record<string, unknown>).index === action.index,
        )
        const actionIdMatches = receiptActions.filter(
          (candidate) =>
            candidate &&
            typeof candidate === 'object' &&
            (candidate as Record<string, unknown>).actionId === action.actionId,
        )
        return indexMatches.length === 1 &&
          actionIdMatches.length === 1 &&
          indexMatches[0] === actionIdMatches[0]
          ? (indexMatches[0] as Record<string, unknown>)
          : null
      }

      function hasEditArtifact(record: Record<string, unknown>): boolean {
        const actions = Array.isArray(record.actions) ? record.actions : []
        const receipt =
          record.kind === 'commit_receipt'
            ? record
            : record.authorityReceipt &&
                typeof record.authorityReceipt === 'object' &&
                !Array.isArray(record.authorityReceipt)
              ? (record.authorityReceipt as Record<string, unknown>)
              : null
        const receiptActions =
          receipt && Array.isArray(receipt.actions) ? receipt.actions : []
        const finalHashes =
          receipt &&
          receipt.finalHashes &&
          typeof receipt.finalHashes === 'object' &&
          !Array.isArray(receipt.finalHashes)
            ? (receipt.finalHashes as Record<string, unknown>)
            : null
        const validEnvelope =
          receipt !== null &&
          receipt.kind === 'commit_receipt' &&
          receipt.version === 1 &&
          receipt.status === 'committed' &&
          typeof receipt.operationId === 'string' &&
          receipt.operationId.length > 0 &&
          typeof receipt.receiptId === 'string' &&
          receipt.receiptId.length > 0 &&
          typeof receipt.callId === 'string' &&
          receipt.callId.length > 0 &&
          typeof receipt.authorityTier === 'string' &&
          receipt.authorityTier.length > 0 &&
          Array.isArray(receipt.actions) &&
          finalHashes !== null &&
          (record.kind === 'commit_receipt' ||
            (record.kind === 'file_mutation_result' &&
              record.version === 1 &&
              (record.outcome === 'applied' || record.outcome === 'partial') &&
              record.operationId === receipt.operationId &&
              record.receiptId === receipt.receiptId &&
              record.authorityTier === receipt.authorityTier &&
              Array.isArray(record.errors) &&
              Array.isArray(record.freshCapabilities)))
        if (!validEnvelope) return false
        return actions.some((action) => {
          if (!action || typeof action !== 'object') return false
          const entry = action as Record<string, unknown>
          const committed = getCorrelatedReceiptAction(receiptActions, entry)
          const applied =
            record.kind === 'commit_receipt'
              ? entry.status === 'committed'
              : entry.outcome === 'applied'
          const path =
            entry.action === 'move' ? entry.destinationPath : entry.path
          const effectivePath =
            typeof path === 'string' && path.length > 0 ? path : null
          return (
            applied &&
            typeof entry.path === 'string' &&
            entry.path.length > 0 &&
            typeof entry.actionId === 'string' &&
            committed?.status === 'committed' &&
            committed.actionId === entry.actionId &&
            committed.action === entry.action &&
            committed.path === entry.path &&
            committed.destinationPath === entry.destinationPath &&
            committed.afterHash === entry.afterHash &&
            effectivePath !== null &&
            finalHashes[effectivePath] === entry.afterHash
          )
        })
      }

      function collectToolInputFiles(input: unknown, out: Set<string>): void {
        if (!input || typeof input !== 'object') return
        const record = input as Record<string, unknown>
        if (typeof record.path === 'string') out.add(record.path)
        const operation = record.operation
        if (
          operation &&
          typeof operation === 'object' &&
          typeof (operation as Record<string, unknown>).path === 'string'
        ) {
          out.add((operation as Record<string, string>).path)
        }
        const edits = record.edits
        if (Array.isArray(edits)) {
          for (const edit of edits) {
            if (
              edit &&
              typeof edit === 'object' &&
              typeof (edit as Record<string, unknown>).path === 'string'
            ) {
              out.add((edit as Record<string, string>).path)
            }
          }
        }
      }

      function visit(
        value: unknown,
        out: Set<string>,
        allowEditArtifacts = false,
      ): void {
        if (!value) return
        if (Array.isArray(value)) {
          for (const item of value) visit(item, out, allowEditArtifacts)
          return
        }
        if (typeof value !== 'object') return

        const record = value as Record<string, unknown>
        if (record.role === 'tool') {
          if (
            typeof record.toolName === 'string' &&
            isFileChangingTool(record.toolName)
          ) {
            visit(record.content, out, true)
          }
          return
        }
        if (!allowEditArtifacts) {
          for (const nested of Object.values(record)) visit(nested, out, false)
          return
        }
        if (record.type === 'json' && 'value' in record) {
          visit(record.value, out, true)
          return
        }
        if (!hasEditArtifact(record)) return

        const receipt =
          record.kind === 'commit_receipt'
            ? record
            : (record.authorityReceipt as Record<string, unknown>)
        const receiptActions = receipt.actions as Array<Record<string, unknown>>
        const finalHashes = receipt.finalHashes as Record<string, unknown>
        for (const action of record.actions as Array<Record<string, unknown>>) {
          const committed = getCorrelatedReceiptAction(receiptActions, action)
          const applied =
            record.kind === 'commit_receipt'
              ? action.status === 'committed'
              : action.outcome === 'applied'
          const path =
            action.action === 'move' ? action.destinationPath : action.path
          const effectivePath =
            typeof path === 'string' && path.length > 0 ? path : null
          const correlated =
            applied &&
            typeof action.path === 'string' &&
            action.path.length > 0 &&
            committed?.status === 'committed' &&
            committed.actionId === action.actionId &&
            committed.action === action.action &&
            committed.path === action.path &&
            committed.destinationPath === action.destinationPath &&
            committed.afterHash === action.afterHash &&
            effectivePath !== null &&
            finalHashes[effectivePath] === action.afterHash
          if (!correlated || effectivePath === null) continue
          out.add(effectivePath)
        }
      }

      function buildTargetFileProgress(
        targetFiles: string[],
        changedFiles: string[],
      ):
        | {
            targetFiles: string[]
            changedTargetFiles: string[]
            pendingTargetFiles: string[]
          }
        | undefined {
        if (targetFiles.length === 0) return undefined
        const changedFileSet = new Set(changedFiles.map(normalizeFilePath))
        const changedTargetFiles = targetFiles.filter((file) =>
          changedFileSet.has(normalizeFilePath(file)),
        )
        const pendingTargetFiles = targetFiles.filter(
          (file) => !changedFileSet.has(normalizeFilePath(file)),
        )
        return { targetFiles, changedTargetFiles, pendingTargetFiles }
      }

      function extractTargetFiles(
        prompt: unknown,
        initialMessageHistory: unknown[],
      ): string[] {
        const texts: string[] = []
        collectText(prompt, texts)
        collectText(initialMessageHistory, texts)
        const files = new Set<string>()
        for (const text of texts) {
          collectTargetFilesFromText(text, files)
        }
        return [...files]
      }

      function collectTargetFilesFromText(
        text: string,
        files: Set<string>,
      ): void {
        const targetFilesSection = text.match(
          /(?:^|\n)\s*(?:#{1,4}\s+)?Target files?\s*:?\s*\n([\s\S]*?)(?=\n\s*(?:#{1,4}\s+\S|\S[^\n]*:)|$)/i,
        )
        if (targetFilesSection) {
          for (const line of targetFilesSection[1].split(/\r?\n/)) {
            const match = line.match(
              /(?:^|[-*]\s+)(`?)([^`\s]+\.[A-Za-z][\w.-]*)\1/,
            )
            if (match) addTargetFile(match[2], files)
          }
        }
      }

      function addTargetFile(file: string, files: Set<string>): void {
        const normalized = normalizeFilePath(file)
        if (normalized) files.add(normalized)
      }

      function normalizeFilePath(file: string): string {
        let normalized = file.trim().replace(/\\/g, '/')
        if (!normalized) return ''
        if (normalized.startsWith('file://')) {
          normalized = normalized.slice('file://'.length)
        }
        while (normalized.startsWith('./')) {
          normalized = normalized.slice(2)
        }
        return normalized.replace(/[),.;:]+$/, '')
      }

      function collectText(value: unknown, texts: string[]): void {
        if (typeof value === 'string') {
          texts.push(value)
          return
        }
        if (!value) return
        if (Array.isArray(value)) {
          for (const item of value) collectText(item, texts)
          return
        }
        if (typeof value !== 'object') return
        const record = value as Record<string, unknown>
        collectText(record.text, texts)
        collectText(record.content, texts)
        collectText(record.prompt, texts)
      }
    },
  } satisfies Omit<AgentDefinition, 'id'>
}

const definition = {
  ...createCodeEditor({ model: 'opus' }),
  id: 'editor',
}
export default definition

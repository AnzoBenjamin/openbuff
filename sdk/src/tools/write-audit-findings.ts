import { toolParams } from '@codebuff/common/tools/list'
import { auditIdentifierSchema } from '@codebuff/common/tools/params/tool/write-audit-findings'
import { isFileMutationResultV1 } from '@codebuff/common/tools/results/filesystem'
import { getContentHash } from '@codebuff/common/util/content-hash'

import { changeFile, UNREPORTABLE_ECHO } from './change-file'
import { resolveFilePathForFileSystemReadOperation } from './path-utils'

import type { CodebuffToolOutput } from '@codebuff/common/tools/list'
import type { FileMutationResultV1 } from '@codebuff/common/tools/results/filesystem'
import type { AuditFindingsInput } from '@codebuff/common/tools/params/tool/write-audit-findings'
import type { CodebuffFileSystem } from '@codebuff/common/types/filesystem'
import type { Logger } from '@codebuff/common/types/contracts/logger'
import type { FileFilter } from './read-files'
import type { FilesystemAuthorityPolicy } from './filesystem-authority'

export function auditFindingsArtifactPath(params: {
  sessionSlug: string
  shardId: string
}): string {
  return `.agents/sessions/${params.sessionSlug}/findings/${params.shardId}.md`
}

/**
 * Collapses newlines in model-supplied text so a single value cannot forge an
 * extra Markdown heading (e.g. a second `## Coverage receipt` block) in the
 * artifact other agents parse. CommonMark treats a bare CR as a line ending
 * too, so lone CRs are collapsed alongside LF and CRLF.
 */
function singleLine(value: string): string {
  return value.replace(/\r\n?|\n/g, ' ')
}

/**
 * Best-effort echo of an artifact-path identifier from raw parameters that
 * never parsed. Validated with the canonical `auditIdentifierSchema` so a
 * rejected value can neither widen the reported path (`../escape`, `..`) nor
 * amplify the error message (a megabyte of dashes), and the bounds cannot
 * drift from the tool's input schema; anything else is reported as the shared
 * `UNREPORTABLE_ECHO` placeholder replace_range's path echo also uses.
 */
function rawArtifactIdentifier(parameters: unknown, key: string): string {
  const value =
    typeof parameters === 'object' && parameters !== null
      ? (parameters as Record<string, unknown>)[key]
      : undefined
  const parsed = auditIdentifierSchema.safeParse(value)
  return parsed.success ? parsed.data : UNREPORTABLE_ECHO
}

/**
 * The artifact's own snapshot attestation line. Rendered into the artifact
 * header for every snapshot-bound call, so the persisted file itself records
 * which snapshot its findings were evaluated against. That persisted line is
 * what {@link persistedSnapshotAttestation} reads back, so an already-exists
 * collision can only ever claim the snapshot the file on disk actually names.
 */
function snapshotAttestationLine(snapshotId: string): string {
  return `- Snapshot: ${singleLine(snapshotId)}`
}

/**
 * The snapshot id the PERSISTED artifact attests to, or undefined when it
 * attests to none — a legacy artifact written before snapshot binding, or one
 * written by a call that supplied no snapshotId. Parsed from the artifact's own
 * {@link snapshotAttestationLine}, so binding a collision marker to the
 * caller's snapshotId can never be satisfied by a stale or unattested file.
 */
function persistedSnapshotAttestation(persisted: string): string | undefined {
  const prefix = '- Snapshot: '
  for (const line of persisted.split('\n')) {
    if (line.startsWith(prefix)) {
      return line.slice(prefix.length).trim() || undefined
    }
  }
  return undefined
}

/**
 * The exact bytes of the artifact ALREADY ON DISK, or null when they cannot be
 * read.
 *
 * Read once per collision because both decisions depend on the same bytes:
 * whether the persisted artifact holds THIS call's findings (byte identity),
 * and which snapshot that artifact attests to. Denies by default — an
 * unreadable file (it may vanish between the rejected create and this read) or
 * a path that does not resolve inside the project returns null, which keeps the
 * collision a genuine conflict and the coverage gate closed.
 */
async function readPersistedArtifact(params: {
  artifactPath: string
  cwd: string
  fs: CodebuffFileSystem
}): Promise<string | null> {
  const resolved = await resolveFilePathForFileSystemReadOperation(
    params.cwd,
    params.artifactPath,
    params.fs,
  )
  if (!resolved) return null
  try {
    const raw = await params.fs.readFile(resolved.operationPath)
    return typeof raw === 'string'
      ? raw
      : new TextDecoder('utf-8').decode(
          new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength),
        )
  } catch {
    return null
  }
}

export function renderAuditFindingsMarkdown(input: AuditFindingsInput): string {
  const subsystemIds = input.coverage.subsystemIds.map(singleLine)
  const featureIds = input.coverage.featureIds.map(singleLine)
  const files = input.coverage.files.map(singleLine)
  const lines = [
    `# Audit findings: ${singleLine(input.shardId)}`,
    '',
    `- Subsystems: ${subsystemIds.join(', ') || '(none)'}`,
    `- Features: ${featureIds.join(', ') || '(none)'}`,
    `- Files covered: ${files.length}`,
    // Persisted snapshot binding: an already-exists collision may only claim
    // durable coverage for the snapshot the artifact on disk actually names.
    ...(input.snapshotId ? [snapshotAttestationLine(input.snapshotId)] : []),
    '',
  ]
  if (input.noIssuesFound) {
    // `coverage.domains` is optional, so the claim is derived from what the
    // caller actually attested to instead of hardcoding a domain count.
    const domainCount = input.coverage.domains?.length
    lines.push(
      domainCount
        ? `No issues found across all ${domainCount} declared domains.`
        : 'No issues found across the declared domains.',
      '',
    )
  }
  for (const finding of input.findings) {
    const location = `${singleLine(finding.path)}${finding.line ? `:${finding.line}` : ''}`
    lines.push(
      `## [${finding.severity}] ${finding.domain} — ${location} — ${singleLine(finding.title)}`,
      `- **Risk:** ${singleLine(finding.risk)}`,
      `- **Fix:** ${singleLine(finding.fix)}`,
      `- **Evidence:** ${singleLine(finding.evidence)}`,
      '',
    )
  }
  lines.push('## Coverage receipt', '')
  lines.push('### Subsystems', ...subsystemIds.map((id) => `- ${id}`), '')
  lines.push('### Features', ...featureIds.map((id) => `- ${id}`), '')
  lines.push('### Files', ...files.map((file) => `- ${file}`), '')
  if (input.coverage.domains) {
    // Parity with `structuralReceipt.domains`: agents that parse the Markdown
    // artifact rather than the JSON receipt must be able to see the declared
    // domains too. Omitted when the caller declared none, so the block never
    // implies a coverage claim that was not attested to.
    lines.push(
      '### Domains',
      ...input.coverage.domains.map((domain) => `- ${domain}`),
      '',
    )
  }
  return lines.join('\n')
}

/**
 * Selects a `file_mutation_result` payload from tool output parts with the
 * canonical `isFileMutationResultV1` predicate rather than by position: a
 * mutating tool may emit further json parts, and first-json matching would
 * report a generic failure (and hide the mutation from the host) for an
 * artifact that was actually written. run.ts runs the same selection over its
 * dispatch result, so both share this one implementation and cannot diverge.
 */
export function findFileMutationResult(
  parts: readonly { type: string; value?: unknown }[],
): FileMutationResultV1 | undefined {
  for (const part of parts) {
    if (part.type === 'json' && isFileMutationResultV1(part.value)) {
      return part.value
    }
  }
  return undefined
}

/**
 * The compact receipt a persisted artifact yields. Shared by the successful
 * write and by an idempotent already-persisted collision, so a retried shard
 * hands the parent the SAME snapshot-bound `structuralReceipt`
 * evaluate_audit_coverage accepts instead of a rejection it can never compose.
 */
function auditFindingsReceipt(params: {
  input: AuditFindingsInput
  artifactPath: string
  content: string
}) {
  const { input, artifactPath, content } = params
  const severityCounts = {
    CRITICAL: 0,
    HIGH: 0,
    MEDIUM: 0,
    LOW: 0,
  }
  for (const finding of input.findings) severityCounts[finding.severity]++
  return {
    artifactPath,
    artifacts: [artifactPath],
    findingCount: input.findings.length,
    severityCounts,
    coverage: {
      subsystemCount: input.coverage.subsystemIds.length,
      featureCount: input.coverage.featureIds.length,
      fileCount: input.coverage.files.length,
    },
    ...(input.snapshotId && input.coverage.domains
      ? {
          structuralReceipt: {
            schema_version: 1 as const,
            snapshot_id: input.snapshotId,
            shard_id: input.shardId,
            subsystem_ids: input.coverage.subsystemIds,
            files: input.coverage.files,
            domains: input.coverage.domains,
          },
        }
      : {}),
    contentHash: getContentHash(content),
  }
}

export type WriteAuditFindingsResult = {
  output: CodebuffToolOutput<'write_audit_findings'>
  /**
   * The artifact write's underlying `file_mutation_result`. The declared
   * output is a compact receipt, so hosts that key off the mutation payload
   * (run.ts advances workspace state/journal and notifies the change observers
   * from it) would otherwise never see the artifact write. It is returned for
   * every well-formed mutation result, applied or NOT, so a receiving host must
   * gate on the outcome (e.g. `getConfirmedAppliedActionsV1`) instead of
   * treating its presence as proof that the write succeeded.
   */
  mutation?: FileMutationResultV1
}

export async function writeAuditFindings(params: {
  parameters: unknown
  cwd: string
  fs: CodebuffFileSystem
  signal?: AbortSignal
  fileFilter?: FileFilter
  filesystemPolicy?: FilesystemAuthorityPolicy
  callId?: string
  logger?: Logger
}): Promise<WriteAuditFindingsResult> {
  const parsed = toolParams.write_audit_findings.inputSchema.safeParse(
    params.parameters,
  )
  if (!parsed.success) {
    // Mirror replace_range: return this tool's declared error shape instead of
    // throwing. A throw is caught by run.ts's generic handler, which emits an
    // `{ errorMessage }`-only value that does not satisfy the
    // write_audit_findings output union, so the agent loses the artifactPath
    // identifying which call failed.
    return {
      output: [
        {
          type: 'json',
          value: {
            artifactPath: auditFindingsArtifactPath({
              sessionSlug: rawArtifactIdentifier(
                params.parameters,
                'sessionSlug',
              ),
              shardId: rawArtifactIdentifier(params.parameters, 'shardId'),
            }),
            errorMessage: 'Missing or invalid write_audit_findings parameters.',
          },
        },
      ],
    }
  }
  const input = parsed.data
  const artifactPath = auditFindingsArtifactPath(input)
  const content = renderAuditFindingsMarkdown(input)
  // `changeFile` only throws on a rejected change shape or an outside-project
  // path, neither of which is reachable for this derived path (the slugs are
  // validated and cannot contain a separator or a dot segment), so every
  // failure arrives as a `not_applied` result handled below.
  const mutationOutput = await changeFile({
    parameters: {
      type: 'file',
      path: artifactPath,
      content,
      expectedHash: null,
    },
    cwd: params.cwd,
    fs: params.fs,
    signal: params.signal,
    fileFilter: params.fileFilter,
    filesystemPolicy: params.filesystemPolicy,
    callId: params.callId,
    logger: params.logger,
  })
  const mutation = findFileMutationResult(mutationOutput)
  if (!mutation || mutation.outcome !== 'applied') {
    const reported = mutation
      ? mutation.errors.map((error) => error.message).join('; ')
      : ''
    const errorMessage =
      reported || 'Audit findings artifact was not confirmed as written.'
    // The artifact is created exclusively (`expectedHash: null`) so one shard
    // can never clobber another's findings. A collision therefore means an
    // artifact for this shard id is already persisted at the derived path — but
    // only BYTE-IDENTICAL content proves that artifact holds THIS call's
    // findings, which is the one case that may be reported as already done.
    const alreadyExists = /already exists/i.test(reported)
    // Read the persisted artifact ONCE: the content-identity decision and the
    // snapshot the marker may bind to both come from those exact bytes.
    const persisted = alreadyExists
      ? await readPersistedArtifact({
          artifactPath,
          cwd: params.cwd,
          fs: params.fs,
        })
      : null
    // Content identity is the only proof that the persisted artifact holds THIS
    // call's findings. Without it, a retry with different or expanded findings
    // would be reported as already done while those findings are persisted
    // nowhere. A file of a different length cannot be identical, so length
    // rejects early; an unreadable file denies by default.
    const persistedIsThisCall =
      persisted !== null &&
      persisted.length === content.length &&
      persisted === content
    // Bind the marker only to a snapshot the artifact ON DISK attests to, so
    // neither a stale artifact from another snapshot nor a legacy artifact with
    // no attestation can satisfy a snapshot-bound coverage gate.
    const persistedSnapshotId =
      persisted === null ? undefined : persistedSnapshotAttestation(persisted)
    const boundSnapshotId =
      persistedIsThisCall &&
      input.snapshotId &&
      persistedSnapshotId === input.snapshotId
        ? input.snapshotId
        : undefined
    if (alreadyExists) {
      // Still a rejection: this call wrote nothing, so it never synthesizes the
      // compact success receipt (no structuralReceipt, no contentHash). What it
      // adds is the explicit already-persisted marker, and that marker credits
      // the shared coverage gate ONLY when the persisted bytes are this call's
      // findings AND attest to this call's snapshot — which is what keeps a
      // retried shard from being permanently uncoverable without letting a
      // stale artifact stand in for findings stored nowhere. Only the
      // schema-validated shard id and the runtime-derived path are echoed.
      const recovery = persistedIsThisCall
        ? ` Shard id "${input.shardId}": this shard's findings are already persisted at ${artifactPath} and the artifact on disk is byte-identical to this call, so treat this as already written and do not write a duplicate. Use a distinct shard id only when intentionally writing an additional, different artifact.`
        : ` Shard id "${input.shardId}": an artifact already exists at ${artifactPath}, but its contents are not this call's findings${
            input.snapshotId && persistedSnapshotId !== input.snapshotId
              ? " and it does not attest to this call's snapshotId"
              : ''
          }, so it cannot stand in for them and nothing from this call is persisted. Persist these findings under a distinct shard id to obtain a composable coverage receipt.`
      return {
        output: [
          {
            type: 'json',
            value: {
              artifactPath,
              errorMessage: `${errorMessage}${recovery}`,
              alreadyPersisted: {
                schema_version: 1 as const,
                shardId: input.shardId,
                artifactPath,
                ...(boundSnapshotId ? { snapshot_id: boundSnapshotId } : {}),
              },
            },
          },
        ],
        ...(mutation ? { mutation } : {}),
      }
    }
    // Any other rejection carries no durable-persistence marker at all:
    // widening the gate to every failure would let a write that never landed
    // claim coverage.
    return {
      output: [
        {
          type: 'json',
          value: { artifactPath, errorMessage },
        },
      ],
      ...(mutation ? { mutation } : {}),
    }
  }
  return {
    output: [
      {
        type: 'json',
        value: auditFindingsReceipt({ input, artifactPath, content }),
      },
    ],
    mutation,
  }
}

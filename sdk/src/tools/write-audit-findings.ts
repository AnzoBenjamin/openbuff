import { toolParams } from '@codebuff/common/tools/list'
import { auditIdentifierSchema } from '@codebuff/common/tools/params/tool/write-audit-findings'
import { fileMutationResultV1Schema } from '@codebuff/common/tools/results/filesystem'
import { getContentHash } from '@codebuff/common/util/content-hash'

import { changeFile, UNREPORTABLE_ECHO } from './change-file'

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

export async function writeAuditFindings(params: {
  parameters: unknown
  cwd: string
  fs: CodebuffFileSystem
  signal?: AbortSignal
  fileFilter?: FileFilter
  filesystemPolicy?: FilesystemAuthorityPolicy
  callId?: string
  logger?: Logger
  /**
   * Receives the underlying `file_mutation_result` for the artifact write.
   * This tool's declared output is a compact receipt, so hosts that key off
   * the mutation payload (run.ts advances workspace state/journal and notifies
   * the change observers from it) would otherwise never see the artifact
   * write. Invoked for every well-formed mutation result, applied or not; the
   * caller decides which actions were confirmed.
   */
  onMutationResult?: (mutation: FileMutationResultV1) => void
}): Promise<CodebuffToolOutput<'write_audit_findings'>> {
  const parsed = toolParams.write_audit_findings.inputSchema.safeParse(
    params.parameters,
  )
  if (!parsed.success) {
    // Mirror replace_range: return this tool's declared error shape instead of
    // throwing. A throw is caught by run.ts's generic handler, which emits an
    // `{ errorMessage }`-only value that does not satisfy the
    // write_audit_findings output union, so the agent loses the artifactPath
    // identifying which call failed.
    return [
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
    ]
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
  const mutationPart = mutationOutput.find((part) => part.type === 'json')
  const mutation = fileMutationResultV1Schema.safeParse(mutationPart?.value)
  if (mutation.success) {
    params.onMutationResult?.(mutation.data)
  }
  if (!mutation.success || mutation.data.outcome !== 'applied') {
    const reported = mutation.success
      ? mutation.data.errors.map((error) => error.message).join('; ')
      : ''
    return [
      {
        type: 'json',
        value: {
          artifactPath,
          errorMessage:
            reported || 'Audit findings artifact was not confirmed as written.',
        },
      },
    ]
  }
  const severityCounts = {
    CRITICAL: 0,
    HIGH: 0,
    MEDIUM: 0,
    LOW: 0,
  }
  for (const finding of input.findings) severityCounts[finding.severity]++
  return [
    {
      type: 'json',
      value: {
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
      },
    },
  ]
}

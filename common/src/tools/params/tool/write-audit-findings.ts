import z from 'zod/v4'

import { jsonToolResultSchema } from '../utils'
import { auditCoverageDomainSchema } from './audit-intelligence'

import type { $ToolParams } from '../../constants'

export const auditFindingSeveritySchema = z.enum([
  'CRITICAL',
  'HIGH',
  'MEDIUM',
  'LOW',
])

export const auditFindingDomainSchema = z
  .union([auditCoverageDomainSchema, z.literal('api-abi')])
  .transform((value) =>
    value === 'api-abi' ? ('api-contract' as const) : value,
  )

// Shared rationale for every control/format rejection below (finding text,
// coverage entries, snapshotId): the SDK writer's `singleLine` only collapses
// CR/LF, but the parsed value is echoed verbatim into the `structuralReceipt`
// fields evaluate_audit_coverage consumes, so the whole class — NUL, other
// C0/C1 controls, Unicode format characters, and U+2028/U+2029 — is rejected
// at this boundary instead.

/**
 * Applies that rejection to the finding text fields, but keeps tabs and line
 * breaks: finding prose legitimately wraps and the writer collapses line
 * endings before rendering.
 */
const findingTextSchema = (maxLength: number) =>
  z
    .string()
    .min(1)
    .max(maxLength)
    .regex(
      /^(?:[^\p{Cc}\p{Cf}\u2028\u2029]|[\t\n\r])+$/u,
      'Remove control and Unicode format characters other than tabs and line breaks',
    )

/**
 * Single-line hygiene for the values that name a location: every coverage list
 * entry and `findings[].path`. Trims so the value uniqueness was judged on is
 * the one that reaches the Markdown bullet, the finding heading, and
 * `structuralReceipt`. The length bound is checked on the raw value and
 * non-emptiness on the trimmed one, so a whitespace-only entry cannot trim
 * down to an empty coverage claim.
 */
const coverageEntrySchema = (maxLength: number) =>
  z
    .string()
    .max(maxLength)
    .regex(
      /^[^\p{Cc}\p{Cf}\u2028\u2029]+$/u,
      'Use a single-line coverage entry without tabs, line breaks, or other control characters',
    )
    .transform((value) => value.trim())
    .pipe(z.string().min(1))

export const auditFindingSchema = z.object({
  severity: auditFindingSeveritySchema,
  domain: auditFindingDomainSchema,
  // A finding location is never wrapped prose, so it is held to the same
  // single-line rule as `coverage.files` instead of `findingTextSchema`: a tab
  // or line break here would reach the artifact's finding heading.
  path: coverageEntrySchema(500),
  line: z.number().int().positive().optional(),
  title: findingTextSchema(300),
  risk: findingTextSchema(2_000),
  fix: findingTextSchema(2_000),
  evidence: findingTextSchema(4_000),
})

/**
 * Canonical shape of an audit artifact-path identifier. Exported so callers
 * that echo a rejected identifier (e.g. the SDK writer's error path) validate
 * against this schema instead of re-implementing its charset, length, and
 * dot-segment rules.
 */
export const auditIdentifierSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(
    /^[A-Za-z0-9._-]+$/,
    'Use only letters, digits, dot, underscore, or dash',
  )
  .refine((value) => value !== '.' && value !== '..', {
    message: 'Dot path segments are not valid audit identifiers',
  })

/**
 * Stated verbatim on every field bound by `auditIdentifierSchema`
 * (`sessionSlug`, `shardId`, `snapshotId`): each one becomes a path segment of
 * the runtime-derived artifact path, and the rejection message names no rule,
 * so the charset, length, and dot-segment bounds are only discoverable here.
 */
export const auditIdentifierRule =
  'Accepts only a short identifier token: 1 to 100 characters of letters, digits, dot, underscore, or dash, and neither `.` nor `..` on its own.'

/**
 * Rule fragments the schema states verbatim on the field each one governs.
 * Every parse failure collapses to one generic `Missing or invalid
 * write_audit_findings parameters.` message, so these `.describe()` strings are
 * the only place a rejected caller can learn the rules; they are exported so
 * covering tests pin the rules instead of hand-copied doc substrings.
 */
export const noIssuesFoundRule =
  'Set noIssuesFound=true exactly when findings is empty and false whenever findings is non-empty; any other combination is rejected.'

export const coverageDomainAliasRule =
  'coverage.domains accepts canonical domain ids only, so use api-contract there: the legacy api-abi alias is accepted only in findings[].domain.'

/**
 * The list is optional, but an explicitly empty one is rejected rather than
 * treated as omitted: `[]` would otherwise claim a snapshot-bound call
 * evaluated zero domains while still emitting `structuralReceipt`.
 */
export const coverageDomainsNonEmptyRule =
  'When coverage.domains is present it must name at least one domain: an empty list is rejected rather than treated as an omitted field.'

/**
 * Enforced only on snapshot-bound calls, which are the ones that receive
 * `structuralReceipt`: evaluate_audit_coverage's structural_receipts schema
 * requires non-empty subsystem_ids and files, so an empty list here would
 * yield a receipt that tool rejects — contradicting the composability the
 * description promises. Legacy calls without snapshotId/domains keep parsing.
 */
export const snapshotCoverageCompletenessRule =
  'When snapshotId and coverage.domains are both present the call receives a structuralReceipt, so coverage.subsystemIds and coverage.files must each name at least one entry: evaluate_audit_coverage rejects a receipt whose subsystem_ids or files list is empty.'

/**
 * Enforced on every coverage list: a repeated entry would inflate the
 * artifact's coverage lines, the receipt's counts, and `structuralReceipt`.
 * Duplicates are rejected rather than deduped, and `coverageEntrySchema` trims
 * each entry before uniqueness is judged, so the compared value is the exact
 * value the SDK writer renders into the Markdown bullet and echoes into the
 * receipt: two spellings that would collapse into one identical bullet cannot
 * both be counted.
 */
export const coverageUniquenessRule =
  'Every coverage list must name each entry at most once: a repeated file, subsystemId, featureId, or domain is rejected rather than counted twice. Entries are compared after trimming surrounding whitespace, and the trimmed value is what reaches the artifact and the receipt, so two spellings that differ only in whitespace are the same entry.'

/**
 * Stated on each coverage list instead of repeating `coverageUniquenessRule`
 * there: the rule governs every list, but duplicating its full text per field
 * only inflates the tool schema sent to the model.
 */
export const coverageUniquenessCrossReference =
  'See the coverage description for the uniqueness rule, which applies to this list too.'

/**
 * Applies that rejection to the three string coverage lists. Stated in full on
 * the parent `coverage` object rather than on each list, and restates the trim
 * so a caller reading only that description learns entries are compared after
 * trimming.
 */
export const coverageEntryHygieneRule =
  'Every coverage files, subsystemIds, and featureIds entry must be a single-line value: tabs, carriage returns, newlines, NUL, any other control or Unicode format character, and the U+2028/U+2029 line separators are rejected. Entries are trimmed, and the trimmed value is the one uniqueness is judged on.'

/**
 * Stated on each string coverage list instead of repeating
 * `coverageEntryHygieneRule` three times, for the same schema-size reason as
 * `coverageUniquenessCrossReference`.
 */
export const coverageEntryHygieneCrossReference =
  'See the coverage description for the single-line hygiene rule, which applies to this list too.'

/**
 * Mirrors `coverageEntryHygieneRule` for the finding entries: the two hygiene
 * levels differ (prose wraps, a location does not), and neither is
 * discoverable from the generic rejection message.
 */
export const findingEntryHygieneRule =
  'Each findings entry rejects control and Unicode format characters in title, risk, fix, and evidence — NUL, any other control character, and the U+2028/U+2029 line separators — while still accepting tabs and line breaks in that prose. findings[].path is a location rather than prose, so it must be a single-line value with none of those characters and no tabs or line breaks; it is trimmed, and the trimmed value is the one rendered into the finding heading.'

function hasNoDuplicates(values: readonly string[]): boolean {
  return new Set(values).size === values.length
}

/**
 * Names the offending list in the issue message so any caller path that does
 * surface zod issues points at the rule that failed; the SDK writer collapses
 * every parse failure to one generic message, which is why the same rule is
 * also advertised on `coverage`'s own description.
 */
function uniqueEntries(field: string) {
  return { message: `List each coverage.${field} entry at most once` }
}

const inputSchema = z
  .object({
    sessionSlug: auditIdentifierSchema.describe(
      `Existing durable audit session slug under .agents/sessions/. ${auditIdentifierRule}`,
    ),
    shardId: auditIdentifierSchema.describe(
      `Unique shard identifier used as the findings filename. ${auditIdentifierRule}`,
    ),
    // Bounded with the same schema as the artifact-path identifiers because it
    // is echoed verbatim into `structuralReceipt.snapshot_id`.
    snapshotId: auditIdentifierSchema
      .optional()
      .describe(
        `Exact snapshotId returned by inspect_codebase_structure, such as its 64-character sha256 digest. Required for a directly composable structuralReceipt; omitted only for legacy callers. ${auditIdentifierRule} ${snapshotCoverageCompletenessRule}`,
      ),
    findings: z
      .array(auditFindingSchema)
      .max(100)
      .describe(findingEntryHygieneRule),
    coverage: z
      .object({
        // Both the uniqueness and hygiene rules are enforced on every string
        // coverage list but stated in full on the parent `coverage` object, so
        // these fields only point at them instead of tripling ~60 words of
        // hygiene text into the tool schema.
        subsystemIds: z
          .array(coverageEntrySchema(200))
          .max(100)
          .refine(hasNoDuplicates, uniqueEntries('subsystemIds'))
          .describe(
            `${coverageEntryHygieneCrossReference} ${coverageUniquenessCrossReference}`,
          ),
        featureIds: z
          .array(coverageEntrySchema(200))
          .max(100)
          .refine(hasNoDuplicates, uniqueEntries('featureIds'))
          .describe(
            `${coverageEntryHygieneCrossReference} ${coverageUniquenessCrossReference}`,
          ),
        files: z
          .array(coverageEntrySchema(500))
          .max(500)
          .refine(hasNoDuplicates, uniqueEntries('files'))
          .describe(
            `${coverageEntryHygieneCrossReference} ${coverageUniquenessCrossReference}`,
          ),
        domains: z
          .array(auditCoverageDomainSchema)
          .min(1)
          .refine(hasNoDuplicates, uniqueEntries('domains'))
          .optional()
          .describe(
            `${coverageDomainAliasRule} ${coverageDomainsNonEmptyRule} ${coverageUniquenessCrossReference}`,
          ),
      })
      .describe(`${coverageUniquenessRule} ${coverageEntryHygieneRule}`),
    // Defaults to false so a shard that reports nothing must attest to that
    // explicitly; `noIssuesFoundRule` on the field spells out the accepted
    // combinations, since the rejection message names no rule.
    noIssuesFound: z.boolean().default(false).describe(noIssuesFoundRule),
  })
  .superRefine((input, ctx) => {
    if (input.noIssuesFound !== (input.findings.length === 0)) {
      ctx.addIssue({
        code: 'custom',
        path: ['noIssuesFound'],
        message:
          'Set noIssuesFound=true only when findings is empty; otherwise set it to false.',
      })
    }
    // Only these calls emit `structuralReceipt`, and only the two lists it
    // carries are checked: evaluate_audit_coverage's strict schema requires
    // non-empty subsystem_ids/files and has no featureIds field, so an empty
    // featureIds list still composes.
    if (input.snapshotId && input.coverage.domains) {
      for (const field of ['subsystemIds', 'files'] as const) {
        if (input.coverage[field].length === 0) {
          ctx.addIssue({
            code: 'custom',
            path: ['coverage', field],
            message: `List at least one coverage.${field} entry when snapshotId and coverage.domains are set: evaluate_audit_coverage rejects the resulting structuralReceipt with an empty list`,
          })
        }
      }
    }
  })

export const auditFindingsReceiptSchema = z.object({
  artifactPath: z.string(),
  artifacts: z.array(z.string()).length(1),
  findingCount: z.number().int().nonnegative(),
  severityCounts: z.record(
    auditFindingSeveritySchema,
    z.number().int().nonnegative(),
  ),
  coverage: z.object({
    subsystemCount: z.number().int().nonnegative(),
    featureCount: z.number().int().nonnegative(),
    fileCount: z.number().int().nonnegative(),
  }),
  structuralReceipt: z
    .object({
      schema_version: z.literal(1),
      snapshot_id: z.string(),
      shard_id: z.string(),
      subsystem_ids: z.array(z.string()),
      files: z.array(z.string()),
      domains: z.array(auditCoverageDomainSchema),
    })
    .optional(),
  contentHash: z.string(),
})

export const auditFindingsErrorSchema = z.object({
  errorMessage: z.string(),
  artifactPath: z.string(),
})

const toolName = 'write_audit_findings'

export const writeAuditFindingsParams = {
  toolName,
  endsAgentStep: false,
  description: `Persist one audit shard's structured findings to a runtime-owned Markdown artifact. The path is derived as .agents/sessions/<sessionSlug>/findings/<shardId>.md; callers cannot choose another path. New audit flows must copy the exact inspect_codebase_structure snapshotId into snapshotId and explicitly list every evaluated coverage domain; the result then includes structuralReceipt for direct use with evaluate_audit_coverage. Legacy calls without both fields remain accepted but do not receive that attestation. Every rejection returns one generic message, so read the field descriptions of noIssuesFound and coverage for the rules they enforce. Return only the compact receipt after writing—do not repeat findings in prose.`,
  inputSchema,
  outputSchema: jsonToolResultSchema(
    z.union([auditFindingsReceiptSchema, auditFindingsErrorSchema]),
  ),
} satisfies $ToolParams

export type AuditFindingsInput = z.infer<typeof inputSchema>

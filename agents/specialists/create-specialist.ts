import { publisher } from '../constants'

import type { SecretAgentDefinition } from '../types/secret-agent-definition'

type SpecialistConfig = {
  id: string
  displayName: string
  purpose: string
  focus: string[]
  terminal?: boolean
  advisory?: boolean
  intelligence?: Array<'environment' | 'tests' | 'builds' | 'audit'>
}

const MAX_REVIEWED_FILES = 200
const MAX_FINDINGS = 20
const MAX_REQUIREMENTS = 100
const MAX_EVIDENCE_ITEMS = 8
const MAX_PATH_LENGTH = 1_000
const MAX_TEXT_LENGTH = 2_000

const boundedString = (maxLength = MAX_TEXT_LENGTH) => ({
  type: 'string' as const,
  maxLength,
})

const boundedStringArray = (maxItems = MAX_EVIDENCE_ITEMS) => ({
  type: 'array' as const,
  maxItems,
  items: boundedString(),
})

export function createSpecialist(
  config: SpecialistConfig,
): SecretAgentDefinition {
  const dimensionKeys = config.focus.map((item) =>
    item
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, ''),
  )
  const findingSchema = {
    type: 'object' as const,
    properties: {
      id: {
        ...boundedString(240),
        description: `Stable ID formatted as ${config.id}:<dimension>:<slug>.`,
      },
      severity: {
        type: 'string' as const,
        enum: ['critical', 'high', 'medium', 'low'],
      },
      dimension: { type: 'string' as const, enum: dimensionKeys },
      summary: boundedString(),
      evidence: boundedStringArray(),
      correction: boundedString(),
    },
    required: [
      'id',
      'severity',
      'dimension',
      'summary',
      'evidence',
      'correction',
    ],
  }
  const dimensionsSchema = {
    type: 'object' as const,
    properties: Object.fromEntries(
      dimensionKeys.map((dimension) => [
        dimension,
        {
          type: 'string' as const,
          enum: ['pass', 'warning', 'block', 'not_applicable'],
        },
      ]),
    ),
    required: dimensionKeys,
  }
  return {
    id: config.id,
    publisher,
    displayName: config.displayName,
    spawnerPrompt: config.advisory
      ? config.purpose
      : `${config.purpose} Requires params.snapshot_id with the assigned gate snapshot fingerprint for this spawn.`,
    inputSchema: {
      prompt: {
        type: 'string',
        description: 'The exact scoped question or review task.',
      },
      params: {
        type: 'object',
        properties: {
          files: {
            type: 'array',
            maxItems: MAX_REVIEWED_FILES,
            items: boundedString(MAX_PATH_LENGTH),
            description: 'Exact files in scope.',
          },
          snapshot_id: {
            type: 'string',
            maxLength: 512,
            // Non-advisory spawns require a gate-assigned v3 token. Advisory
            // may omit the field; do not apply the pattern when optional so an
            // empty advisory value is not forced into a hard schema reject.
            ...(config.advisory ? {} : { pattern: '^v3:[a-f0-9]{64}$' }),
            description: config.advisory
              ? 'Optional assigned gate snapshot fingerprint for this spawn — when present, the gate-assigned opaque v3:… token from the parent gate (not bare hex from get_change_review_bundle.snapshotId). Echo it exactly as snapshotFingerprint.'
              : 'Required assigned gate snapshot fingerprint for this spawn — gate-assigned opaque v3:<64-hex> token from the parent gate (params.snapshot_id / specialistCreditFingerprint), not bare hex from get_change_review_bundle.snapshotId. Echo it exactly as snapshotFingerprint; do not invent a different value.',
          },
          command: {
            type: 'string',
            maxLength: 4_000,
            description:
              'Optional bounded diagnostic command for terminal-enabled specialists.',
          },
        },
        required: config.advisory ? [] : ['snapshot_id'],
      },
    },
    outputMode: 'structured_output',
    outputSchema: config.advisory
      ? {
          type: 'object',
          properties: {
            schemaVersion: { type: 'number' },
            family: { type: 'string', enum: ['advisory'] },
            snapshotFingerprint: boundedString(512),
            reviewedFiles: {
              type: 'array',
              maxItems: MAX_REVIEWED_FILES,
              items: boundedString(MAX_PATH_LENGTH),
            },
            dimensions: dimensionsSchema,
            findings: {
              type: 'array',
              maxItems: MAX_FINDINGS,
              items: findingSchema,
            },
            recommendations: boundedStringArray(20),
            evidence: boundedStringArray(20),
          },
          required: [
            'schemaVersion',
            'family',
            'reviewedFiles',
            'dimensions',
            'findings',
            'recommendations',
            'evidence',
          ],
        }
      : {
          type: 'object',
          properties: {
            schemaVersion: { type: 'number' },
            family: { type: 'string', enum: ['reviewer'] },
            verdict: {
              type: 'string',
              enum: ['LOOKS_GOOD', 'NON_BLOCKING', 'BLOCKING'],
            },
            snapshotFingerprint: boundedString(512),
            reviewedFiles: {
              type: 'array',
              maxItems: MAX_REVIEWED_FILES,
              items: boundedString(MAX_PATH_LENGTH),
            },
            coverage: {
              type: 'string',
              enum: ['covered', 'missing', 'n/a'],
            },
            dimensions: dimensionsSchema,
            findings: {
              type: 'array',
              maxItems: MAX_FINDINGS,
              items: findingSchema,
            },
            requirementCoverage: {
              type: 'array',
              maxItems: MAX_REQUIREMENTS,
              items: {
                type: 'object',
                properties: {
                  requirement: boundedString(),
                  status: {
                    type: 'string',
                    enum: ['satisfied', 'missing', 'uncertain'],
                  },
                  evidence: boundedStringArray(),
                },
                required: ['requirement', 'status', 'evidence'],
              },
            },
          },
          required: [
            'schemaVersion',
            'family',
            'verdict',
            'snapshotFingerprint',
            'reviewedFiles',
            'coverage',
            'dimensions',
            'findings',
            'requirementCoverage',
          ],
        },
    includeMessageHistory: false,
    toolNames: [
      'read_files',
      'read_outline',
      'code_search',
      'inspect_workspace',
      'get_task',
      'get_change_review_bundle',
      ...(config.intelligence?.includes('environment')
        ? (['inspect_environment'] as const)
        : []),
      ...(config.intelligence?.includes('tests')
        ? (['get_affected_tests'] as const)
        : []),
      ...(config.intelligence?.includes('builds')
        ? (['get_build_targets'] as const)
        : []),
      ...(config.intelligence?.includes('audit')
        ? ([
            'inspect_codebase_structure',
            'inspect_feature_completeness',
          ] as const)
        : []),
      ...(config.terminal ? (['run_terminal_command'] as const) : []),
      'set_output',
    ],
    terminalPermissionProfile: config.terminal ? 'read-only' : undefined,
    spawnableAgents: [],
    systemPrompt: `You are the ${config.displayName} specialist. You make source-backed judgments within a narrow contract and never invent validation, approvals, or filesystem state.`,
    instructionsPrompt: [
      config.advisory
        ? 'Read the exact current sources and task state. A snapshot_id is optional for pre-edit advisory work; when supplied, it is the assigned gate snapshot fingerprint for this spawn — echo it exactly as snapshotFingerprint and do not invent a different value or re-validate against a live bundle that may have moved.'
        : 'params.snapshot_id is the authoritative assigned snapshot for this review spawn (opaque v3:… gate-assigned token from the parent gate — not the bare hex snapshotId from get_change_review_bundle). Echo that exact value as snapshotFingerprint. You may use get_change_review_bundle as read-only evidence (file list/diff/empty-tree check); if a fresh call returns a different bare id, keep reviewing against params.snapshot_id and echo params.snapshot_id — do not emit stale-snapshot solely because the live bundle moved. List the exact normalized project-relative paths you read. Stale-snapshot BLOCKING is only for: missing/empty snapshot_id, inventing a different fingerprint, or inability to read the assigned files — not live-bundle drift during review.',
      config.advisory
        ? 'Return family=advisory. Your output is design/coordination evidence; do not invent a blocking gate verdict and do not mutate files or external systems.'
        : 'Return family=reviewer. Any material issue requiring a code or contract change is BLOCKING. Only enumerate requirementCoverage for in-scope review requirements this specialist can judge from source/diff evidence; omit parent/orchestrator workflow (git rewrite, validation runs, commit/push, CI green). Never mark those missing/uncertain.',
      'Focus areas:',
      ...config.focus.map((item) => `- ${item}`),
      config.terminal
        ? 'Use only the tools exposed for this specialist. run_terminal_command is available only for the optional bounded diagnostic command; do not call a basher agent.'
        : 'Use only the tools exposed for this specialist. Do not call basher or run terminal validation; if runtime evidence is required, report the exact missing evidence for the parent to collect.',
      `Use these exact dimension keys: ${dimensionKeys.join(', ')}. Every finding ID must be stable and formatted ${config.id}:<dimension>:<slug>; include severity, concrete evidence, and an actionable correction. Only emit findings that require a concrete code or contract change; do not emit informational observations about intended or documented behavior (e.g. 'this is the intended scope, not a defect'). Deleting mocks, fixtures, test doubles, stubs, or other test-only scaffolding is intended cleanup, not a defect: do not emit any finding (of any severity) solely because such a file was deleted; only flag a deletion when production source or a genuine public contract was removed without cleaning up its references. Keep the result compact: at most ${MAX_FINDINGS} findings and ${MAX_EVIDENCE_ITEMS} evidence items per finding. Snapshot/file-attestation protocol failures (missing/empty snapshot_id, invented fingerprint, or inability to read assigned files) are not source findings; report a stale-snapshot finding and do not invent a repair. Do not treat live get_change_review_bundle drift as stale-snapshot. Call set_output with a JSON object directly; never JSON.stringify the object or wrap it in a string. Return the required structured output and do not modify files.`,
    ].join('\n'),
  }
}

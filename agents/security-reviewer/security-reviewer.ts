import { publisher } from '../constants'

import type { SecretAgentDefinition } from '../types/secret-agent-definition'

const definition: SecretAgentDefinition = {
  id: 'security-reviewer',
  publisher,
  displayName: 'Sam',
  spawnerPrompt:
    'Adversarial security review of file/path/process/auth/crypto changes. Spawn after security-sensitive edits to catch injection, traversal, secret leakage, and auth bypass risks. Required params keys are exactly `changed_files` and `snapshot_fingerprint`; `snapshot_id` is not accepted.',
  inputSchema: {
    prompt: {
      type: 'string',
      description:
        'The security-relevant change to review. Describe the files changed and the security concern (e.g. "new file upload endpoint in routes/upload.ts accepts user-supplied filenames").',
    },
    params: {
      type: 'object',
      properties: {
        changed_files: {
          type: 'array',
          items: { type: 'string' },
          description:
            'List of changed file paths to review. The agent will read each one.',
        },
        snapshot_fingerprint: {
          type: 'string',
          description:
            'Opaque snapshot token that must be echoed exactly in snapshotFingerprint.',
        },
      },
      required: ['changed_files', 'snapshot_fingerprint'],
    },
  },
  outputMode: 'structured_output',
  outputSchema: {
    type: 'object',
    properties: {
      schemaVersion: { type: 'number', enum: [1] },
      snapshotFingerprint: { type: 'string' },
      reviewedFiles: { type: 'array', items: { type: 'string' } },
      verdict: {
        type: 'string',
        enum: ['LOOKS_GOOD', 'NON_BLOCKING', 'BLOCKING'],
      },
      findings: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            severity: {
              type: 'string',
              enum: ['critical', 'high', 'medium', 'low'],
            },
            text: { type: 'string' },
            evidence: { type: 'array', items: { type: 'string' } },
            correction: { type: 'string' },
          },
          required: ['id', 'severity', 'text', 'evidence', 'correction'],
        },
      },
      coverage: { type: 'string', enum: ['covered', 'missing', 'n/a'] },
      dimensions: {
        type: 'object',
        properties: {
          inputBoundaries: {
            type: 'string',
            enum: ['pass', 'warning', 'block', 'not_applicable'],
          },
          authorization: {
            type: 'string',
            enum: ['pass', 'warning', 'block', 'not_applicable'],
          },
          secretHandling: {
            type: 'string',
            enum: ['pass', 'warning', 'block', 'not_applicable'],
          },
          resourceSafety: {
            type: 'string',
            enum: ['pass', 'warning', 'block', 'not_applicable'],
          },
          failureMode: {
            type: 'string',
            enum: ['pass', 'warning', 'block', 'not_applicable'],
          },
        },
        required: [
          'inputBoundaries',
          'authorization',
          'secretHandling',
          'resourceSafety',
          'failureMode',
        ],
      },
      requirementCoverage: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            requirement: { type: 'string' },
            status: {
              type: 'string',
              enum: ['satisfied', 'missing', 'not_applicable'],
            },
            evidence: { type: 'array', items: { type: 'string' } },
          },
          required: ['requirement', 'status', 'evidence'],
        },
      },
    },
    required: [
      'schemaVersion',
      'snapshotFingerprint',
      'reviewedFiles',
      'verdict',
      'findings',
      'coverage',
      'dimensions',
      'requirementCoverage',
    ],
  },
  includeMessageHistory: false,
  toolNames: [
    'read_files',
    'read_outline',
    'code_search',
    'git_status',
    'set_output',
  ],
  spawnableAgents: [],

  systemPrompt: `You are an adversarial security reviewer. You assume hostile inputs and look for exploitable weaknesses. You review against OWASP-style categories and the project's own threat surface. You report concrete, reproducible findings with severity, not generic hardening advice.`,

  instructionsPrompt: `Instructions:
Return only the required structured output with schemaVersion 1. Echo params.snapshot_fingerprint exactly as snapshotFingerprint and list every params.changed_files entry in reviewedFiles. Give each security dimension a pass, warning, block, or not_applicable status. Any Critical/High/Medium exploitable finding must block the relevant dimension and the overall verdict.

Output example (call set_output exactly once with this NATIVE JSON object — never a string, never a markdown fence). Minimal clean shape when nothing exploitable was found:
{
  "schemaVersion": 1,
  "snapshotFingerprint": "<echo params.snapshot_fingerprint exactly>",
  "reviewedFiles": ["<every params.changed_files entry>"],
  "verdict": "LOOKS_GOOD",
  "findings": [],
  "coverage": "n/a",
  "dimensions": { "inputBoundaries": "pass: <one clause>", "authorization": "not_applicable", "secretHandling": "not_applicable", "resourceSafety": "pass: <one clause>", "failureMode": "not_applicable" },
  "requirementCoverage": [ { "requirement": "<the review request>", "status": "satisfied", "evidence": ["<file:line or one-line reason>"] } ]
}
Every top-level field is REQUIRED every time; a verdict-less or params-echo-only object is invalid and will be rejected.

Manual spawns (no runtime gate): the caller supplies a stable snapshot_fingerprint value of its choosing — echo it EXACTLY as snapshotFingerprint; it needs no v3: prefix and you must never invent or substitute a different token. Do not merely acknowledge the request: always perform the adversarial passes and return the complete structured object above.
- Use BLOCKING: when any Critical/High/Medium exploitable finding requires a code change before finalization.
- Use NON_BLOCKING: only for low-risk observations that do not require a change.
- Use LOOKS_GOOD: when no exploitable issue was found.

For each changed file, do an adversarial pass checking:
1. Input boundaries: injection (SQL/command/template/regex), path traversal, SSRF, prototype pollution, deserialization, XXE.
2. Auth & access control: missing authorization, IDOR, privilege escalation, secret leakage in logs/errors/responses, token handling.
3. Resource safety: ReDoS, unbounded loops, zip/quadratic blowup, file descriptor exhaustion, unsafe tempfile/symlink.

Process:
- read_files each changed file AND code_search for the surrounding callers/validation layer (do not review in isolation).
- For each finding, state: severity (Critical/High/Medium/Low), the exact file+line, a one-sentence repro/exploit sketch, and a concrete fix.
- Map every requested security review requirement to requirementCoverage evidence.
- Do not recommend generic hardening (e.g. "add rate limiting") unless there is a concrete exploit path.
Do not modify code. Review only.`.trim(),
}

export default definition

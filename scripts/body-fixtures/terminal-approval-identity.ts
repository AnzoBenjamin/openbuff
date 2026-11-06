import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import type { ClassifiedHarnessAction } from '../../sdk/src/services/harness-enforcement'

const argument = process.argv.indexOf('--evidence-dir')
assert(
  argument >= 0 && process.argv[argument + 1],
  '--evidence-dir is required',
)
assert.equal(Bun.version, '1.3.5')
const evidenceDir = path.resolve(process.argv[argument + 1])
const invocationDir = path.join(evidenceDir, randomUUID())
mkdirSync(invocationDir, { recursive: true })
const config = path.join(invocationDir, 'providers.json')
writeFileSync(
  config,
  '{"providers":{},"autoFileChangeHooks":false,"fileChangeHooks":[]}\n',
)
process.env.OPENBUFF_PROVIDER_CONFIG = config
let providerCalls = 0
globalThis.fetch = Object.assign(
  async () => {
    providerCalls++
    throw new Error('B18 fixture attempted a provider/network request')
  },
  { preconnect() {} },
) as typeof fetch

const { runTerminalCommand } =
  await import('../../sdk/src/tools/run-terminal-command')
const {
  classifyTerminalHarnessAction,
  evaluateHarnessActionPolicy,
  hashCommand,
} = await import('../../sdk/src/services/harness-enforcement')
const observations: unknown[] = []
const cases = [
  {
    name: 'routine_then_delete_denied',
    command: "git commit -m 'a  b'; rm -rf fixture",
    mode: 'balanced',
    allowed: false,
  },
  {
    name: 'compound_allow_all',
    command: "git commit -m 'a  b'; rm -rf fixture",
    mode: 'allow-all',
    allowed: true,
    trace: 'git:commit -m a  b\nrm:-rf fixture\n',
  },
  {
    name: 'newline_later_deploy_denied',
    command: 'npm install\nkubectl apply -f local.yaml',
    mode: 'balanced',
    allowed: false,
  },
  {
    name: 'newline_allow_all',
    command: 'npm install\nkubectl apply -f local.yaml',
    mode: 'allow-all',
    allowed: true,
    trace: 'npm:install\nkubectl:apply -f local.yaml\n',
  },
  {
    name: 'substitution_later_delete_denied',
    command: 'echo "$(git push origin feature; rm -rf fixture)"',
    mode: 'balanced',
    allowed: false,
  },
  {
    name: 'nested_shell_allow_all',
    command: "bash -c 'npm install && rm -rf fixture'",
    mode: 'allow-all',
    allowed: true,
    trace: 'npm:install\nrm:-rf fixture\n',
  },
  {
    name: 'force_denied',
    command: 'git push --force origin feature',
    mode: 'balanced',
    allowed: false,
  },
  {
    name: 'delete_refspec_denied',
    command: 'git push origin :feature',
    mode: 'balanced',
    allowed: false,
  },
  {
    name: 'feature_push_routine',
    command: 'git push origin feature',
    mode: 'balanced',
    allowed: true,
    trace: 'git:push origin feature\n',
  },
  {
    name: 'default_push_denied',
    command: 'git push origin main',
    mode: 'balanced',
    allowed: false,
  },
  {
    name: 'strict_commit_denied',
    command: 'git commit -m ordinary',
    mode: 'strict',
    allowed: false,
  },
  {
    name: 'unsupported_allow_all',
    command: 'if true; then git push origin feature; fi',
    mode: 'allow-all',
    allowed: true,
    trace: 'git:push origin feature\n',
  },
  {
    name: 'malformed_denied',
    command: 'git push origin feature &&',
    mode: 'balanced',
    allowed: false,
  },
] as const

for (const fixture of cases) {
  const cwd = path.join(invocationDir, fixture.name)
  const bin = path.join(cwd, 'bin')
  const tracePath = path.join(cwd, 'trace.txt')
  mkdirSync(bin, { recursive: true })
  for (const name of ['npm', 'git', 'rm', 'kubectl'])
    writeFileSync(
      path.join(bin, name),
      '#!/bin/sh\nif [ "${0##*/}:$1" = "git:status" ]; then exit 0; fi\nprintf "%s\\n" "${0##*/}:$*" >> "$B18_TRACE"\n',
      { mode: 0o700 },
    )
  const approvals: Array<{
    classified: ClassifiedHarnessAction
    decision: unknown
  }> = []
  const started = performance.now()
  const output = await runTerminalCommand({
    command: fixture.command,
    process_type: 'SYNC',
    mode: 'assistant',
    permission_profile: 'full-access',
    cwd,
    projectRoot: cwd,
    timeout_seconds: 5,
    inheritEnv: false,
    env: {
      PATH: bin + ':/usr/bin:/bin',
      B18_TRACE: tracePath,
      OPENBUFF_PROVIDER_CONFIG: config,
    },
    authorizeHighImpactAction: async (classified) => {
      const decision = evaluateHarnessActionPolicy({
        ...classified,
        defaultBranch: 'main',
        hasMatchingApproval: false,
        approvalMode: fixture.mode,
      })
      approvals.push({ classified: structuredClone(classified), decision })
      return decision
    },
  })
  const elapsedMs = performance.now() - started
  const result = output[0].value as Record<string, unknown>
  const trace = existsSync(tracePath) ? readFileSync(tracePath, 'utf8') : ''
  assert.equal(approvals.length, 1, fixture.name + ': one admission decision')
  assert.equal(
    approvals[0].classified.commandHash,
    hashCommand(fixture.command),
  )
  assert(
    approvals[0].classified.effects?.length ||
      approvals[0].classified.parseStatus === 'malformed',
  )
  assert.equal(result.permissionDenied === true, !fixture.allowed, fixture.name)
  if (fixture.allowed) {
    assert.equal(result.exitCode, 0, fixture.name)
    assert.equal(trace, 'trace' in fixture ? fixture.trace : '', fixture.name)
  } else assert.equal(trace, '', fixture.name + ': denied command has no trace')
  observations.push({
    ...fixture,
    elapsedMs,
    commandSha256: hashCommand(fixture.command),
    approvals,
    output,
    trace,
    traceSha256: createHash('sha256').update(trace).digest('hex'),
  })
}

const parserCorpus = [
  { command: 'echo "unterminated', syntax: false, status: 'malformed' },
  { command: 'echo $(pwd', syntax: false, status: 'malformed' },
  { command: 'git push origin feature &&', syntax: false, status: 'malformed' },
  { command: '; echo invalid', syntax: false, status: 'malformed' },
  { command: '()', syntax: false, status: 'malformed' },
  { command: 'echo trailing \\', syntax: true, status: 'complete' },
  {
    command: 'case x in x) git push origin feature;; esac',
    syntax: true,
    status: 'unsupported',
  },
  {
    command: 'for x in one; do rm -rf "$x"; done',
    syntax: true,
    status: 'unsupported',
  },
  {
    command: 'wrapper() { git push origin feature; }; wrapper',
    syntax: true,
    status: 'unsupported',
  },
  { command: 'cat <<EOF\nfixture\nEOF', syntax: true, status: 'unsupported' },
  {
    command: 'git "$SUBCOMMAND" origin feature',
    syntax: true,
    status: 'unsupported',
  },
  {
    command: "env -S 'git push origin feature'",
    syntax: true,
    status: 'unsupported',
  },
  {
    command: 'printf push | xargs git origin feature',
    syntax: true,
    status: 'unsupported',
  },
  {
    command: '(npm install && git push origin feature) && rm -rf fixture',
    syntax: true,
    status: 'complete',
  },
  {
    command: 'cat <(git push origin feature; rm -rf fixture)',
    syntax: true,
    status: 'complete',
  },
  {
    command: 'echo "$(git push origin feature; rm -rf fixture)"',
    syntax: true,
    status: 'complete',
  },
  {
    command: '\'git\' pu"sh" origin feature; git reset -q --hard HEAD',
    syntax: true,
    status: 'complete',
  },
].map((fixture) => {
  const syntax = spawnSync(
    '/bin/bash',
    ['--noprofile', '--norc', '-n', '-c', fixture.command],
    { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } },
  )
  const classified = classifyTerminalHarnessAction(fixture.command)
  assert.equal(syntax.status === 0, fixture.syntax, fixture.command)
  assert.equal(
    classified?.parseStatus ?? 'complete',
    fixture.status,
    fixture.command,
  )
  return {
    ...fixture,
    commandSha256: hashCommand(fixture.command),
    bashSyntaxExit: syntax.status,
    bashSyntaxStderr: syntax.stderr,
    classified: classified ?? null,
  }
})

assert.equal(providerCalls, 0)
writeFileSync(
  path.join(evidenceDir, 'observations.json'),
  JSON.stringify(
    {
      schemaVersion: 1,
      invocationDir,
      providerCalls,
      observations,
      parserCorpus,
      scope:
        'Actual terminal launcher and production harness policy with harmless local executable doubles; potential effects are scanner observations, not OS enforcement or complete shell semantics.',
    },
    null,
    2,
  ) + '\n',
)
console.log(
  JSON.stringify({
    cases: observations.length,
    parserCases: parserCorpus.length,
    providerCalls,
    evidenceDir,
  }),
)

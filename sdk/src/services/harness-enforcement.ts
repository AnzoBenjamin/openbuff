import { createHash, randomUUID } from 'node:crypto'

import { LocalHarnessStore } from './local-harness-store'

import type { LocalHarnessRecord } from './local-harness-store'

type RecordScope = {
  repositoryId: string
  workspaceId: string
  runId: string
  snapshotId: string
}

export type HarnessApprovalMode = 'balanced' | 'strict' | 'allow-all'

export type ApprovalRecord = LocalHarnessRecord & {
  action: string
  target: string
  commandHash: string
  grantedBy: 'user'
  expiresAt?: string
  consumedAt?: string
}

export type OwnershipRecord = LocalHarnessRecord & {
  transactionId: string
  agentRole: string
  findingsAddressed: string[]
  requirementsAddressed: string[]
  changes: Array<{
    path: string
    ownership: 'pre-existing' | 'agent' | 'mixed' | 'generated'
    beforeHash?: string
    afterHash?: string
  }>
}

function now(): string {
  return new Date().toISOString()
}

export class HarnessApprovalService {
  constructor(private readonly store: LocalHarnessStore) {}

  grant(
    scope: RecordScope,
    params: {
      action: string
      target: string
      commandHash: string
      expiresAt?: string
    },
  ): ApprovalRecord {
    const timestamp = now()
    return this.store.put('approvals', {
      schemaVersion: 1,
      id: `approval-${randomUUID()}`,
      revision: 0,
      ...scope,
      createdAt: timestamp,
      updatedAt: timestamp,
      action: params.action,
      target: params.target,
      commandHash: params.commandHash,
      grantedBy: 'user',
      ...(params.expiresAt ? { expiresAt: params.expiresAt } : {}),
    }) as ApprovalRecord
  }

  consume(params: {
    repositoryId: string
    workspaceId: string
    runId: string
    approvalId: string
    action: string
    target: string
    commandHash: string
    snapshotId: string
  }): ApprovalRecord {
    // Race fix: read + consume must be one critical section. The read outside
    // the lock plus the CAS'd put inside it is safe against lost updates, but
    // a parallel consumer that reads between the two steps observes a live
    // approval and then fails with a raw revision-conflict error instead of
    // the documented single-use semantics. Holding the kind lock for the whole
    // read-modify-write serializes consumers so exactly one consume wins.
    return this.store.withKindLock(params.repositoryId, 'approvals', () => {
      const existing = this.store.read(
        params.repositoryId,
        'approvals',
        params.approvalId,
      ) as ApprovalRecord | undefined
      if (!existing) throw new Error('Approval not found.')
      if (existing.consumedAt) throw new Error('Approval was already consumed.')
      if (existing.expiresAt) {
        // Fail closed on a malformed expiresAt: `Date.parse` returns NaN for
        // non-ISO garbage, and a bare `NaN <= Date.now()` comparison would be
        // false, silently keeping the approval live forever.
        const expiresAtMs = Date.parse(existing.expiresAt)
        if (Number.isNaN(expiresAtMs) || expiresAtMs <= Date.now()) {
          throw new Error('Approval has expired.')
        }
      }
      if (
        existing.action !== params.action ||
        existing.target !== params.target ||
        existing.commandHash !== params.commandHash ||
        existing.workspaceId !== params.workspaceId ||
        existing.runId !== params.runId ||
        existing.snapshotId !== params.snapshotId
      ) {
        throw new Error('Approval scope does not match the requested action.')
      }
      return this.store.put(
        'approvals',
        {
          ...existing,
          revision: existing.revision + 1,
          updatedAt: now(),
          consumedAt: now(),
        },
        existing.revision,
      ) as ApprovalRecord
    })
  }
}

export type ClassifiedHarnessAction = {
  action:
    | 'dependency-install'
    | 'commit'
    | 'migration'
    | 'push'
    | 'pull-request'
    | 'release'
    | 'deploy'
    | 'external-network'
    | 'arbitrary-code'
    | 'workspace-delete'
    // Client-origin MCP tool approval (P1-T2). Never RETURNED by
    // `classifyTerminalHarnessAction`; used only so the `HarnessApprovalRequest`
    // built for a client MCP tool call typechecks against this union.
    | 'mcp-tool'
  target: string
  branch?: string
  commandHash: string
}

export type HarnessApprovalRequest = ClassifiedHarnessAction & {
  reason: string
  risk: 'routine' | 'high'
}

function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, ' ')
}

/**
 * Stable sha256 hex of the normalized command. Used to bind an approval to the
 * EXACT command it was granted for, so an approval for one command can never
 * authorize a different command that classifies to the same action+target.
 */
export function hashCommand(command: string): string {
  return createHash('sha256').update(normalizeCommand(command)).digest('hex')
}

/**
 * Classifies one already-split command segment against the recognized
 * high-impact shapes below.
 */
function classifySingleSegment(
  segment: string,
): Omit<ClassifiedHarnessAction, 'commandHash'> | undefined {
  const command = segment
  const push = command.match(/^git\s+push(?:\s+(.+))?$/i)
  if (push) {
    const args =
      push[1]
        ?.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)
        ?.map((value) => value.replace(/^["']|["']$/g, '')) ?? []
    const positional = args.filter((value) => !value.startsWith('-'))
    const remote = positional[0]
    const refspec = positional[1]
    const remoteRef = refspec?.includes(':')
      ? refspec.slice(refspec.lastIndexOf(':') + 1)
      : refspec
    const branch =
      remoteRef && !/^(?:HEAD|@\{-?\d+\})$/i.test(remoteRef)
        ? remoteRef.replace(/^\+/, '').replace(/^refs\/heads\//, '')
        : undefined
    const simplePush = args.every(
      (value) =>
        value === '-u' || value === '--set-upstream' || !value.startsWith('-'),
    )
    return {
      action: 'push',
      target: simplePush && remote && branch ? `${remote}/${branch}` : command,
      ...(branch ? { branch } : {}),
    }
  }
  if (/^git\s+commit\b/i.test(command)) {
    return { action: 'commit', target: command }
  }
  if (
    /^git\s+reset\s+--hard\b/i.test(command) ||
    /^git\s+clean\b[\s\S]*-[^\s]*[fd]/i.test(command) ||
    /^git\s+checkout\s+--\b/i.test(command)
  ) {
    return { action: 'workspace-delete', target: command }
  }
  if (/^git\s+restore\b/i.test(command)) {
    // Worktree-mutating restore is destructive; pure --staged unstage is not.
    const mutatesWorktree =
      /(?:--worktree\b|-W\b|--source\b|--overlay\b|--patch\b|(?:^|\s)-p(?:\s|$))/i.test(
        command,
      ) || !/--staged\b/i.test(command)
    if (mutatesWorktree) {
      return { action: 'workspace-delete', target: command }
    }
  }
  if (
    /^gh\s+pr\s+(?:create|merge|close|reopen|ready|review)\b/i.test(command)
  ) {
    return { action: 'pull-request', target: command }
  }
  if (
    /^(?:(?:npm|pnpm|yarn|bun)\s+(?:install|add|remove|update)|pnpm\s+--filter\s+\S+\s+(?:install|add|remove|update)|yarn\s+workspace\s+\S+\s+(?:add|remove|upgrade)|bun\s+--filter\s+\S+\s+(?:install|add|remove|update)|(?:uv|poetry)\s+(?:add|remove|sync|install|update)|pip3?\s+(?:install|uninstall)|cargo\s+(?:add|rm|remove|fetch|update)|go\s+(?:get|mod\s+(?:tidy|download))|dotnet\s+(?:restore|(?:add|remove)\s+package)|(?:bundle|bundler)\s+(?:add|remove|install|update)|composer\s+(?:require|remove|install|update)|swift\s+package\s+(?:resolve|update)|(?:dart|flutter)\s+pub\s+(?:add|remove|get|upgrade)|mix\s+deps\.(?:get|update)|(?:mvn|mvnw|\.\/mvnw)\s+(?:dependency:resolve|dependency:go-offline)|(?:gradle|gradlew|\.\/gradlew)\s+(?:dependencies|buildEnvironment))\b/i.test(
      command,
    )
  ) {
    return { action: 'dependency-install', target: command }
  }
  if (
    /\b(?:prisma\s+migrate|knex\s+migrate|sequelize\s+db:migrate|rails\s+db:migrate|alembic\s+upgrade|flyway\s+migrate|liquibase\s+update)\b/i.test(
      command,
    )
  ) {
    return { action: 'migration', target: command }
  }
  if (
    /^(?:(?:npm|pnpm|yarn|bun)\s+publish|cargo\s+publish|gh\s+release\s+(?:create|delete|edit|upload)|git\s+tag\b)/i.test(
      command,
    )
  ) {
    return { action: 'release', target: command }
  }
  if (
    /^(?:kubectl|helm|terraform|tofu|ansible|aws|gcloud|az|flyctl|vercel|heroku)\b/i.test(
      command,
    ) ||
    /^(?:docker|podman)\s+(?:push|login|run|compose\s+up|system\s+prune)\b/i.test(
      command,
    ) ||
    /^gh\s+(?:workflow\s+run|repo\s+(?:create|delete)|api\b[\s\S]*(?:-X|--method)\s+(?:POST|PUT|PATCH|DELETE))\b/i.test(
      command,
    )
  ) {
    return { action: 'deploy', target: command }
  }
  if (
    /^(?:ssh|scp|sftp|ftp|telnet|nc|ncat)\b/i.test(command) ||
    /^(?:curl|wget)\b[\s\S]*(?:--data(?:-binary)?|-d\b|--form|-F\b|--upload-file|-T\b|--post-data)\b/i.test(
      command,
    )
  ) {
    return { action: 'external-network', target: command }
  }
  // Interpreter one-liners and detached process wrappers only — not ordinary
  // pipelines, $(...) / backticks, or trailing background `&`.
  if (
    /^(?:(?:node|bun|deno)\s+(?:-e|--eval)|python(?:3)?\s+-c|ruby\s+-e|perl\s+-e)\b/i.test(
      command,
    ) ||
    /^(?:nohup|setsid)\b/i.test(command)
  ) {
    return { action: 'arbitrary-code', target: command }
  }
  const deletion = command.match(
    /^(?:(?:command|exec)\s+)?rm\s+-[^\n]*r[^\n]*\s+(.+)$/i,
  )
  if (deletion) {
    return { action: 'workspace-delete', target: deletion[1].trim() }
  }
  if (
    /^find\b[\s\S]*(?:-delete\b|-exec(?:dir)?\b|-ok(?:dir)?\b)/i.test(command)
  ) {
    return { action: 'workspace-delete', target: command }
  }
  return undefined
}

/**
 * Option flags of transparent wrappers that consume a separate value token
 * (e.g. `sudo -u root git push` strips `sudo -u root `, `nice -n 5 npm
 * install` strips `nice -n 5 `, `timeout -k 5 30 git push` strips `-k 5 `).
 */
const WRAPPER_OPTION_VALUES: Record<string, ReadonlySet<string>> = {
  env: new Set(['u']),
  timeout: new Set(['k', 's']),
  nice: new Set(['n']),
  sudo: new Set([
    'u',
    'g',
    'p',
    'h',
    'C',
    'D',
    'R',
    'T',
    't',
    'U',
    'a',
    'B',
    'K',
  ]),
  doas: new Set(['u', 'a']),
  xargs: new Set(['n', 'I', 's', 'P', 'L', 'E', 'a']),
}

/**
 * Deepest shell-interpreter/`eval` unwrapping recursion allowed before
 * classification fails closed to `arbitrary-code`. Bounds the work an
 * adversarially nested `bash -c "bash -c ..."` payload can force.
 */
const MAX_WRAPPER_DEPTH = 3

/**
 * Normalizes one command segment (stripping grouping braces, env assignments,
 * and transparent wrapper prefixes such as `sudo`/`env`/`timeout`/`nice`, and
 * classifying through shell-interpreter wrappers like `bash -c`/`eval`) and
 * classifies it. `nohup`/`setsid` are deliberately NOT stripped: they run
 * arbitrary code.
 */
function classifySegment(
  segment: string,
  depth = 0,
): Omit<ClassifiedHarnessAction, 'commandHash'> | undefined {
  const wrappedCommand = segment.trim()
  let normalized = wrappedCommand
  while (normalized.startsWith('(') || normalized.startsWith('{')) {
    normalized = normalized.slice(1).trim()
  }
  normalized = stripLeadingEnvAssignments(normalized)
  for (;;) {
    const wrapper = normalized.match(
      /^(command|exec|time|env|sudo|doas|xargs|timeout|nice)\s+/,
    )
    if (!wrapper) break
    const word = wrapper[1]
    normalized = normalized.slice(wrapper[0].length)
    if (
      word === 'sudo' ||
      word === 'doas' ||
      word === 'xargs' ||
      word === 'env' ||
      word === 'timeout' ||
      word === 'nice'
    ) {
      const valueFlags = WRAPPER_OPTION_VALUES[word] ?? new Set<string>()
      for (;;) {
        // Exact short flags may consume a separate value token (`-u root`).
        const short = normalized.match(/^-([A-Za-z])\s+/)
        if (short) {
          normalized = normalized.slice(short[0].length)
          if (valueFlags.has(short[1])) {
            const value = normalized.match(/^[^\s]+\s+/)
            if (value) normalized = normalized.slice(value[0].length)
          }
          continue
        }
        // Valueless or inline-valued option tokens (`-0`, `-I{}`, `--login`).
        const option = normalized.match(/^(-[^\s]+)\s+/)
        if (!option) break
        normalized = normalized.slice(option[0].length)
      }
    }
    if (word === 'timeout') {
      // `timeout DURATION cmd` consumes a mandatory duration token (`30`,
      // `30s`, `1m`, ...) before the wrapped command.
      const duration = normalized.match(/^[^\s]+\s+/)
      if (duration) normalized = normalized.slice(duration[0].length)
    }
    if (word === 'env') {
      normalized = stripLeadingEnvAssignments(normalized)
    }
  }
  // Shell interpreters and `eval` are NOT transparent wrappers: their argument
  // is a code payload, so classification must descend INTO the payload rather
  // than stop at the wrapper word (a payload like `bash -c "git push"` used to
  // execute unclassified). If the payload classifies, use that action but bind
  // the target to the full wrapped command so the approval names the exact
  // command (the commandHash already hashes the full original command). If the
  // payload does NOT classify, fail closed to `arbitrary-code`: a shell
  // interpreter wrapping an unrecognized command is exactly the arbitrary-code
  // shape, and leaving it unclassified would let it run without approval.
  const shellWrapper = normalized.match(
    /^(?:(?:bash|zsh|dash|ksh|sh)\s+-[A-Za-z]*c|eval)\s+([\s\S]+)$/i,
  )
  if (shellWrapper) {
    if (depth >= MAX_WRAPPER_DEPTH) {
      return { action: 'arbitrary-code', target: wrappedCommand }
    }
    let payload = shellWrapper[1].trim()
    const doubleQuoted = payload.match(/^"([\s\S]*)"$/)
    const singleQuoted = payload.match(/^'([\s\S]*)'$/)
    if (doubleQuoted) {
      // Model the shell's own unescaping of a double-quoted argv word so a
      // nested `bash -c "bash -c \"git push\""` payload classifies through.
      payload = doubleQuoted[1].replace(/\\([$`"\\])/g, '$1')
    } else if (singleQuoted) {
      payload = singleQuoted[1]
    }
    const payloadClass = classifySegmentsLikeCommand(payload, depth + 1)
    if (payloadClass) return { ...payloadClass, target: wrappedCommand }
    return { action: 'arbitrary-code', target: wrappedCommand }
  }
  return classifySingleSegment(normalized)
}

/**
 * Classifies a command string the way `classifyTerminalHarnessAction`
 * classifies a top-level command: split into segments first, then classify
 * each segment. `depth` bounds recursive shell-wrapper unwrapping so nested
 * `bash -c "bash -c ..."` payloads cannot recurse without bound.
 */
function classifySegmentsLikeCommand(
  command: string,
  depth: number,
): Omit<ClassifiedHarnessAction, 'commandHash'> | undefined {
  const segments = splitCommandSegments(command)
  if (!segments) return classifySegment(command, depth)
  for (const segment of segments) {
    const result = classifySegment(segment, depth)
    if (result) return result
  }
  return undefined
}

function stripLeadingEnvAssignments(segment: string): string {
  let stripped = segment
  for (;;) {
    const assignment = stripped.match(
      /^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+/,
    )
    if (!assignment) return stripped
    stripped = stripped.slice(assignment[0].length)
  }
}

/**
 * Splits a command into executable segments at unquoted `;`, `&&`, `||`, `|`,
 * single `&`, and newlines (leaving `2>&1`-style redirections intact), and
 * also collects command-substitution bodies (`$(...)` and backticks) as
 * additional segments after the main ones. Returns undefined for malformed
 * input (unclosed quotes or parens) or a structurally empty main segment so
 * the caller can fall back to classifying the whole command.
 */
function splitCommandSegments(command: string): string[] | undefined {
  const scan = scanCommandSegments(command)
  if (!scan.complete) return undefined
  const segments = scan.segments.map((segment) => segment.trim())
  if (segments.some((segment) => segment.length === 0)) return undefined
  const substitutions = scan.substitutions
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
  return [...segments, ...substitutions]
}

type SegmentScanResult = {
  segments: string[]
  substitutions: string[]
  complete: boolean
}

function readSubstitutionBody(
  input: string,
  start: number,
): { body: string; end: number } | undefined {
  let depth = 0
  let quote: "'" | '"' | undefined
  let index = start
  while (index < input.length) {
    const char = input[index]
    if (char === '\\' && index + 1 < input.length) {
      index += 2
      continue
    }
    if (quote === "'") {
      if (char === "'") quote = undefined
      index += 1
      continue
    }
    if (quote === '"') {
      if (char === '"') quote = undefined
      index += 1
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      index += 1
      continue
    }
    if (char === '$' && input[index + 1] === '(') {
      depth += 1
      index += 2
      continue
    }
    if (char === '(') {
      depth += 1
      index += 1
      continue
    }
    if (char === ')') {
      if (depth === 0) {
        return { body: input.slice(start, index), end: index + 1 }
      }
      depth -= 1
    }
    index += 1
  }
  return undefined
}

function readBacktickBody(
  input: string,
  start: number,
): { body: string; end: number } | undefined {
  let index = start
  while (index < input.length) {
    const char = input[index]
    if (char === '\\' && index + 1 < input.length) {
      index += 2
      continue
    }
    if (char === '`') {
      return { body: input.slice(start, index), end: index + 1 }
    }
    index += 1
  }
  return undefined
}

function scanCommandSegments(input: string): SegmentScanResult {
  const segments: string[] = []
  const substitutions: string[] = []
  let current = ''
  let quote: "'" | '"' | undefined
  const flush = () => {
    segments.push(current)
    current = ''
  }
  const incomplete = (): SegmentScanResult => ({
    segments: [],
    substitutions: [],
    complete: false,
  })
  let index = 0
  while (index < input.length) {
    const char = input[index]
    if (quote === "'") {
      if (char === "'") quote = undefined
      current += char
      index += 1
      continue
    }
    const inDoubleQuote = quote === '"'
    if (inDoubleQuote && char === '"') quote = undefined
    if (
      char === '\\' &&
      index + 1 < input.length &&
      (!inDoubleQuote ||
        input[index + 1] === '"' ||
        input[index + 1] === '\\' ||
        input[index + 1] === '$' ||
        input[index + 1] === '`')
    ) {
      current += input.slice(index, index + 2)
      index += 2
      continue
    }
    if ((char === '$' && input[index + 1] === '(') || char === '`') {
      const body =
        char === '$'
          ? readSubstitutionBody(input, index + 2)
          : readBacktickBody(input, index + 1)
      if (!body) return incomplete()
      const inner = scanCommandSegments(body.body)
      if (!inner.complete) return incomplete()
      substitutions.push(...inner.segments, ...inner.substitutions)
      index = body.end
      continue
    }
    if (!inDoubleQuote) {
      if (char === "'" || char === '"') {
        quote = char
        current += char
        index += 1
        continue
      }
      if (char === ';' || char === '\n') {
        flush()
        index += 1
        continue
      }
      if (char === '|') {
        flush()
        index += input[index + 1] === '|' ? 2 : 1
        continue
      }
      if (char === '&') {
        if (input[index + 1] === '&') {
          flush()
          index += 2
          continue
        }
        if (
          index > 0 &&
          input[index - 1] === '>' &&
          input[index + 1] !== undefined &&
          /\d/.test(input[index + 1])
        ) {
          // `2>&1`-style redirect: the `&` belongs to the redirect token.
          current += char
          index += 1
          continue
        }
        flush()
        index += 1
        continue
      }
    }
    current += char
    index += 1
  }
  if (quote) return incomplete()
  flush()
  return { segments, substitutions, complete: true }
}

/**
 * Classifies only commands that cross trust boundaries or destroy data.
 * Ordinary pipelines, command substitution in project scripts, background
 * jobs, and staged-only `git restore --staged` are not high-impact.
 * This classifier never grants authority: the terminal permission profile is
 * evaluated first, then a matching snapshot-scoped approval must be consumed.
 */
export function classifyTerminalHarnessAction(
  rawCommand: string,
): ClassifiedHarnessAction | undefined {
  const command = normalizeCommand(rawCommand)
  const commandHash = hashCommand(rawCommand)
  const classify = ():
    | Omit<ClassifiedHarnessAction, 'commandHash'>
    | undefined => classifySegmentsLikeCommand(command, 0)
  const result = classify()
  return result ? { ...result, commandHash } : undefined
}

export class ChangeOwnershipService {
  constructor(private readonly store: LocalHarnessStore) {}

  record(
    scope: RecordScope,
    params: {
      transactionId: string
      agentRole: string
      findingsAddressed: string[]
      requirementsAddressed: string[]
      changes: OwnershipRecord['changes']
    },
  ): OwnershipRecord {
    if (params.changes.length === 0) {
      throw new Error('Ownership receipts require at least one changed path.')
    }
    const paths = new Set<string>()
    for (const change of params.changes) {
      if (!change.path || change.path.includes('..')) {
        throw new Error(`Invalid ownership path '${change.path}'.`)
      }
      if (paths.has(change.path)) {
        throw new Error(`Duplicate ownership path '${change.path}'.`)
      }
      paths.add(change.path)
    }
    const timestamp = now()
    return this.store.put('ownership', {
      schemaVersion: 1,
      id: `ownership-${params.transactionId}`,
      revision: 0,
      ...scope,
      createdAt: timestamp,
      updatedAt: timestamp,
      ...params,
    }) as OwnershipRecord
  }
}

export type HarnessPolicyDecision =
  | { allowed: true; approvalRequired: false }
  | { allowed: false; approvalRequired: boolean; reason: string }

export function evaluateHarnessActionPolicy(params: {
  action: string
  target: string
  defaultBranch?: string
  branch?: string
  hasMatchingApproval: boolean
  approvalMode?: HarnessApprovalMode
}): HarnessPolicyDecision {
  const approvalMode = params.approvalMode ?? 'balanced'
  const highImpact = new Set([
    'migration',
    'release',
    'deploy',
    'external-network',
    'arbitrary-code',
    'workspace-delete',
  ])
  if (
    params.action === 'push' &&
    params.branch &&
    params.defaultBranch === params.branch
  ) {
    if (approvalMode !== 'allow-all' && !params.hasMatchingApproval) {
      return {
        allowed: false,
        approvalRequired: true,
        reason: 'Direct default-branch pushes require explicit user approval.',
      }
    }
  }
  const requiresApproval =
    approvalMode === 'strict' ||
    (approvalMode === 'balanced' && highImpact.has(params.action))
  if (requiresApproval && !params.hasMatchingApproval) {
    return {
      allowed: false,
      approvalRequired: true,
      reason: `Action '${params.action}' requires a snapshot-scoped user approval for '${params.target}'.`,
    }
  }
  return { allowed: true, approvalRequired: false }
}

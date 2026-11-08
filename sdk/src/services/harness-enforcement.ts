import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'

import { LocalHarnessStore } from './local-harness-store'
import { executionBindingTuple } from '@codebuff/common/util/execution-context'

import type { LocalHarnessRecord } from './local-harness-store'
import type { CapturedExecutable, StoredExecutionAuthorityV2, TargetClassification } from '@codebuff/common/types/contracts/execution-context'

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
  executionContextHash?: string
  executionAuthority?: StoredExecutionAuthorityV2
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
      executionContextHash?: string
      executionAuthority?: StoredExecutionAuthorityV2
      expiresAt?: string
    },
  ): ApprovalRecord {
    if (params.executionAuthority && (!isStoredExecutionAuthorityV2(params.executionAuthority) ||
      params.executionAuthority.binding.commandHash !== params.commandHash)) throw new Error('Invalid stored execution authority v2.')
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
      ...(params.executionContextHash
        ? { executionContextHash: params.executionContextHash }
        : {}),
      ...(params.executionAuthority ? { executionAuthority: params.executionAuthority } : {}),
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
    executionContextHash?: string
    executionAuthority?: StoredExecutionAuthorityV2
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
        existing.executionContextHash !== params.executionContextHash ||
        existing.workspaceId !== params.workspaceId ||
        existing.runId !== params.runId ||
        existing.snapshotId !== params.snapshotId
      ) {
        throw new Error('Approval scope does not match the requested action.')
      }
      if (existing.executionAuthority !== undefined || params.executionAuthority !== undefined) {
        if (!isStoredExecutionAuthorityV2(existing.executionAuthority) || !isStoredExecutionAuthorityV2(params.executionAuthority) ||
          existing.executionAuthority.keyEpochId !== params.executionAuthority.keyEpochId ||
          existing.executionAuthority.bindingDigest !== params.executionAuthority.bindingDigest ||
          JSON.stringify(executionBindingTuple(existing.executionAuthority.binding)) !== JSON.stringify(executionBindingTuple(params.executionAuthority.binding)))
          throw new Error('Approval execution authority v2 does not match the requested target.')
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

export type HarnessPushRisk =
  | 'force'
  | 'delete'
  | 'refspec'
  | 'mirror'
  | 'all-refs'
  | 'unknown-options'
  | 'dynamic-target'

export type ClassifiedHarnessEffect = {
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
  pushRisks?: HarnessPushRisk[]
}

export type HarnessParseStatus = 'complete' | 'unsupported' | 'malformed'

export type ClassifiedHarnessAction = ClassifiedHarnessEffect & {
  commandHash: string
  rawCommand?: string
  effects?: ClassifiedHarnessEffect[]
  parseStatus?: HarnessParseStatus
  parseReason?: string
  executionContextHash?: string
  executionAuthority?: StoredExecutionAuthorityV2
}

const bindingFields = ['format', 'keyEpochId', 'commandHash', 'executableArgvDigest', 'effectRosterDigest', 'parseStatus',
  'hostContextId', 'configurationSnapshotId', 'correlationDigest', 'cwd', 'projectRoot', 'allowedPaths',
  'profileRequestDigest', 'selectedBackendDigest', 'environmentDigest', 'credentialRosterId', 'destinationId',
  'delegationDigest', 'requestId', 'resourceId', 'resourceGeneration', 'ownerId', 'leaseId', 'processType', 'mode',
  'detachTransferId', 'deadlinesDigest', 'adapterOptionsDigest', 'launchId'] as const

export function isStoredExecutionAuthorityV2(input: unknown): input is StoredExecutionAuthorityV2 {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false
  const value = input as Record<string, unknown>
  if (Object.keys(value).length !== 6 || value.version !== 2 || value.bindingFormat !== 'openbuff.execution.v2' ||
    value.usage !== 'one-target-dispatch' || typeof value.keyEpochId !== 'string' || !value.keyEpochId ||
    typeof value.bindingDigest !== 'string' || !/^[a-f0-9]{64}$/.test(value.bindingDigest) ||
    !value.binding || typeof value.binding !== 'object' || Array.isArray(value.binding)) return false
  const binding = value.binding as Record<string, unknown>
  if (Object.keys(binding).length !== bindingFields.length || bindingFields.some(name => !(name in binding)) ||
    binding.format !== 'openbuff.execution.v2' || binding.keyEpochId !== value.keyEpochId ||
    !['complete', 'unsupported', 'malformed'].includes(String(binding.parseStatus)) ||
    !['SYNC', 'BACKGROUND'].includes(String(binding.processType)) || !['assistant', 'user'].includes(String(binding.mode)) ||
    (binding.detachTransferId !== null && (typeof binding.detachTransferId !== 'string' || !binding.detachTransferId)) ||
    typeof binding.cwd !== 'string' || !path.isAbsolute(binding.cwd) ||
    typeof binding.projectRoot !== 'string' || !path.isAbsolute(binding.projectRoot) ||
    !Array.isArray(binding.allowedPaths) || binding.allowedPaths.some(entry => typeof entry !== 'string' || !path.isAbsolute(entry) || entry.includes('\0')))
    return false
  if (['commandHash', 'executableArgvDigest', 'effectRosterDigest', 'correlationDigest', 'profileRequestDigest',
    'selectedBackendDigest', 'environmentDigest', 'delegationDigest', 'deadlinesDigest', 'adapterOptionsDigest']
    .some(name => typeof binding[name] !== 'string' || !/^[a-f0-9]{64}$/.test(binding[name] as string))) return false
  return bindingFields.every(name => name === 'allowedPaths' || name === 'detachTransferId' ||
    (typeof binding[name] === 'string' && binding[name] !== '' && !binding[name].includes('\0')))
}

export type HarnessApprovalRequest = ClassifiedHarnessAction & {
  reason: string
  risk: 'routine' | 'high'
}

/**
 * Hash the exact UTF-8 executable bytes, including whitespace inside quotes,
 * newlines, and escapes. Display normalization must never define authority.
 */
export function hashCommand(command: string): string {
  return createHash('sha256').update(command).digest('hex')
}

export function hashTerminalExecutionContext(params: {
  permissionProfile: string
  cwd: string
  projectRoot: string
  allowedPaths?: readonly string[]
  processType: 'SYNC' | 'BACKGROUND'
  detach?: boolean
  mode?: 'assistant' | 'user'
}): string {
  return hashCommand(
    JSON.stringify({
      version: 1,
      permissionProfile: params.permissionProfile,
      cwd: params.cwd,
      projectRoot: params.projectRoot,
      allowedPaths: params.allowedPaths ?? [],
      processType: params.processType,
      detach: params.detach ?? false,
      mode: params.mode ?? 'assistant',
    }),
  )
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
    const pushRisks = new Set<HarnessPushRisk>()
    for (const arg of args) {
      if (
        /^--force(?:$|=|-with-lease|-if-includes)/.test(arg) ||
        /^-[^-]*f/.test(arg) ||
        arg.startsWith('+')
      )
        pushRisks.add('force')
      if (arg === '--delete' || /^-[^-]*d/.test(arg) || arg.startsWith(':'))
        pushRisks.add('delete')
      if (arg === '--mirror') pushRisks.add('mirror')
      if (/^--(?:all|tags|prune)$/.test(arg)) pushRisks.add('all-refs')
      if (arg.includes(':') && arg !== remote) pushRisks.add('refspec')
      if (arg.includes('__openbuff_dynamic__') || /[$`*?\[\]]/.test(arg))
        pushRisks.add('dynamic-target')
      if (
        arg.startsWith('-') &&
        !/^(?:-u|--set-upstream|--force(?:=.*)?|--force-with-lease(?:=.*)?|--force-if-includes|--delete|--mirror|--all|--tags|--prune|-[ufd]+)$/.test(
          arg,
        )
      )
        pushRisks.add('unknown-options')
    }
    if (positional.length > 2) pushRisks.add('refspec')
    return {
      action: 'push',
      target: simplePush && remote && branch ? `${remote}/${branch}` : command,
      ...(branch ? { branch } : {}),
      ...(pushRisks.size ? { pushRisks: [...pushRisks] } : {}),
    }
  }
  if (/^git\s+commit\b/i.test(command)) {
    return { action: 'commit', target: command }
  }
  if (
    /^git\s+reset\b[\s\S]*\s--hard(?:\s|$)/i.test(command) ||
    /^git\s+clean\b[\s\S]*-[^\s]*[fd]/i.test(command) ||
    /^git\s+checkout\b[\s\S]*\s--(?:\s|$)/i.test(command)
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
const WRAPPER_VALUELESS_OPTIONS: Record<string, string> = {
  command: 'pvV',
  exec: 'cl',
  time: 'p',
  env: 'i0v',
  sudo: 'AbEHinSkKlvV',
  doas: 'ns',
  xargs: '0rtpx',
  timeout: 'v',
  nice: '',
}

type ShellWord = { value: string; raw: string; dynamic: boolean }

/** Decode lexical words only; never expand variables or execute substitutions. */
function shellWords(command: string): ShellWord[] | undefined {
  const words: ShellWord[] = []
  let value = '',
    raw = '',
    dynamic = false
  let quote: "'" | '"' | undefined
  const flush = () => {
    if (raw) words.push({ value, raw, dynamic })
    value = ''
    raw = ''
    dynamic = false
  }
  for (let index = 0; index < command.length; index++) {
    const char = command[index]
    if (quote === "'") {
      raw += char
      if (char === "'") quote = undefined
      else value += char
      continue
    }
    if (
      char === '\\' &&
      (quote !== '"' || /[$`"\\\n]/.test(command[index + 1] ?? ''))
    ) {
      if (index + 1 === command.length) {
        raw += char
        value += char
        continue
      }
      const next = command[++index]
      raw += '\\' + next
      if (next !== '\n') value += next
      continue
    }
    if (char === quote) {
      raw += char
      quote = undefined
      continue
    }
    if (!quote && (char === "'" || char === '"')) {
      raw += char
      quote = char
      continue
    }
    if (!quote && /\s/.test(char)) {
      flush()
      continue
    }
    if (
      char === '$' ||
      char === '`' ||
      (!quote && /[*?\[\]{}~]/.test(char)) ||
      command.startsWith('__openbuff_dynamic__', index)
    )
      dynamic = true
    raw += char
    value += char
  }
  if (quote) return undefined
  flush()
  return words
}

function unsupportedSegment(
  command: string,
  reason: string,
): Omit<ClassifiedHarnessAction, 'commandHash'> {
  return {
    action: 'arbitrary-code',
    target: command,
    parseStatus: 'unsupported',
    parseReason: reason,
  }
}

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
  const words = shellWords(wrappedCommand)
  if (!words)
    return {
      action: 'arbitrary-code',
      target: wrappedCommand,
      parseStatus: 'malformed',
      parseReason: 'Malformed shell word.',
    }
  let index = 0
  let dynamicArguments = false
  const skipAssignments = () => {
    while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index]?.value ?? '')) index++
  }
  const programAt = () => words[index]?.value.split('/').at(-1) ?? ''
  skipAssignments()
  if (words[index]?.value === '!') index++
  skipAssignments()
  while (
    /^(?:command|exec|time|env|sudo|doas|xargs|timeout|nice)$/.test(programAt())
  ) {
    if (words[index].dynamic)
      return unsupportedSegment(
        wrappedCommand,
        'Dynamic wrapper cannot be classified statically.',
      )
    const wrapper = programAt()
    if (wrapper === 'xargs') dynamicArguments = true
    index++
    while (words[index]?.value.startsWith('-')) {
      const flag = words[index++].value
      if (flag === '--') break
      if (wrapper === 'command' && /^(?:-v|-V)$/.test(flag)) return undefined
      if (wrapper === 'env' && /^(?:-S|--split-string)(?:$|=)/.test(flag))
        return unsupportedSegment(
          wrappedCommand,
          'env split-string requires shell-specific interpretation.',
        )
      const longValueFlags = new Set([
        '--unset',
        '--user',
        '--group',
        '--prompt',
        '--host',
        '--chdir',
        '--chroot',
        '--command-timeout',
        '--signal',
        '--kill-after',
        '--adjustment',
        '--max-args',
        '--replace',
        '--max-chars',
        '--max-procs',
        '--max-lines',
        '--eof',
        '--arg-file',
      ])
      if (
        longValueFlags.has(flag) ||
        (/^-[A-Za-z]$/.test(flag) &&
          (WRAPPER_OPTION_VALUES[wrapper]?.has(flag.slice(1)) ||
            (wrapper === 'exec' && flag === '-a')))
      ) {
        if (!words[index])
          return unsupportedSegment(
            wrappedCommand,
            'Wrapper option value is missing.',
          )
        index++
      } else if (
        flag.startsWith('--') &&
        !flag.includes('=') &&
        ![
          '--login',
          '--preserve-environment',
          '--ignore-environment',
          '--null',
          '--verbose',
          '--foreground',
          '--help',
          '--version',
        ].includes(flag)
      ) {
        return unsupportedSegment(wrappedCommand, 'Unsupported wrapper option.')
      } else if (flag.startsWith('-') && !flag.startsWith('--')) {
        const letters = flag.slice(1)
        const knownInlineValue =
          letters.length > 1 && WRAPPER_OPTION_VALUES[wrapper]?.has(letters[0])
        if (
          !knownInlineValue &&
          ![...letters].every((letter) =>
            WRAPPER_VALUELESS_OPTIONS[wrapper]?.includes(letter),
          )
        )
          return unsupportedSegment(
            wrappedCommand,
            'Unsupported short wrapper option.',
          )
      }
    }
    if (wrapper === 'timeout') index++
    if (wrapper === 'env') skipAssignments()
    if (!words[index])
      return unsupportedSegment(wrappedCommand, 'Wrapper command is missing.')
  }
  if (!words[index]) return undefined
  if (words[index].dynamic)
    return unsupportedSegment(
      wrappedCommand,
      'Dynamic executable names cannot be classified statically.',
    )
  const program = programAt()
  const args = words.slice(index + 1)
  if (
    /^(?:if|then|else|elif|fi|for|while|until|do|done|case|esac|function|select|coproc|source|!|\.|\[\[|\]\])$/.test(
      program,
    ) ||
    /^[<>]/.test(program)
  )
    return unsupportedSegment(
      wrappedCommand,
      'Shell control flow, sourced code, or leading redirection is outside this scanner tier.',
    )
  if (/^(?:bash|zsh|dash|ksh|sh|eval)$/.test(program)) {
    const payloadIndex =
      program === 'eval'
        ? 0
        : args.findIndex((word) => /^-[A-Za-z]*c[A-Za-z]*$/.test(word.value)) +
          1
    if (depth >= MAX_WRAPPER_DEPTH)
      return unsupportedSegment(
        wrappedCommand,
        'Shell wrapper recursion limit exceeded.',
      )
    if (
      (program !== 'eval' && payloadIndex <= 0) ||
      !args[payloadIndex] ||
      args.slice(payloadIndex).some((word) => word.dynamic)
    )
      return unsupportedSegment(
        wrappedCommand,
        'Dynamic or unsupported shell payload.',
      )
    const payload =
      program === 'eval'
        ? args
            .slice(payloadIndex)
            .map((word) => word.value)
            .join(' ')
        : args[payloadIndex].value
    const classified = classifySegmentsLikeCommand(payload, depth + 1)
    if (!classified) return { action: 'arbitrary-code', target: wrappedCommand }
    return {
      ...classified,
      target: wrappedCommand,
      effects: (classified.effects ?? [effectOnly(classified)]).map(
        (effect) => ({ ...effect, target: wrappedCommand }),
      ),
    }
  }
  if (program === 'git' && args[0]?.value.startsWith('-'))
    return unsupportedSegment(
      wrappedCommand,
      'Git global options can change command context or aliases.',
    )
  if (
    (program === 'git' && args[0]?.dynamic) ||
    (['npm', 'pnpm', 'bun', 'yarn', 'gh', 'docker', 'podman'].includes(
      program,
    ) &&
      args[0]?.dynamic)
  )
    return unsupportedSegment(
      wrappedCommand,
      'Dynamic subcommand cannot be classified statically.',
    )
  const classified = classifySingleSegment(
    [program, ...args.map((word) => word.value)].join(' '),
  )
  if (dynamicArguments)
    return classified
      ? {
          ...classified,
          parseStatus: 'unsupported',
          parseReason:
            'xargs can construct additional executable arguments from input.',
        }
      : unsupportedSegment(
          wrappedCommand,
          'xargs can construct executable arguments from input.',
        )
  return (
    classified && {
      ...classified,
      target:
        classified.action === 'push' || classified.action === 'workspace-delete'
          ? classified.target
          : wrappedCommand,
    }
  )
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
  const scan = scanCommandSegments(command)
  if (!scan.complete)
    return {
      action: 'arbitrary-code',
      target: command,
      parseStatus: 'malformed',
      parseReason:
        'Unclosed quote, substitution, grouping, or incomplete shell list.',
    }
  const segments = [...scan.segments, ...scan.substitutions]
    .map((value) => value.trim())
    .filter(Boolean)
  const effects: ClassifiedHarnessEffect[] = []
  let parseStatus: HarnessParseStatus = scan.unsupportedReason
    ? 'unsupported'
    : 'complete'
  let parseReason = scan.unsupportedReason
  for (const segment of segments) {
    const result = classifySegment(segment, depth)
    if (!result) continue
    effects.push(...(result.effects ?? [effectOnly(result)]))
    if (
      result.parseStatus === 'malformed' ||
      (result.parseStatus === 'unsupported' && parseStatus === 'complete')
    ) {
      parseStatus = result.parseStatus
      parseReason = result.parseReason
    }
  }
  if (
    parseStatus !== 'complete' &&
    !effects.some(
      (effect) =>
        effect.action === 'arbitrary-code' && effect.target === command,
    )
  )
    effects.push({ action: 'arbitrary-code', target: command })
  const first = effects[0]
  return first
    ? {
        ...first,
        effects,
        parseStatus,
        ...(parseReason ? { parseReason } : {}),
      }
    : undefined
}

function effectOnly(
  action: Omit<ClassifiedHarnessAction, 'commandHash'>,
): ClassifiedHarnessEffect {
  return {
    action: action.action,
    target: action.target,
    ...(action.branch ? { branch: action.branch } : {}),
    ...(action.pushRisks ? { pushRisks: action.pushRisks } : {}),
  }
}

type SegmentScanResult = {
  segments: string[]
  substitutions: string[]
  complete: boolean
  unsupportedReason?: string
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

function scanCommandSegments(input: string, depth = 0): SegmentScanResult {
  if (
    /^\s*(?:(?:case|function|for|while|until|select)\b|[A-Za-z_][A-Za-z0-9_]*\s*\(\s*\))/.test(
      input,
    )
  )
    return {
      segments: [input],
      substitutions: [],
      complete: true,
      unsupportedReason:
        'Shell control flow and function definitions are outside this scanner tier.',
    }
  if (depth >= 16)
    return {
      segments: [],
      substitutions: [],
      complete: true,
      unsupportedReason: 'Command substitution nesting limit exceeded.',
    }
  const segments: string[] = []
  const substitutions: string[] = []
  let current = ''
  let quote: "'" | '"' | undefined
  const groups: Array<{ closer: string; segmentCount: number }> = []
  let requiresNext = false
  let closedGroup = false
  let unsupportedReason: string | undefined
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
      if (input[index + 1] !== '\n') current += input.slice(index, index + 2)
      index += 2
      continue
    }
    if ((char === '$' && input[index + 1] === '(') || char === '`') {
      const body =
        char === '$'
          ? readSubstitutionBody(input, index + 2)
          : readBacktickBody(input, index + 1)
      if (!body) return incomplete()
      const inner = scanCommandSegments(body.body, depth + 1)
      if (!inner.complete) return incomplete()
      substitutions.push(...inner.segments, ...inner.substitutions)
      unsupportedReason ??= inner.unsupportedReason
      current += '__openbuff_dynamic__'
      index = body.end
      continue
    }
    if (!inDoubleQuote) {
      if (char === '#' && (current.length === 0 || /\s$/.test(current))) {
        while (index < input.length && input[index] !== '\n') index++
        continue
      }
      if (char === '(') {
        if (current.trim() || input[index + 1] === '(')
          unsupportedReason ??=
            'Function, arithmetic, or extended grouping syntax is unsupported.'
        if (current.trim()) flush()
        groups.push({ closer: ')', segmentCount: segments.length })
        requiresNext = false
        index++
        continue
      }
      if (char === ')') {
        const group = groups.pop()
        if (
          group?.closer !== ')' ||
          (requiresNext && !current.trim()) ||
          (!current.trim() && group.segmentCount === segments.length)
        )
          return incomplete()
        if (current.trim()) flush()
        requiresNext = false
        closedGroup = true
        index++
        continue
      }
      if (
        char === '{' &&
        (index === 0 || /[\s;]/.test(input[index - 1])) &&
        /\s/.test(input[index + 1] ?? '')
      ) {
        if (current.trim())
          unsupportedReason ??= 'Compound grouping prefix is unsupported.'
        groups.push({ closer: '}', segmentCount: segments.length })
        index++
        continue
      }
      if (
        char === '}' &&
        (index === 0 || /[\s;]/.test(input[index - 1])) &&
        (index + 1 === input.length || /[\s;]/.test(input[index + 1]))
      ) {
        const group = groups.pop()
        if (
          group?.closer !== '}' ||
          (requiresNext && !current.trim()) ||
          (!current.trim() && group.segmentCount === segments.length)
        )
          return incomplete()
        if (current.trim()) flush()
        requiresNext = false
        closedGroup = true
        index++
        continue
      }
      if ((char === '<' || char === '>') && input[index + 1] === '(') {
        const body = readSubstitutionBody(input, index + 2)
        if (!body) return incomplete()
        const inner = scanCommandSegments(body.body, depth + 1)
        if (!inner.complete) return incomplete()
        substitutions.push(...inner.segments, ...inner.substitutions)
        unsupportedReason ??= inner.unsupportedReason
        current += '__openbuff_dynamic__'
        index = body.end
        continue
      }
      if (char === '<' && input[index + 1] === '<')
        unsupportedReason ??=
          'Here-document and here-string bodies are outside this scanner tier.'
      if (char === "'" || char === '"') {
        quote = char
        current += char
        index += 1
        continue
      }
      if (char === ';' || char === '\n') {
        if (
          char === ';' &&
          !current.trim() &&
          !closedGroup &&
          !unsupportedReason
        )
          return incomplete()
        if (char === ';' && !current.trim() && requiresNext) return incomplete()
        if (char === ';' && input[index + 1] === ';')
          unsupportedReason ??= 'Case clauses are outside this scanner tier.'
        if (current.trim()) requiresNext = false
        if (closedGroup) requiresNext = false
        flush()
        closedGroup = false
        index += 1
        continue
      }
      if (char === '|') {
        if (!current.trim() && !closedGroup) return incomplete()
        flush()
        closedGroup = false
        requiresNext = true
        index += input[index + 1] === '|' ? 2 : 1
        continue
      }
      if (char === '&') {
        if (input[index + 1] === '&') {
          if (!current.trim() && !closedGroup) return incomplete()
          flush()
          closedGroup = false
          requiresNext = true
          index += 2
          continue
        }
        if (input[index + 1] === '>') {
          current += char
          index++
          continue
        }
        if (
          index > 0 &&
          (input[index - 1] === '>' || input[index - 1] === '<') &&
          input[index + 1] !== undefined &&
          /[\d-]/.test(input[index + 1])
        ) {
          // `2>&1`-style redirect: the `&` belongs to the redirect token.
          current += char
          index += 1
          continue
        }
        if (!current.trim() && !closedGroup) return incomplete()
        flush()
        closedGroup = false
        requiresNext = false
        index += 1
        continue
      }
    }
    current += char
    index += 1
  }
  if (quote || groups.length || (requiresNext && !current.trim()))
    return incomplete()
  flush()
  return { segments, substitutions, complete: true, unsupportedReason }
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
  const commandHash = hashCommand(rawCommand)
  const classify = ():
    | Omit<ClassifiedHarnessAction, 'commandHash'>
    | undefined => classifySegmentsLikeCommand(rawCommand, 0)
  const result = classify()
  return result ? { ...result, commandHash, rawCommand } : undefined
}

function exactArgv(args: readonly string[], expected: readonly string[]): boolean {
  return args.length === expected.length && args.every((arg, i) => arg === expected[i])
}

type GitReadQueryKind = 'identity' | 'working-tree' | 'query'
const gitReadGuards = Object.freeze([
  '--no-pager', '--no-optional-locks', '--no-lazy-fetch', '-c', 'core.fsmonitor=false',
])
const gitDiffGuards = Object.freeze(['--no-ext-diff', '--no-textconv', '--submodule=short'])

/** These query shapes come from the Git adapters, not a general Git option parser. */
function gitReadQueryKind(args: readonly string[]): GitReadQueryKind | undefined {
  const separator = args.indexOf('--')
  const query = separator < 0 ? args : args.slice(0, separator)
  const pathQuery = ['status', 'diff'].includes(query[0] ?? '')
  if (separator >= 0 && !pathQuery) return undefined
  if (separator < 0 && [
    ['rev-parse', '--show-toplevel'], ['rev-parse', '--git-common-dir'], ['rev-parse', '--git-dir'],
  ].some(expected => exactArgv(query, expected))) return 'identity'
  const workingTreeQueries = [
    ['status'], ['status', '--porcelain'], ['status', '--porcelain', '-uall'],
    ['status', '--short', '--branch'],
    ['diff'], ['diff', '--no-color'], ['diff', '--binary', 'HEAD'],
  ]
  if (workingTreeQueries.some(expected => exactArgv(query, expected))) return 'working-tree'
  const queries = [
    ['diff', '--cached'],
    ['diff', '--staged', '--no-color'], ['diff', '--cached', '--check'],
    ['diff', '--cached', '-U0'], ['diff', '--cached', '--name-only', '-z'],
    ['diff', '--no-color', 'HEAD~1', 'HEAD'],
    ['branch', '--show-current'],
    ['rev-parse', 'HEAD'], ['rev-parse', 'HEAD~1'],
    ['rev-parse', '--verify', 'HEAD'], ['rev-parse', '--verify', 'HEAD~1'],
    ['rev-parse', '--abbrev-ref', 'HEAD'],
    ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
    ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'],
    ['shortlog', 'HEAD~10..HEAD'],
  ]
  if (queries.some(expected => exactArgv(query, expected))) return 'query'
  // The bundle adapter passes one validated reference, never another option.
  if (separator < 0 && args.length === 3 && args[0] === 'merge-base' &&
    args[1] === 'HEAD' && /^[A-Za-z0-9_][A-Za-z0-9_./-]*$/.test(args[2])) return 'query'
  return undefined
}

function guardedGitReadQueryKind(args: readonly string[]): GitReadQueryKind | undefined {
  if (!exactArgv(args.slice(0, gitReadGuards.length), gitReadGuards)) return undefined
  const query = args.slice(gitReadGuards.length)
  if (query[0] === 'diff') {
    if (!exactArgv(query.slice(1, 1 + gitDiffGuards.length), gitDiffGuards)) return undefined
    return gitReadQueryKind([query[0], ...query.slice(1 + gitDiffGuards.length)])
  }
  return gitReadQueryKind(query)
}

/** Host query adapters call this before capture; user mutations and unknown vectors retain their exact bytes. */
export function prepareHarnessGitReadArgv(args: readonly string[]): string[] {
  if (guardedGitReadQueryKind(args)) return [...args]
  const kind = gitReadQueryKind(args)
  // Repository bootstrap permits deliberately require these exact identity vectors.
  if (!kind || kind === 'identity') return [...args]
  return [...gitReadGuards, args[0], ...(args[0] === 'diff' ? gitDiffGuards : []), ...args.slice(1)]
}

/** Check a bounded option vocabulary without turning tokens into shell text. */
function supportedReadOptions(
  args: readonly string[],
  switches: readonly string[],
  values: Readonly<Record<string, 'text' | 'count'>> = {},
  requirePatternAfterSeparator = false,
): boolean {
  const validValue = (value: string, kind: 'text' | 'count') =>
    kind === 'text' ? value.length > 0 : /^\d+$/.test(value)
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    // A separator consumed as an option value above is never reconsidered here.
    if (arg === '--') return !requirePatternAfterSeparator || i + 1 < args.length
    if (!arg.startsWith('-') || arg === '-') continue
    if (switches.includes(arg)) continue
    const equals = arg.indexOf('=')
    const name = equals < 0 ? arg : arg.slice(0, equals)
    const kind = values[name]
    if (kind) {
      const value = equals < 0 ? args[++i] : arg.slice(equals + 1)
      if (value === undefined || !validValue(value, kind)) return false
      continue
    }
    // Only the explicitly supported count switches have an attached short form.
    const short = arg.slice(0, 2)
    if (!arg.startsWith('--') && values[short] === 'count' && validValue(arg.slice(2), 'count')) continue
    return false
  }
  return !requirePatternAfterSeparator
}

function supportedOrdinaryReadArgv(program: string, args: readonly string[]): boolean {
  if (program === 'rg') {
    // Both search adapters disable ambient ripgrep configuration and terminate options.
    if (args[0] !== '--no-config') return false
    return supportedReadOptions(args, [
      '--no-config', '-n', '--line-number', '--json', '-l', '--files-with-matches',
      '-i', '--ignore-case', '-S', '--smart-case', '-s', '--case-sensitive',
      '-w', '--word-regexp', '-F', '--fixed-strings', '-U', '--multiline', '--multiline-dotall',
    ], { '-g': 'text', '--glob': 'text', '-t': 'text', '--type': 'text', '-T': 'text', '--type-not': 'text',
      '-A': 'count', '--after-context': 'count', '-B': 'count', '--before-context': 'count', '-C': 'count', '--context': 'count' }, true)
  }
  if (program === 'grep') return args.length > 0 && supportedReadOptions(args,
    ['-n', '--line-number', '-i', '--ignore-case', '-E', '--extended-regexp', '-F', '--fixed-strings', '-l', '--files-with-matches'],
    { '-e': 'text', '--regexp': 'text' })
  if (program === 'echo') return supportedReadOptions(args, ['-n', '-e', '-E'])
  if (program === 'true' || program === 'false') return args.length === 0
  if (program === 'pwd') return args.length === 0 || exactArgv(args, ['-L']) || exactArgv(args, ['-P'])
  if (program === 'ls') return supportedReadOptions(args, ['-l', '-a', '-la', '-al', '-h', '-lah', '-alh', '-1', '--all'])
  if (program === 'cat') return supportedReadOptions(args, ['-n', '--number'])
  if (program === 'head' || program === 'tail') return supportedReadOptions(args, [],
    { '-n': 'count', '--lines': 'count', '-c': 'count', '--bytes': 'count' })
  if (program === 'wc') return supportedReadOptions(args, ['-l', '--lines', '-w', '--words', '-c', '--bytes', '-m', '--chars'])
  if (program === 'find') return args.length > 0 && args.every(arg => arg.length > 0 && !arg.startsWith('-'))
  return false
}

/** Analyze exact tokens; only an explicit supported shell payload is parsed as shell bytes. */
export function classifyHarnessArgv(params: { executable: string; argv: readonly string[] }): ClassifiedHarnessAction | undefined {
  const identity = JSON.stringify(['openbuff.argv-command.v1', params.executable, params.argv])
  const commandHash = hashCommand(identity)
  const unsupported = (reason: string): ClassifiedHarnessAction => ({ ...unsupportedSegment(identity, reason), commandHash,
    effects: [{ action: 'arbitrary-code', target: identity }] })
  if (!params.executable || params.executable.includes('\0') || !Array.isArray(params.argv) ||
    params.argv.some(arg => typeof arg !== 'string' || arg.includes('\0')))
    return { ...unsupported('Invalid executable or argv'), parseStatus: 'malformed' }
  const program = params.executable.split(/[\\/]/).at(-1)!.replace(/\.exe$/i, '').toLowerCase()
  const args = [...params.argv]
  const effect = (action: ClassifiedHarnessEffect['action'], target = identity, extra: Partial<ClassifiedHarnessEffect> = {}): ClassifiedHarnessAction =>
    ({ action, target, ...extra, commandHash, parseStatus: 'complete', effects: [{ action, target, ...extra }] })
  if (args.length === 1 && args[0] === '--version' &&
    ['node', 'bun', 'deno', 'python', 'python3', 'ruby', 'perl', 'git', 'cargo', 'rustc', 'go', 'dotnet', 'java', 'javac',
      'swift', 'dart', 'flutter', 'elixir', 'mix', 'php', 'composer', 'semgrep', 'npm', 'pnpm', 'yarn', 'bash', 'zsh', 'sh', 'clang', 'gcc'].includes(program))
    return undefined
  if (['bash', 'zsh', 'dash', 'ksh', 'sh'].includes(program)) {
    const flag = args.findIndex(arg => /^-[A-Za-z]*c[A-Za-z]*$/.test(arg))
    if (flag !== 0 || !/^-[euxv]*c[euxv]*$/.test(args[0] ?? '') || args[flag + 1] === undefined)
      return unsupported('Shell startup options or invocation have no supported exact -c payload')
    const classified = classifyTerminalHarnessAction(args[flag + 1])
    if (!classified) return undefined
    const effects = (classified.effects ?? [effectOnly(classified)]).map(entry => ({ ...entry }))
    return { ...classified, commandHash, rawCommand: undefined, effects }
  }
  if (['cmd', 'powershell', 'pwsh', 'eval', 'env', 'sudo', 'doas', 'time', 'timeout', 'nice', 'xargs'].includes(program))
    return unsupported('Wrapper or interpreter semantics require a separately supported token adapter')
  if (['node', 'bun', 'deno', 'python', 'python3', 'ruby', 'perl'].includes(program)) {
    if (args.some(arg => ['-e', '--eval', '-c'].includes(arg) || arg.startsWith('--eval='))) return effect('arbitrary-code')
    // A script file or stdin can execute arbitrary code; its contents are not shell tokens.
    if (program !== 'bun' || !['install', 'add', 'remove', 'update', 'publish'].includes(args[0] ?? ''))
      return unsupported('Interpreter script, module or stdin execution is outside the exact-token analysis tier')
  }
  if (program === 'git') {
    const readKind = guardedGitReadQueryKind(args)
    if (readKind === 'working-tree') return unsupported('Git working-tree queries can execute configured clean/process filters or submodule helpers even with diff, pager and fsmonitor helpers disabled')
    if (readKind || gitReadQueryKind(args) === 'identity') return undefined
    const subcommand = args[0]
    if (!subcommand || subcommand.startsWith('-')) return unsupported('Git global options or missing subcommand can change command context')
    if (subcommand === 'push') {
      const pushArgs = args.slice(1)
      const positional = pushArgs.filter(arg => !arg.startsWith('-'))
      const remote = positional[0], refspec = positional[1]
      const remoteRef = refspec?.includes(':') ? refspec.slice(refspec.lastIndexOf(':') + 1) : refspec
      const branch = remoteRef && !/^(?:HEAD|@\{-?\d+\})$/i.test(remoteRef) ? remoteRef.replace(/^\+/, '').replace(/^refs\/heads\//, '') : undefined
      const pushRisks = new Set<HarnessPushRisk>()
      for (const arg of pushArgs) {
        if (/^--force(?:$|=|-with-lease|-if-includes)/.test(arg) || /^-[^-]*f/.test(arg) || arg.startsWith('+')) pushRisks.add('force')
        if (arg === '--delete' || /^-[^-]*d/.test(arg) || arg.startsWith(':')) pushRisks.add('delete')
        if (arg === '--mirror') pushRisks.add('mirror')
        if (/^--(?:all|tags|prune)$/.test(arg)) pushRisks.add('all-refs')
        if (arg.includes(':') && arg !== remote) pushRisks.add('refspec')
        // Wildcards/refspec expansion is Git semantics. Literal '$' or ';' is never shell syntax here.
        if (/[*?\[\]]/.test(arg)) pushRisks.add('dynamic-target')
        if (arg.startsWith('-') && !/^(?:-u|--set-upstream|--force(?:=.*)?|--force-with-lease(?:=.*)?|--force-if-includes|--delete|--mirror|--all|--tags|--prune|-[ufd]+)$/.test(arg)) pushRisks.add('unknown-options')
      }
      if (positional.length > 2) pushRisks.add('refspec')
      const simple = pushArgs.every(arg => arg === '-u' || arg === '--set-upstream' || !arg.startsWith('-'))
      return effect('push', simple && remote && branch ? `${remote}/${branch}` : identity,
        { ...(branch ? { branch } : {}), ...(pushRisks.size ? { pushRisks: [...pushRisks] } : {}) })
    }
    if (subcommand === 'commit') return effect('commit')
    if (subcommand === 'tag') return effect('release')
    if ((subcommand === 'reset' && args.includes('--hard')) || (subcommand === 'clean' && args.some(arg => /^-[^-]*[fd]/.test(arg))) ||
      (subcommand === 'checkout' && args.includes('--')) ||
      (subcommand === 'restore' && (!args.includes('--staged') || args.some(arg => ['--worktree', '-W', '--source', '--overlay', '--patch', '-p'].includes(arg)))))
      return effect('workspace-delete')
    if (['status', 'diff', 'show', 'log', 'ls-files', 'rev-parse', 'symbolic-ref', 'merge-base', 'for-each-ref', 'ls-tree', 'check-ignore', 'check-attr', 'show-ref', 'rev-list', 'branch', 'remote', 'config', 'shortlog'].includes(subcommand))
      return unsupported(`Git ${subcommand} requires a supported helper-disabled read-query vector; configuration or operands may execute external commands`)
    return unsupported('Git subcommand may execute aliases, hooks or mutate state outside the supported token tier')
  }
  let operation = args[0]
  if (['pnpm', 'bun'].includes(program) && operation === '--filter' && args[1] !== undefined) operation = args[2]
  if (program === 'yarn' && operation === 'workspace' && args[1] !== undefined) operation = args[2]
  const dependencyCommands: Record<string, readonly string[]> = {
    npm: ['install', 'add', 'remove', 'update'], pnpm: ['install', 'add', 'remove', 'update'], yarn: ['install', 'add', 'remove', 'update', 'upgrade'], bun: ['install', 'add', 'remove', 'update'],
    uv: ['add', 'remove', 'sync', 'install', 'update'], poetry: ['add', 'remove', 'sync', 'install', 'update'], pip: ['install', 'uninstall'], pip3: ['install', 'uninstall'],
    cargo: ['add', 'rm', 'remove', 'fetch', 'update'], bundle: ['add', 'remove', 'install', 'update'], bundler: ['add', 'remove', 'install', 'update'], composer: ['require', 'remove', 'install', 'update'],
  }
  if (dependencyCommands[program]?.includes(operation ?? '') ||
    (program === 'go' && (operation === 'get' || (operation === 'mod' && ['tidy', 'download'].includes(args[1] ?? '')))) ||
    (program === 'dotnet' && (operation === 'restore' || (['add', 'remove'].includes(operation ?? '') && args[1] === 'package'))) ||
    (program === 'swift' && operation === 'package' && ['resolve', 'update'].includes(args[1] ?? '')) ||
    (['dart', 'flutter'].includes(program) && operation === 'pub' && ['add', 'remove', 'get', 'upgrade'].includes(args[1] ?? '')) ||
    (program === 'mix' && ['deps.get', 'deps.update'].includes(operation ?? '')) ||
    (['mvn', 'mvnw'].includes(program) && ['dependency:resolve', 'dependency:go-offline'].includes(operation ?? '')) ||
    (['gradle', 'gradlew'].includes(program) && ['dependencies', 'buildEnvironment'].includes(operation ?? ''))) return effect('dependency-install')
  if ((['npm', 'pnpm', 'yarn', 'bun', 'cargo'].includes(program) && operation === 'publish') ||
    (program === 'gh' && operation === 'release' && ['create', 'delete', 'edit', 'upload'].includes(args[1] ?? ''))) return effect('release')
  if (program === 'gh' && operation === 'pr' && ['create', 'merge', 'close', 'reopen', 'ready', 'review'].includes(args[1] ?? '')) return effect('pull-request')
  if (['kubectl', 'helm', 'terraform', 'tofu', 'ansible', 'aws', 'gcloud', 'az', 'flyctl', 'vercel', 'heroku'].includes(program) ||
    (['docker', 'podman'].includes(program) && (['push', 'login', 'run'].includes(operation ?? '') || (operation === 'compose' && args[1] === 'up') || (operation === 'system' && args[1] === 'prune'))) ||
    (program === 'gh' && ((operation === 'workflow' && args[1] === 'run') || (operation === 'repo' && ['create', 'delete'].includes(args[1] ?? '')) ||
      (operation === 'api' && args.some((arg, i) => ['-X', '--method'].includes(arg) && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(args[i + 1] ?? '')))))) return effect('deploy')
  if (['ssh', 'scp', 'sftp', 'ftp', 'telnet', 'nc', 'ncat'].includes(program) ||
    (['curl', 'wget'].includes(program) && args.some(arg => /^(?:--data(?:-binary)?|--form|--upload-file|--post-data)(?:$|=)/.test(arg) || /^-(?:d|F|T)/.test(arg)))) return effect('external-network')
  if (['prisma', 'knex', 'flyway'].includes(program) && operation === 'migrate' ||
    (['sequelize', 'rails'].includes(program) && operation === 'db:migrate') || (program === 'alembic' && operation === 'upgrade') ||
    (program === 'liquibase' && operation === 'update')) return effect('migration')
  if (program === 'rm' && args.some(arg => /^-[^-]*r/.test(arg))) return effect('workspace-delete')
  if (program === 'find' && args.some(arg => ['-delete', '-exec', '-execdir', '-ok', '-okdir'].includes(arg))) return effect('workspace-delete')
  if (supportedOrdinaryReadArgv(program, args) ||
    (program === 'go' && exactArgv(args, ['version'])) || (program === 'java' && exactArgv(args, ['-version']))) return undefined
  if (['echo', 'true', 'false', 'pwd', 'ls', 'rg', 'grep', 'cat', 'head', 'tail', 'wc', 'find'].includes(program))
    return unsupported(`${program} options or operands are outside the supported read-query vectors`)
  return unsupported('Unknown executable or programmable command semantics are outside the exact-token tier')
}

export function classifyCapturedTargetForExecution(captured: CapturedExecutable): TargetClassification {
  const classified = captured.kind === 'shell' ? classifyTerminalHarnessAction(captured.shellCommandBytes) : classifyHarnessArgv(captured)
  return {
    format: 'openbuff.target-classification.v1',
    classifierVersion: captured.kind === 'shell' ? 'b18-shell-adapter-v1' : 'b18-argv-adapter-v1',
    invocationKind: captured.kind,
    effects: classified ? classified.effects ?? [effectOnly(classified)] : [],
    parseStatus: classified?.parseStatus ?? 'complete',
    parseReason: classified?.parseStatus && classified.parseStatus !== 'complete' ? classified.parseReason ?? 'Unsupported exact invocation' : null,
  }
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
  pushRisks?: HarnessPushRisk[]
  effects?: ClassifiedHarnessEffect[]
  parseStatus?: HarnessParseStatus
  parseReason?: string
}): HarnessPolicyDecision {
  const approvalMode = params.approvalMode ?? 'balanced'
  if (params.parseStatus === 'malformed')
    return {
      allowed: false,
      approvalRequired: false,
      reason: `Malformed shell command: ${params.parseReason ?? 'lexical parse failed'}`,
    }
  if (approvalMode === 'allow-all')
    return { allowed: true, approvalRequired: false }
  if (params.parseStatus === 'unsupported' && !params.hasMatchingApproval)
    return {
      allowed: false,
      approvalRequired: true,
      reason: `Shell effects could not be fully classified: ${params.parseReason ?? 'unsupported shell grammar'}. Explicit approval is required.`,
    }
  for (const effect of params.effects ?? []) {
    const decision = evaluateHarnessActionPolicy({
      ...effect,
      branch: effect.branch ?? params.branch,
      defaultBranch: params.defaultBranch,
      hasMatchingApproval: params.hasMatchingApproval,
      approvalMode,
    })
    if (!decision.allowed) return decision
  }
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
    params.pushRisks?.length &&
    !params.hasMatchingApproval
  )
    return {
      allowed: false,
      approvalRequired: true,
      reason: `Push risks (${params.pushRisks.join(', ')}) require explicit approval for '${params.target}'.`,
    }
  if (
    params.action === 'push' &&
    params.branch &&
    params.defaultBranch === params.branch
  ) {
    if (!params.hasMatchingApproval) {
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

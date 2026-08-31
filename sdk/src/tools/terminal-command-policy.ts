import path from 'node:path'

export type TerminalPermissionProfile =
  | 'read-only'
  | 'librarian-read-only'
  | 'git-commit'
  | 'dependency-mutation'
  | 'validation-diagnosis'
  | 'tmux-test'
  | 'workspace-write'
  | 'full-access'

export type TerminalPolicyDecision =
  | { allowed: true }
  | { allowed: false; reason: string }

const WORKSPACE_DENY_PATTERNS: Array<[RegExp, string]> = [
  [/^(?:sudo|su)\b/i, 'privilege escalation is not allowed'],
  [
    /^(?:apt|apt-get|dnf|yum|pacman|brew|choco|winget)\b/i,
    'system package management is not allowed',
  ],
  [/\brm\s+-[^\n]*r[^\n]*\s+\/(?:\s|$)/i, 'root deletion is forbidden'],
  [
    /^git\s+push\b[\s\S]*(?:--force(?:-with-lease)?|-f\b|--delete\b)/i,
    'force and delete pushes are not allowed',
  ],
]

const WORKSPACE_ENV_DUMP_REASON =
  'dumping the inherited process environment is not allowed'
const READ_ONLY_ENV_DUMP_REASON =
  'dumping or mutating the process environment is not allowed'

/**
 * Dump-adjacent utilities. A fragment that cannot be classified structurally
 * but still names one of these fails closed instead of being allowed.
 */
const ENV_DUMP_UTILITY_PATTERN = /\b(?:printenv|env|export|set)\b/i

/**
 * True when `set` arguments are only shell option toggles (`-e`, `+x`,
 * `-o pipefail`, `-euo pipefail`, …). Positional/`--` forms are not safe:
 * they can rewrite `$@` rather than just enable errexit/pipefail.
 */
function isSafeShellSetOptions(rest: string): boolean {
  const trimmed = rest.trim()
  if (!trimmed) return false
  const tokens = trimmed.split(/\s+/)
  let index = 0
  while (index < tokens.length) {
    const token = tokens[index]
    if (!/^[+-][A-Za-z]+$/.test(token)) return false
    // `-o` / `+o` (alone or at the end of a cluster like `-euo`) consume the
    // next token as the option name (`pipefail`, `noclobber`, …).
    if (token.slice(1).endsWith('o')) {
      const optionName = tokens[index + 1]
      if (!optionName || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(optionName)) {
        return false
      }
      index += 2
      continue
    }
    index += 1
  }
  return true
}

/** `export NAME` / `export NAME=value` (possibly repeated); not `export -p`. */
function isExportAssignmentForm(rest: string): boolean {
  const tokens = rest.trim().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return false
  return tokens.every(
    (token) =>
      /^[A-Za-z_][A-Za-z0-9_]*$/.test(token) ||
      /^[A-Za-z_][A-Za-z0-9_]*=/.test(token),
  )
}

/**
 * `env` with a real utility to run after optional POSIX assignments/options.
 * Bare `env` and assignment-only forms dump the environment and stay denied.
 */
function envRestHasCommand(rest: string): boolean {
  return envRestUtilityBasename(rest) !== undefined
}

/**
 * Basename of the utility `env` would exec after options/assignments, or
 * `undefined` when the rest is dump-only / unparseable.
 */
function envRestUtilityBasename(rest: string): string | undefined {
  const tokens = rest.trim().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return undefined
  let index = 0
  let optionsEnded = false
  while (index < tokens.length) {
    const token = tokens[index]
    if (!optionsEnded && token === '--') {
      optionsEnded = true
      index += 1
      continue
    }
    if (
      !optionsEnded &&
      (token === '-i' ||
        token === '--ignore-environment' ||
        token === '-0' ||
        token === '--null')
    ) {
      // `-0`/`--null` are GNU dump-format flags (null-terminated lines). Skip
      // like `-i` so bare `env -0` stays dump-only while `env -0 true` keeps a
      // utility. Unknown/clustered dash options still fail closed below.
      index += 1
      continue
    }
    if (!optionsEnded && (token === '-u' || token === '--unset')) {
      if (!tokens[index + 1]) return undefined
      index += 2
      continue
    }
    if (!optionsEnded && token.startsWith('--unset=')) {
      index += 1
      continue
    }
    if (!optionsEnded && token.startsWith('-')) {
      // Unknown/clustered env options: fail closed (treat as non-run form).
      return undefined
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
      index += 1
      continue
    }
    return token.split('/').filter(Boolean).at(-1)?.toLowerCase() ?? undefined
  }
  return undefined
}

/** Read-only: `-a`/`allexport` and `-x`/`xtrace` mutate or mirror the environment. */
function hasMutationOrientedShellSetOptions(rest: string): boolean {
  const tokens = rest.trim().split(/\s+/).filter(Boolean)
  let index = 0
  while (index < tokens.length) {
    const token = tokens[index]
    if (!/^[+-][A-Za-z]+$/.test(token)) return false
    const body = token.slice(1)
    if (body.endsWith('o')) {
      const optionName = tokens[index + 1]?.toLowerCase()
      if (optionName === 'allexport' || optionName === 'xtrace') return true
      if (/[ax]/i.test(body.slice(0, -1))) return true
      index += 2
      continue
    }
    if (/[ax]/i.test(body)) return true
    index += 1
  }
  return false
}

function classifyShellSetIssue(
  rest: string,
  style: 'workspace' | 'read-only',
  reason: string,
): string | undefined {
  if (!isSafeShellSetOptions(rest)) return reason
  if (style === 'read-only' && hasMutationOrientedShellSetOptions(rest)) {
    return reason
  }
  return undefined
}

function classifyExportIssue(
  rest: string,
  style: 'workspace' | 'read-only',
  reason: string,
): string | undefined {
  if (!rest || /^-p(?:\s|$)/i.test(rest)) return reason
  if (isExportAssignmentForm(rest)) {
    return style === 'read-only' ? reason : undefined
  }
  return reason
}

/**
 * Execution wrappers that only shift argv before a real utility. Unwrapped
 * during env-dump resolution so `nice printenv` / `timeout 1 env` still deny.
 * Keep in sync with the wrapper names listed in TMUX_UNSAFE_EXECUTABLES.
 */
const ENVIRONMENT_DUMP_EXEC_WRAPPERS = new Set([
  'nice',
  'nohup',
  'stdbuf',
  'timeout',
  'time',
  'setsid',
  'chrt',
  'ionice',
  'flock',
  'unshare',
])

/**
 * Advance past an execution wrapper and conservative option/operand forms.
 * Returns the index of the trailing utility, or `undefined` when the wrapper
 * form is incomplete or option arity is too ambiguous to unwrap safely.
 */
function advancePastEnvironmentDumpWrapper(
  executable: string,
  tokens: TmuxShellWord[],
  wrapperIndex: number,
): number | undefined {
  let index = wrapperIndex + 1
  while (index < tokens.length) {
    const argument = tokens[index].value
    if (argument === '--') {
      index += 1
      break
    }
    if (!(argument.startsWith('-') && argument !== '-')) break
    index += 1
    // Separate numeric option args only (`nice -n 10`, `timeout -s 9`, …).
    // Non-numeric next tokens are treated as the utility (`time -p printenv`).
    const next = tokens[index]?.value
    if (next && !next.startsWith('-') && /^-?\d/.test(next)) {
      index += 1
    }
  }
  // Positional preamble required before the utility for some wrappers.
  if (
    index < tokens.length &&
    (executable === 'timeout' || executable === 'flock')
  ) {
    index += 1
  } else if (
    index < tokens.length &&
    (executable === 'chrt' || executable === 'nice') &&
    /^-?\d/.test(tokens[index].value)
  ) {
    index += 1
  }
  return index < tokens.length ? index : undefined
}

/**
 * Resolve dump builtins after leading assignments, `env` wrappers, `command`,
 * `busybox` applet launchers, execution wrappers (`nice`/`timeout`/…), and
 * path basenames. Unlike resolveTmuxCommand, a terminal `env` with no utility
 * is returned as `env` (dump) rather than an unsafe wrapper.
 */
function resolveEnvironmentDumpCommand(segment: string): {
  executable: string
  arguments: string[]
} {
  const tokens = tokenizeTmuxShellWords(segment)
  if (!tokens) return { executable: '__unsafe-tmux-wrapper__', arguments: [] }
  let index = 0

  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index]?.value ?? '')) {
    index += 1
  }

  while (index < tokens.length) {
    const token = tokens[index]
    const executable = token.value
      .split('/')
      .filter(Boolean)
      .at(-1)
      ?.toLowerCase()
    if (!executable || !/^[a-z0-9._+-]+$/.test(executable)) {
      return { executable: '__unsafe-tmux-wrapper__', arguments: [] }
    }

    if (executable === 'env') {
      index += 1
      let optionsEnded = false
      while (index < tokens.length) {
        const argument = tokens[index].value
        if (!optionsEnded && argument === '--') {
          optionsEnded = true
          index += 1
        } else if (
          !optionsEnded &&
          (argument === '-i' ||
            argument === '--ignore-environment' ||
            argument === '-0' ||
            argument === '--null')
        ) {
          // Skip GNU null-terminated dump flags like `-i` so bare `env -0`
          // remains dump-only while `env -0 true` continues to the utility.
          index += 1
        } else if (
          !optionsEnded &&
          (argument === '-u' || argument === '--unset')
        ) {
          if (!tokens[index + 1]) {
            return { executable: '__unsafe-tmux-wrapper__', arguments: [] }
          }
          index += 2
        } else if (!optionsEnded && argument.startsWith('--unset=')) {
          index += 1
        } else if (!optionsEnded && argument.startsWith('-')) {
          return { executable: '__unsafe-tmux-wrapper__', arguments: [] }
        } else if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(argument)) {
          index += 1
        } else {
          break
        }
      }
      if (index >= tokens.length) {
        return { executable: 'env', arguments: [] }
      }
      continue
    }
    if (executable === 'command') {
      index += 1
      // POSIX `command -p/-v/-V` are safe to unwrap; any other dash option is
      // dump-ambiguous and fails closed via the unsafe wrapper marker.
      while (index < tokens.length) {
        const argument = tokens[index].value
        if (argument === '--') {
          index += 1
          break
        }
        if (argument.startsWith('-')) {
          if (/^-[pvV]+$/.test(argument)) {
            index += 1
            continue
          }
          return { executable: '__unsafe-tmux-wrapper__', arguments: [] }
        }
        break
      }
      if (index >= tokens.length) {
        return { executable: '__unsafe-tmux-wrapper__', arguments: [] }
      }
      continue
    }
    // busybox is an applet launcher (`busybox env`, `/usr/bin/busybox printenv`).
    // Advance past it so the next token is re-classified as the real utility.
    if (executable === 'busybox') {
      index += 1
      if (index >= tokens.length) {
        return { executable: '__unsafe-tmux-wrapper__', arguments: [] }
      }
      continue
    }
    if (ENVIRONMENT_DUMP_EXEC_WRAPPERS.has(executable)) {
      const nextIndex = advancePastEnvironmentDumpWrapper(
        executable,
        tokens,
        index,
      )
      if (nextIndex === undefined) {
        return { executable: '__unsafe-tmux-wrapper__', arguments: [] }
      }
      index = nextIndex
      continue
    }
    return {
      executable,
      arguments: tokens.slice(index + 1).map((argument) => argument.raw),
    }
  }
  return { executable: '__unsafe-tmux-wrapper__', arguments: [] }
}

/**
 * Segment-level gate for env/printenv/set/export. Workspace style blocks
 * dumps but allows option-only `set`, `export NAME[=value]`, and
 * `env NAME=value cmd` when the utility is not itself a dumper. Read-only
 * also blocks env mutation forms. Wrappers (`command`, `busybox`, assignments,
 * paths, nested `env`) resolve before the dump check.
 */
function findProcessEnvironmentIssue(
  segment: string,
  style: 'workspace' | 'read-only',
): string | undefined {
  const reason =
    style === 'workspace'
      ? WORKSPACE_ENV_DUMP_REASON
      : READ_ONLY_ENV_DUMP_REASON
  const trimmed = segment.trim()

  // Bare leading builtins: preserve safe set / export assignment / env+cmd.
  const leading = /^(env|printenv|set|export)(?:\s+(.*))?$/i.exec(trimmed)
  if (leading) {
    const builtin = leading[1].toLowerCase()
    const rest = (leading[2] ?? '').trim()

    if (builtin === 'set') {
      return classifyShellSetIssue(rest, style, reason)
    }
    if (builtin === 'printenv') {
      return reason
    }
    if (builtin === 'export') {
      return classifyExportIssue(rest, style, reason)
    }
    // env: bare / assignment-only dumps; read-only treats any env as dump/mutation.
    // Workspace with a utility falls through to resolver so nested `env env true`
    // allows while `env printenv` / terminal `env` still deny.
    if (!rest || !envRestHasCommand(rest)) return reason
    if (style === 'read-only') return reason
  }

  const resolved = resolveEnvironmentDumpCommand(trimmed)
  if (resolved.executable === '__unsafe-tmux-wrapper__') {
    // Fail closed for dump-adjacent ambiguity (e.g. `command -x printenv` or
    // untokenizable junk that still names a dumper). Non-dump segments that
    // merely tokenize poorly stay allowed so ordinary workspace commands are
    // not false-denied by the env-dump gate.
    if (ENV_DUMP_UTILITY_PATTERN.test(trimmed)) {
      return reason
    }
    return undefined
  }

  if (resolved.executable === 'printenv' || resolved.executable === 'env') {
    return reason
  }
  if (resolved.executable === 'set') {
    return classifyShellSetIssue(resolved.arguments.join(' '), style, reason)
  }
  if (resolved.executable === 'export') {
    return classifyExportIssue(resolved.arguments.join(' '), style, reason)
  }
  return undefined
}

/**
 * Extract active `$(...)` / backtick / `<(...)` / `>(...)` bodies and the
 * remainder with those spans replaced by spaces. Single-quoted openers are
 * inert; double-quoted `$(` / backticks stay active. Nested parens are
 * quote-aware. Returns undefined when an opener has no matching closer.
 */
function extractSubstitutionsAndRemainder(
  command: string,
): { bodies: string[]; remainder: string } | undefined {
  const bodies: string[] = []
  let remainder = ''
  let quote: "'" | '"' | null = null
  let escaped = false

  const takeParenBody = (
    openParenIndex: number,
  ): { body: string; endIndex: number } | undefined => {
    let depth = 1
    let innerQuote: "'" | '"' | null = null
    let innerEscaped = false
    for (let index = openParenIndex + 1; index < command.length; index += 1) {
      const char = command[index]
      if (innerEscaped) {
        innerEscaped = false
        continue
      }
      if (char === '\\' && innerQuote !== "'") {
        innerEscaped = true
        continue
      }
      if (innerQuote) {
        if (char === innerQuote) innerQuote = null
        continue
      }
      if (char === "'" || char === '"') {
        innerQuote = char
        continue
      }
      if (char === '(') depth += 1
      else if (char === ')') {
        depth -= 1
        if (depth === 0) {
          return {
            body: command.slice(openParenIndex + 1, index),
            endIndex: index,
          }
        }
      }
    }
    return undefined
  }

  const takeBacktickBody = (
    openIndex: number,
  ): { body: string; endIndex: number } | undefined => {
    let innerEscaped = false
    for (let index = openIndex + 1; index < command.length; index += 1) {
      const char = command[index]
      if (innerEscaped) {
        innerEscaped = false
        continue
      }
      if (char === '\\') {
        innerEscaped = true
        continue
      }
      if (char === '`') {
        return {
          body: command.slice(openIndex + 1, index),
          endIndex: index,
        }
      }
    }
    return undefined
  }

  const takeSubstitution = (
    index: number,
    kind: 'command' | 'backtick' | 'process',
  ): { body: string; endIndex: number } | undefined => {
    if (kind === 'backtick') return takeBacktickBody(index)
    return takeParenBody(index + 1)
  }

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]
    if (escaped) {
      escaped = false
      remainder += char
      continue
    }
    if (char === '\\' && quote !== "'") {
      escaped = true
      remainder += char
      continue
    }
    if (quote) {
      if (char === quote) {
        quote = null
        remainder += char
        continue
      }
      if (
        quote === '"' &&
        (char === '`' || (char === '$' && command[index + 1] === '('))
      ) {
        const extracted = takeSubstitution(
          index,
          char === '`' ? 'backtick' : 'command',
        )
        if (!extracted) return undefined
        bodies.push(extracted.body)
        remainder += ' '
        index = extracted.endIndex
        continue
      }
      remainder += char
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      remainder += char
      continue
    }
    if (char === '`' || (char === '$' && command[index + 1] === '(')) {
      const extracted = takeSubstitution(
        index,
        char === '`' ? 'backtick' : 'command',
      )
      if (!extracted) return undefined
      bodies.push(extracted.body)
      remainder += ' '
      index = extracted.endIndex
      continue
    }
    if ((char === '<' || char === '>') && command[index + 1] === '(') {
      const extracted = takeSubstitution(index, 'process')
      if (!extracted) return undefined
      bodies.push(extracted.body)
      remainder += ' '
      index = extracted.endIndex
      continue
    }
    remainder += char
  }
  return { bodies, remainder }
}

/** Recursively collect remainder + substitution bodies for env-dump scans. */
function collectEnvDumpScanPieces(command: string): string[] | undefined {
  const extracted = extractSubstitutionsAndRemainder(command)
  if (!extracted) return undefined
  const pieces = [extracted.remainder]
  for (const body of extracted.bodies) {
    const nested = collectEnvDumpScanPieces(body)
    if (nested === undefined) {
      pieces.push(body)
    } else {
      pieces.push(...nested)
    }
  }
  return pieces
}

function findProcessEnvironmentIssueInPieces(
  pieces: string[],
  style: 'workspace' | 'read-only',
): string | undefined {
  const reason =
    style === 'workspace'
      ? WORKSPACE_ENV_DUMP_REASON
      : READ_ONLY_ENV_DUMP_REASON
  for (const piece of pieces) {
    const trimmed = piece.trim()
    if (!trimmed) continue
    // Background `&` is a real command separator for this scan: classify every
    // job instead of handing `pwd & printenv` to the first-executable resolver.
    const segments = splitReadOnlyShellSegments(trimmed, {
      backgroundAmpersand: 'split',
    })
    if (!segments) {
      // Still unparseable (unbalanced substitution, dangling separator): fail
      // closed when the piece names a dump utility, the same way the
      // `__unsafe-tmux-wrapper__` branch does.
      if (ENV_DUMP_UTILITY_PATTERN.test(trimmed)) return reason
      const issue = findProcessEnvironmentIssue(trimmed, style)
      if (issue) return issue
      continue
    }
    for (const segment of segments) {
      const issue = findProcessEnvironmentIssue(segment, style)
      if (issue) return issue
    }
  }
  return undefined
}

function findProcessEnvironmentIssueInCommand(
  command: string,
  style: 'workspace' | 'read-only',
  substitutionMode: 'fail-closed' | 'inspect-bodies' = 'fail-closed',
): string | undefined {
  const reason =
    style === 'workspace'
      ? WORKSPACE_ENV_DUMP_REASON
      : READ_ONLY_ENV_DUMP_REASON
  if (substitutionMode === 'inspect-bodies') {
    // Workspace-write: inspect substitution bodies and remaining segments
    // instead of treating every `$()` / process substitution as a dump.
    // Unextractable substitutions do not fail closed as env-dump.
    const pieces = collectEnvDumpScanPieces(command)
    if (!pieces) {
      const segments = splitReadOnlyShellSegments(command)
      if (!segments) return undefined
      return findProcessEnvironmentIssueInPieces(segments, style)
    }
    return findProcessEnvironmentIssueInPieces(pieces, style)
  }
  // Double-quoted `$(…)`/backticks stay active and can hide dumps, but
  // splitReadOnlyShellSegments only fails closed on unquoted substitution.
  // Process substitution `<(…)` / `>(…)` similarly conceals dump utilities.
  if (
    hasActiveCommandSubstitution(command) ||
    hasActiveProcessSubstitution(command)
  ) {
    return reason
  }
  const segments = splitReadOnlyShellSegments(command)
  // Unparseable composition can hide `printenv`/`env`; fail closed.
  if (!segments) {
    return reason
  }
  return findProcessEnvironmentIssueInPieces(segments, style)
}

const DEPENDENCY_MUTATION_COMMANDS = [
  /^(?:npm|pnpm|yarn|bun)\s+(?:install|add|remove|update)(?:\s|$)/i,
  /^pnpm\s+--filter\s+(?:'[^']+'|"[^"]+"|\S+)\s+(?:install|add|remove|update)(?:\s|$)/i,
  /^yarn\s+workspace\s+(?:'[^']+'|"[^"]+"|\S+)\s+(?:add|remove|upgrade)(?:\s|$)/i,
  /^bun\s+--filter\s+(?:'[^']+'|"[^"]+"|\S+)\s+(?:install|add|remove|update)(?:\s|$)/i,
  /^(?:uv|poetry)\s+(?:add|remove|sync|install|update)(?:\s|$)/i,
  /^pip(?:3)?\s+(?:install|uninstall)(?:\s|$)/i,
  /^cargo\s+(?:add|rm|remove|fetch|update)(?:\s|$)/i,
  /^go\s+(?:get|mod\s+(?:tidy|download))(?:\s|$)/i,
  /^dotnet\s+(?:add|remove)\s+package(?:\s|$)/i,
  /^dotnet\s+restore(?:\s|$)/i,
  /^(?:bundle|bundler)\s+(?:add|remove|install|update)(?:\s|$)/i,
  /^composer\s+(?:require|remove|install|update)(?:\s|$)/i,
  /^swift\s+package\s+(?:resolve|update)(?:\s|$)/i,
  /^(?:dart|flutter)\s+pub\s+(?:add|remove|get|upgrade)(?:\s|$)/i,
  /^mix\s+deps\.(?:get|update)(?:\s|$)/i,
  /^(?:mvn|mvnw|\.\/mvnw)\s+(?:dependency:resolve|dependency:go-offline)(?:\s|$)/i,
  /^(?:gradle|gradlew|\.\/gradlew)\s+(?:dependencies|buildEnvironment)(?:\s|$)/i,
]

function normalizeCommand(command: string): string {
  // Collapse only horizontal whitespace so unquoted newlines stay visible as
  // shell command separators for later composition checks.
  return command.trim().replace(/[ \t]+/g, ' ')
}

type ShellSyntaxScanState = {
  command: string
  index: number
  char: string
}

type ShellSyntaxMatcher = (state: ShellSyntaxScanState) => boolean

/** Backticks and `$(` substitution stay active unquoted and in double quotes. */
const isCommandSubstitution: ShellSyntaxMatcher = ({ command, index, char }) =>
  char === '`' || (char === '$' && command[index + 1] === '(')

/** Process substitution is active only when unquoted (not inside double quotes). */
const isProcessSubstitution: ShellSyntaxMatcher = ({ command, index, char }) =>
  (char === '<' || char === '>') && command[index + 1] === '('

/** Any `$` outside single quotes starts an expansion the policy must inspect. */
const isParameterExpansion: ShellSyntaxMatcher = ({ char }) => char === '$'

/** Composition/redirection operators count as syntax only when unquoted. */
const isShellComposition: ShellSyntaxMatcher = (state) =>
  state.char === ';' ||
  state.char === '|' ||
  state.char === '&' ||
  state.char === '<' ||
  state.char === '>' ||
  state.char === '\n' ||
  state.char === '\r' ||
  isCommandSubstitution(state)

/**
 * Shared quote/escape scanner for shell-syntax detection. Single quotes make
 * their content inert; outside single quotes a backslash escapes the next
 * character. The unquoted matcher runs outside quotes; the doubleQuoted
 * matcher runs inside double quotes, where substitution/expansion stay active.
 */
function scanActiveShellSyntax(
  command: string,
  matchers: { unquoted: ShellSyntaxMatcher; doubleQuoted?: ShellSyntaxMatcher },
): boolean {
  let quote: "'" | '"' | null = null
  let escaped = false
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]
    if (escaped) {
      escaped = false
      continue
    }
    if (char === '\\' && quote !== "'") {
      escaped = true
      continue
    }
    if (quote) {
      if (char === quote) quote = null
      else if (
        quote === '"' &&
        matchers.doubleQuoted?.({ command, index, char })
      ) {
        return true
      }
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      continue
    }
    if (matchers.unquoted({ command, index, char })) return true
  }
  return false
}

/** Detect shell operators only when they are active syntax, not quoted data. */
function hasUnquotedShellSyntax(command: string): boolean {
  // Inside double quotes, $( and backticks are still active shell syntax.
  return scanActiveShellSyntax(command, {
    unquoted: isShellComposition,
    doubleQuoted: isCommandSubstitution,
  })
}

/** Detect command substitution/backticks that execute outside single quotes. */
function hasActiveCommandSubstitution(command: string): boolean {
  return scanActiveShellSyntax(command, {
    unquoted: isCommandSubstitution,
    doubleQuoted: isCommandSubstitution,
  })
}

/** Detect unquoted process substitution `<(…)` / `>(…)` used to hide utilities. */
function hasActiveProcessSubstitution(command: string): boolean {
  return scanActiveShellSyntax(command, {
    unquoted: isProcessSubstitution,
  })
}

/** Detect active parameter expansion outside single-quoted literal data. */
function hasActiveParameterExpansion(command: string): boolean {
  return scanActiveShellSyntax(command, {
    unquoted: isParameterExpansion,
    doubleQuoted: isParameterExpansion,
  })
}

/** Detect active shell compound/control syntax outside quoted literal data. */
function hasActiveTmuxCompoundShellSyntax(command: string): boolean {
  const keywords = new Set([
    'if',
    'then',
    'fi',
    'for',
    'while',
    'until',
    'case',
    'esac',
    'do',
    'done',
  ])
  let quote: "'" | '"' | null = null
  let escaped = false
  let token = ''

  const flushToken = (): boolean => {
    if (keywords.has(token)) return true
    token = ''
    return false
  }

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]
    if (escaped) {
      escaped = false
      continue
    }
    if (char === '\\' && quote !== "'") {
      escaped = true
      continue
    }
    if (quote) {
      if (char === quote) quote = null
      continue
    }
    if (char === "'" || char === '"') {
      if (flushToken()) return true
      quote = char
      continue
    }
    if (char === '{' || char === '}' || char === '(' || char === ')') {
      return true
    }
    if (/[A-Za-z0-9_]/.test(char)) {
      token += char
      continue
    }
    if (flushToken()) return true
  }
  return flushToken()
}

const TMUX_UNSAFE_EXECUTABLES = new Set([
  // Execution wrappers can conceal a prohibited command behind option parsing
  // and must fail closed after env/command resolver normalization.
  'nice',
  'nohup',
  'stdbuf',
  'timeout',
  'time',
  'setsid',
  'chrt',
  'ionice',
  'flock',
  'unshare',
  // Direct writers and archive extractors can mutate arbitrary workspace paths.
  // Deny them by normalized executable so quoted flags and wrapper forms cannot evade it.
  'sed',
  'tar',
  'unzip',
  'patch',
  'rsync',
  'cpio',
  '7z',
  'unrar',
  'awk',
  'bash',
  'busybox',
  'bun',
  'chgrp',
  'chmod',
  'chown',
  'dash',
  'dd',
  'deno',
  'eval',
  'find',
  'fish',
  'ln',
  'lua',
  'make',
  'node',
  'nodejs',
  'perl',
  'php',
  'python',
  'python3',
  'ruby',
  'sh',
  'shred',
  'source',
  // Writers not caught by hasUnsafeTmuxFileMutation (rm/mv/cp/mkdir/touch/
  // truncate/install executables) or the redirection scanner: bare
  // `tee path`, `command tee`, `env X=1 tee`, `/usr/bin/tee` are the
  // container-masquerade side channel for workspace writes. Keep `tee` here.
  'tee',
  'xargs',
  'zsh',
  '__unsafe-tmux-wrapper__',
])

type TmuxCommand = {
  executable: string
  arguments: string[]
}

type TmuxShellWord = {
  raw: string
  value: string
}

/** Tokenize shell words while applying quote removal and executable escapes. */
function tokenizeTmuxShellWords(segment: string): TmuxShellWord[] | undefined {
  const tokens: TmuxShellWord[] = []
  let raw = ''
  let value = ''
  let quote: "'" | '"' | null = null
  let hasWord = false

  const flushWord = (): void => {
    if (!hasWord) return
    tokens.push({ raw, value })
    raw = ''
    value = ''
    hasWord = false
  }

  for (let index = 0; index < segment.length; index += 1) {
    const char = segment[index]
    if (!quote && /\s/.test(char)) {
      flushWord()
      continue
    }
    hasWord = true
    raw += char
    if (char === "'" && quote !== '"') {
      quote = quote === "'" ? null : "'"
      continue
    }
    if (char === '"' && quote !== "'") {
      quote = quote === '"' ? null : '"'
      continue
    }
    if (char === '\\' && quote !== "'") {
      const escaped = segment[index + 1]
      if (escaped === undefined) return undefined
      if (!quote || /[$`"\\\n]/.test(escaped)) {
        raw += escaped
        value += escaped
        index += 1
        continue
      }
    }
    value += char
  }

  if (quote) return undefined
  flushWord()
  return tokens
}

/**
 * Resolves the executable at the start of a shell segment after consuming
 * leading POSIX assignment words and unwrapping `env` assignments/options and
 * `command` options. Shell quote removal and backslash escaping are applied
 * only to resolver-controlled words; arguments retain their raw quoting as
 * inert data. Unsupported, unresolved, or malformed executables fail closed.
 */
function resolveTmuxCommand(segment: string): TmuxCommand | undefined {
  const tokens = tokenizeTmuxShellWords(segment)
  if (!tokens) return { executable: '__unsafe-tmux-wrapper__', arguments: [] }
  let index = 0

  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index]?.value ?? '')) {
    index += 1
  }

  while (index < tokens.length) {
    const token = tokens[index]
    const executable = token.value
      .split('/')
      .filter(Boolean)
      .at(-1)
      ?.toLowerCase()
    if (!executable || !/^[a-z0-9._+-]+$/.test(executable)) {
      return { executable: '__unsafe-tmux-wrapper__', arguments: [] }
    }

    if (executable === 'env') {
      index += 1
      let optionsEnded = false
      while (index < tokens.length) {
        const argument = tokens[index].value
        if (!optionsEnded && argument === '--') {
          optionsEnded = true
          index += 1
        } else if (
          !optionsEnded &&
          (argument === '-i' || argument === '--ignore-environment')
        ) {
          index += 1
        } else if (
          !optionsEnded &&
          (argument === '-u' || argument === '--unset')
        ) {
          if (!tokens[index + 1]) {
            return { executable: '__unsafe-tmux-wrapper__', arguments: [] }
          }
          index += 2
        } else if (!optionsEnded && argument.startsWith('--unset=')) {
          index += 1
        } else if (!optionsEnded && argument.startsWith('-')) {
          return { executable: '__unsafe-tmux-wrapper__', arguments: [] }
        } else if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(argument)) {
          index += 1
        } else {
          break
        }
      }
      continue
    }
    if (executable === 'command') {
      index += 1
      if (tokens[index]?.value === '--') index += 1
      else if ((tokens[index]?.value ?? '').startsWith('-')) {
        return { executable: '__unsafe-tmux-wrapper__', arguments: [] }
      }
      continue
    }
    return {
      executable,
      arguments: tokens.slice(index + 1).map((argument) => argument.raw),
    }
  }
  return { executable: '__unsafe-tmux-wrapper__', arguments: [] }
}

function getTmuxExecutable(segment: string): string | undefined {
  return resolveTmuxCommand(segment)?.executable
}

function hasUnsafeTmuxExecutable(command: string): boolean {
  const segments = splitReadOnlyShellSegments(command)
  return (
    segments?.some((segment) => {
      const executable = getTmuxExecutable(segment)
      return (
        executable === '__unsafe-tmux-wrapper__' ||
        (executable !== undefined && TMUX_UNSAFE_EXECUTABLES.has(executable))
      )
    }) ?? true
  )
}

function hasShellInterpreterEscape(command: string): boolean {
  return /^(?:eval\b|source\b|\.\s+)/i.test(command.trim())
}

function findTraversalPath(command: string): string | undefined {
  const tokens = command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? []
  for (const rawToken of tokens) {
    const token = rawToken.replace(/^["']|["',);]+$/g, '')
    if (token.split(/[=\\/]+/).includes('..')) return rawToken
  }
  return undefined
}

/**
 * Split a command on unquoted `|`, `;`, `&&`, and newlines. A single
 * background `&` is rejected by default (read-only containment); callers that
 * only need per-command classification pass `backgroundAmpersand: 'split'` to
 * treat it as an ordinary separator.
 */
function splitReadOnlyShellSegments(
  command: string,
  options: { backgroundAmpersand: 'reject' | 'split' } = {
    backgroundAmpersand: 'reject',
  },
): string[] | undefined {
  const segments: string[] = []
  let quote: "'" | '"' | null = null
  let escaped = false
  let start = 0
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]
    if (escaped) {
      escaped = false
      continue
    }
    if (char === '\\' && quote !== "'") {
      escaped = true
      continue
    }
    if (quote) {
      if (char === quote) quote = null
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      continue
    }
    if (char === '`' || (char === '$' && command[index + 1] === '(')) {
      return undefined
    }
    if (
      char === '&' &&
      command[index - 1] === '>' &&
      /[012]/.test(command[index + 1] ?? '')
    ) {
      continue
    }
    if (
      char === '&' &&
      command[index + 1] !== '&' &&
      options.backgroundAmpersand === 'reject'
    ) {
      return undefined
    }
    if (
      char === '|' ||
      char === ';' ||
      char === '&' ||
      char === '\n' ||
      char === '\r'
    ) {
      segments.push(command.slice(start, index).trim())
      // Treat \r\n as one separator; collapse ||, &&, and ;; the same as before.
      if (char === '\r' && command[index + 1] === '\n') {
        index += 1
      } else if (
        (char === '|' || char === ';' || char === '&') &&
        command[index + 1] === char
      ) {
        index += 1
      }
      start = index + 1
    }
  }
  segments.push(command.slice(start).trim())
  return segments.every(Boolean) ? segments : undefined
}

function stripSafeReadOnlyRedirections(segment: string): string | undefined {
  const withoutNullRedirects = segment.replace(
    /(?:^|\s)[012]?>\s*\/dev\/null(?=\s|$)/g,
    ' ',
  )
  const withoutDescriptorRedirects = withoutNullRedirects.replace(
    /(?:^|\s)[012]?>&[012](?=\s|$)/g,
    ' ',
  )
  if (/[<>]/.test(withoutDescriptorRedirects)) return undefined
  return normalizeCommand(withoutDescriptorRedirects)
}

/**
 * tmux-test commands execute through a shell, so a policy-time path check
 * cannot safely authorize a later filesystem open. Only output discarded to
 * /dev/null is permitted; fixture writes require a dedicated executor that
 * owns an atomically-created private directory.
 */
function hasUnsafeTmuxWriteRedirection(command: string): boolean {
  let quote: "'" | '"' | null = null
  let escaped = false
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]
    if (escaped) {
      escaped = false
      continue
    }
    if (char === '\\' && quote !== "'") {
      escaped = true
      continue
    }
    if (quote) {
      if (char === quote) quote = null
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      continue
    }
    if (char !== '>') continue

    let targetStart = index + 1
    if (command[targetStart] === '>' || command[targetStart] === '|')
      targetStart += 1
    while (/\s/.test(command[targetStart] ?? '')) targetStart += 1
    if (
      command[targetStart] === '&' &&
      /[012]/.test(command[targetStart + 1] ?? '')
    ) {
      continue
    }
    const target = command.slice(targetStart).match(/^\S+/)?.[0] ?? ''
    if (target !== '/dev/null') return true
  }
  return false
}

function hasUnsafeTmuxSedInPlace(command: string): boolean {
  const segments = splitReadOnlyShellSegments(command)
  return (
    segments?.some((segment) => {
      const resolved = resolveTmuxCommand(segment)
      return (
        resolved?.executable === 'sed' &&
        resolved.arguments.some(
          (argument) =>
            argument === '--in-place' ||
            argument.startsWith('--in-place=') ||
            /^-[A-Za-z]*i[A-Za-z]*(?:\..*)?$/.test(argument),
        )
      )
    }) ?? true
  )
}

/**
 * A shell command can replace a checked /tmp path before opening it. Deny all
 * file mutation commands until fixture creation is owned by a no-follow,
 * directory-FD-relative terminal executor.
 */
function hasUnsafeTmuxFileMutation(command: string): boolean {
  const mutationExecutables = new Set([
    'rm',
    'mv',
    'cp',
    'mkdir',
    'touch',
    'truncate',
    'install',
  ])
  const segments = splitReadOnlyShellSegments(command)
  return (
    segments?.some((segment) => {
      const resolved = resolveTmuxCommand(segment)
      return Boolean(resolved && mutationExecutables.has(resolved.executable))
    }) ?? true
  )
}

/**
 * Traversal guard for validation-diagnosis and workspace-write: rejects only
 * `..` tokens whose path resolves outside the project root, so in-project
 * siblings such as `../src/languages` or `cd ..` from a package subdirectory
 * stay allowed. Absolute tokens are resolved directly. Relative tokens resolve
 * against `cwd` when it is provided and itself contained in the project;
 * otherwise they resolve against the project root (the previous conservative
 * behavior). A `cwd` outside the project fail-closes relative `..` tokens.
 * The final resolved path must stay inside projectRoot. Absolute paths that
 * escape the project are also rejected by findOutsideAbsolutePath.
 */
function findEscapingTraversalPath(
  command: string,
  projectRoot: string,
  cwd?: string,
): string | undefined {
  const root = path.resolve(projectRoot)
  let resolveBase = root
  let cwdOutsideProject = false
  if (cwd !== undefined) {
    const resolvedCwd = path.resolve(cwd)
    const relativeCwd = path.relative(root, resolvedCwd)
    if (relativeCwd.startsWith('..') || path.isAbsolute(relativeCwd)) {
      cwdOutsideProject = true
    } else {
      resolveBase = resolvedCwd
    }
  }
  const tokens = command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? []
  for (const rawToken of tokens) {
    const token = rawToken.replace(/^["']|["',);]+$/g, '')
    if (!token.split(/[=\\/]+/).includes('..')) continue
    if (!path.isAbsolute(token) && cwdOutsideProject) return rawToken
    const resolved = path.isAbsolute(token)
      ? path.resolve(token)
      : path.resolve(resolveBase, token)
    const relative = path.relative(root, resolved)
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      return rawToken
    }
  }
  return undefined
}

/**
 * Diagnostic write namespace for the validation-diagnosis profile. A repro
 * fixture must live in a directory named `repro` or `diagnostics` anywhere in
 * the project (`repro/fixture.log`, `packages/foo/diagnostics/run.json`).
 * Containment inside the project root is not sufficient on its own: manifests
 * such as `package.json` are executed later by `bun run <script>`, and source
 * files are owned by edit_transaction, so a read-only diagnosis profile must
 * not be able to write either.
 */
const DIAGNOSTIC_WRITE_DIRECTORIES = new Set(['repro', 'diagnostics'])

/** Output extensions no project tooling loads as code, a test, or a manifest. */
const DIAGNOSTIC_WRITE_EXTENSIONS = new Set([
  '.log',
  '.txt',
  '.out',
  '.err',
  '.diff',
  '.json',
  '.csv',
])

/** Manifest basenames tooling auto-loads even from a nested directory. */
const DIAGNOSTIC_WRITE_RESERVED_BASENAMES = new Set([
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'jsconfig.json',
])

/**
 * Write-target guard for the validation-diagnosis profile: only plain,
 * unquoted, expansion-free paths that resolve to a diagnostic output file
 * inside the project root are allowed (e.g. `cat > repro/fixture.log <<'EOF'`).
 * The resolved path must sit under a `repro`/`diagnostics` directory and carry
 * an inert output extension, so `cat > package.json` or `cat > src/index.ts`
 * stays blocked. Absolute targets must stay inside the project, and targets
 * with `..` segments must not resolve outside it; anything else
 * (tilde/variable/backtick expansion or shell escaping) is unsafe and keeps
 * the command blocked.
 */
function isDiagnosticWriteTargetSafe(
  target: string,
  projectRoot: string,
): boolean {
  // The shell removes backslashes before resolving a redirect target. Reject
  // them before containment checks so `\../outside` cannot escape projectRoot.
  if (target.length === 0 || /[\\"'`~$]/.test(target)) return false
  const root = path.resolve(projectRoot)
  const resolved = path.isAbsolute(target)
    ? path.resolve(target)
    : path.resolve(root, target)
  const relative = path.relative(root, resolved)
  if (
    relative.length === 0 ||
    relative.startsWith('..') ||
    path.isAbsolute(relative)
  ) {
    return false
  }
  // `relative` is already normalized, so a directory match cannot be forged
  // with `repro/../package.json` (that resolves to a top-level basename).
  const segments = relative.split(/[/\\]+/)
  const basename = segments.at(-1) ?? ''
  return (
    segments
      .slice(0, -1)
      .some((segment) => DIAGNOSTIC_WRITE_DIRECTORIES.has(segment)) &&
    !DIAGNOSTIC_WRITE_RESERVED_BASENAMES.has(basename.toLowerCase()) &&
    DIAGNOSTIC_WRITE_EXTENSIONS.has(path.extname(basename).toLowerCase())
  )
}

/**
 * One shared source for a diagnostic write-target token character: anything
 * that neither whitespace nor a shell operator would end the token at. Both
 * patterns below are composed from it so the two cannot drift into accepting
 * different targets.
 */
const DIAGNOSTIC_WRITE_TARGET_TOKEN = String.raw`[^\s<>|;&]`

/**
 * `>`/`>>` writes and their target, for stripDiagnosticRedirections. The
 * capture order is part of the replacer contract: group 1 is the leading
 * boundary (re-emitted in place of the stripped redirection) and group 2 is the
 * target.
 *
 * The target repeats `*`, not `+`, on purpose: a `>` with no target must still
 * match so the EMPTY target reaches isDiagnosticWriteTargetSafe, whose first
 * check (`target.length === 0`) rejects it. With `+` a bare `>` would not match
 * at all and would slip through unchecked.
 */
const DIAGNOSTIC_WRITE_REDIRECTION_PATTERN = new RegExp(
  String.raw`(^|\s)[012]?>>?(?![&0-9])\s*(${DIAGNOSTIC_WRITE_TARGET_TOKEN}*)`,
  'g',
)

/**
 * The single accepted heredoc shape (`cat > <target> <<'EOF'` … `EOF`). Group 1
 * is the target, group 2 the quoted delimiter, and group 3 the body, so the
 * `\2` backreference pins the terminator to the opening delimiter.
 *
 * The target repeats `+`, not `*`, on purpose: this is a full-string shape
 * match with no target-safety callback to fail closed on an empty capture, so
 * a `cat >` with no file must simply not match.
 */
const BOUNDED_DIAGNOSTIC_HEREDOC_PATTERN = new RegExp(
  String.raw`^\s*cat\s+>\s*(${DIAGNOSTIC_WRITE_TARGET_TOKEN}+)\s*<<\s*'([A-Za-z_][A-Za-z0-9_]*)'\s*\r?\n([\s\S]*)\r?\n\2\s*$`,
)

/**
 * validation-diagnosis variant of stripSafeReadOnlyRedirections: on top of
 * the base /dev/null and descriptor redirects, it also strips heredoc
 * operators and `>`/`>>` writes whose targets are diagnostic output files
 * inside the project (see isDiagnosticWriteTargetSafe). Any other `<`/`>` —
 * input redirections, process substitution, writes outside the project, or
 * writes to manifests/source — still returns undefined so the command is
 * rejected as an unsafe shell redirection.
 */
function stripDiagnosticRedirections(
  segment: string,
  projectRoot: string,
): string | undefined {
  const withoutHeredocs = segment.replace(
    /<<-?\s*(?:'[^']*'|"[^"]*"|\\?\S+)/g,
    ' ',
  )
  let safe = true
  const withoutWrites = withoutHeredocs.replace(
    DIAGNOSTIC_WRITE_REDIRECTION_PATTERN,
    (match, leading: string, rawTarget: string) => {
      if (!isDiagnosticWriteTargetSafe(rawTarget, projectRoot)) {
        safe = false
        return match
      }
      return leading
    },
  )
  if (!safe) return undefined
  return stripSafeReadOnlyRedirections(withoutWrites)
}

/**
 * Accept one bounded, literal heredoc only for the diagnostic `cat > file`
 * shape. Its quoted delimiter makes the body inert shell data; stripping it
 * before general normalization prevents body text from being treated as shell
 * syntax or a second command. The full-string match rejects a missing or
 * trailing command after the terminator.
 */
function stripBoundedDiagnosticHeredoc(command: string): string | undefined {
  const match = command.match(BOUNDED_DIAGNOSTIC_HEREDOC_PATTERN)
  if (
    !match ||
    match[3].length > 65_536 ||
    match[3].includes('\0') ||
    match[3].split(/\r?\n/).includes(match[2])
  ) {
    return undefined
  }
  return `cat > ${match[1]}`
}

function findReadOnlyDanger(command: string): string | undefined {
  const mutation = findReadOnlyMutation(command)
  if (mutation) return mutation

  if (
    /^tee\b/i.test(command) &&
    !/^tee(?:\s+(?:-a\s+)?(?:\/tmp\/[^\s]+|\/dev\/null))?$/i.test(command)
  ) {
    return 'tee may only write diagnostic output under /tmp in read-only mode'
  }
  if (DEPENDENCY_MUTATION_COMMANDS.some((pattern) => pattern.test(command))) {
    return 'dependency mutation is not allowed in read-only mode'
  }

  const envIssue = findProcessEnvironmentIssue(command, 'read-only')
  if (envIssue) return envIssue

  const dangerousCommands: Array<[RegExp, string]> = [
    [
      /^(?:(?:env\s+)?(?:command\s+)?(?:bash|sh|zsh|dash|fish)|eval|source)\b/i,
      'shell indirection requires an explicit full-access workflow',
    ],
    [/^(?:sudo|su)\b/i, 'privilege escalation is not allowed'],
    [
      /^(?:perl|awk|sed|ruby)\b[\s\S]*?(?:--in-place(?:=|\s|$)|\s-[a-zA-Z]*i(?:\.[^\s]*)?(?=\s|$))/i,
      'in-place file edits are not allowed in read-only mode',
    ],
    [
      /^(?:python(?:3)?|node|bun|deno|ruby|perl)\s+(?:--?(?:eval|print)\b|-[a-zA-Z]*[cep][a-zA-Z]*)[\s\S]*(?:process\s*\.\s*env|os\s*\.\s*environ|\bENV\b|\bgetenv\b)/i,
      'interpreter one-liners that read the process environment are not allowed in read-only mode',
    ],
    [
      /^(?:rm|mv|cp|mkdir|rmdir|touch|truncate|install|ln|chmod|chown|chgrp|dd|shred)\b/i,
      'filesystem mutation is not allowed in read-only mode',
    ],
    [
      /^git\s+(?:add|commit|push|reset|clean|checkout|switch|merge|rebase|restore|stash|cherry-pick|tag|branch\s+-(?:d|D))\b/i,
      'Git mutation is not allowed in read-only mode',
    ],
    [
      /^(?:git\s+clone|curl\b[\s\S]*(?:\s-X\s*(?:POST|PUT|PATCH|DELETE)\b|\s(?:-d|--data(?:-raw)?|-T|--upload-file)\b)|wget\b[\s\S]*(?:\s-O\b|\s--output-document\b))/i,
      'network mutation is not allowed in read-only mode',
    ],
    [
      /^(?:apt|apt-get|dnf|yum|pacman|brew|choco|winget|make\s+install)\b/i,
      'package or system mutation is not allowed in read-only mode',
    ],
    [
      /^(?:kubectl|terraform|helm|docker|podman)\s+(?:apply|create|delete|destroy|exec|run|push|build)\b/i,
      'deployment or container mutation is not allowed in read-only mode',
    ],
    [
      /^(?:kubectl)\s+(?:patch|replace|scale|rollout\s+restart|set|label|annotate)\b/i,
      'deployment mutation is not allowed in read-only mode',
    ],
    [
      /^gh\s+(?:pr\s+(?:create|merge|close|reopen|ready|review)|release\s+(?:create|delete|edit|upload)|workflow\s+run|repo\s+(?:create|delete))\b/i,
      'GitHub mutation is not allowed in read-only mode',
    ],
    [
      /^(?:xargs|find)\b[\s\S]*\b(?:rm|mv|cp|mkdir|touch|chmod|chown|install|bash|sh|python|node)\b/i,
      'indirect command execution or filesystem mutation is not allowed in read-only mode',
    ],
    [
      /^(?:kill|pkill|killall|shutdown|reboot|poweroff|mount|umount)\b/i,
      'process or system mutation is not allowed in read-only mode',
    ],
    [
      /^(?:(?:python(?:3)?|node|bun|deno|ruby|perl)\s+(?:-c|-e)|blender\b[\s\S]*--python(?:-expr)?\b)[\s\S]*(?:open\s*\(|write\s*\(|unlink\s*\(|rmdir\s*\(|mkdir\s*\(|subprocess|child_process|exec\s*\(|system\s*\(|remove\s*\()/i,
      'embedded script writes or executes subprocesses in read-only mode',
    ],
  ]
  return dangerousCommands.find(([pattern]) => pattern.test(command))?.[1]
}

function findReadOnlyMutation(command: string): string | undefined {
  if (/[<>]/.test(command)) return 'shell redirection is not read-only'
  if (
    /^find\b[\s\S]*(?:-delete\b|-exec(?:dir)?\b|-ok(?:dir)?\b|-fprint(?:f)?\b)/i.test(
      command,
    )
  ) {
    return 'find mutation and command-execution actions are not read-only'
  }
  if (
    /^sed\b[\s\S]*(?:--in-place(?:=|\s|$)|(?:^|\s)-i(?:\s|$|[^\s]))/i.test(
      command,
    )
  ) {
    return 'in-place sed edits are not read-only'
  }
  if (/^sed\b[\s\S]*(?:["']|[;\s])(?:w|W|e)\s+/.test(command)) {
    return 'sed write and execute commands are not read-only'
  }
  return undefined
}

/**
 * Remove -m/--message arguments from a git commit command so the message
 * body (inert data to git) is not scanned for absolute paths. Handles
 * double-quoted, single-quoted, and bare-word message values, including
 * multiline quoted strings.
 */
function stripCommitMessageArgs(command: string): string {
  return command
    .replace(
      /(?:^|\s)(?:-m|--message)(?:=(?:"[^"]*"|'[^']*'|[^\s"']+)|\s+(?:"[^"]*"|'[^']*'|[^\s"']+))/g,
      ' ',
    )
    .trim()
}

/**
 * Junk/placeholder commit-message subjects (whole-subject, case-insensitive,
 * after stripping surrounding quotes/whitespace/punctuation). A commit whose
 * -m/--message subject is one of these is a policy probe or a content-free
 * placeholder rather than a real change description, so the git-commit
 * profile rejects it outright.
 */
const PLACEHOLDER_COMMIT_SUBJECTS = new Set([
  'probe',
  'test',
  'wip',
  'tmp',
  'temp',
  'asdf',
  'foo',
  'bar',
  'x',
  'xx',
  'xxx',
  'commit',
  'update',
  'changes',
  'stuff',
  'misc',
  'test commit',
  'wip commit',
])

/**
 * Capturing counterpart to stripCommitMessageArgs: extract each -m/--message
 * value (double-quoted, single-quoted, --message=value, and bare-word forms;
 * multiple flags are all captured) and report whether any message subject is
 * a junk/placeholder word. Matching is whole-subject (never substring), so a
 * real message that merely contains a placeholder word (e.g. "Add probe
 * support for X") stays allowed while a bare "probe"/"wip"/"test" does not.
 */
function hasPlaceholderCommitMessage(command: string): boolean {
  for (const match of command.matchAll(
    /(?:^|\s)(?:-m|--message)(?:=|\s+)("[^"]*"|'[^']*'|[^\s"']+)/g,
  )) {
    const subject = match[1]
      .replace(/^["']+|["']+$/g, '')
      .trim()
      .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
      .toLowerCase()
    if (subject.length > 0 && PLACEHOLDER_COMMIT_SUBJECTS.has(subject)) {
      return true
    }
  }
  return false
}

function hasUnsafeReadOnlyGitOption(command: string): boolean {
  return (
    /(?:^|\s)--(?:output|exec-path)(?:=|\s|$)/i.test(command) ||
    /(?:^|\s)--(?:ext-diff|textconv)(?:\s|$)/i.test(command) ||
    /(?:^|\s)-o(?:\s|$)/i.test(command)
  )
}

/**
 * Read-only git inspection commands for the git-commit profile: the
 * ancestry/branch/remote inspectors unioned with the existing inspect verbs.
 * These are the only git commands allowed as segments of shell composition
 * (`|`/`;`/`&&`); add/commit/push stay single-command-only. A segment with
 * active shell syntax (a redirection, or substitution hidden inside quotes)
 * never counts as read-only.
 */
function isReadOnlyGitCommand(command: string): boolean {
  // Quote-aware: double-quoted `$(`/backticks stay dangerous; quoted `<>` does not.
  if (hasActiveCommandSubstitution(command)) return false
  if (hasUnquotedShellSyntax(command)) return false
  if (hasUnsafeReadOnlyGitOption(command)) return false
  // `\b` after `show` treats `show-ref` as `show` + `-ref` (`-` is a word
  // boundary), which let `git show-ref --delete refs/heads/x` pass as a bare
  // `show`. Require whitespace (or end) after the verb so `show` cannot match
  // `show-ref` and `branch` cannot match `branch-...`; args still allowed.
  return (
    /^git\s+(?:status|diff|log|show|rev-parse|rev-list|ls-files)(?:\s|$)/i.test(
      command,
    ) ||
    /^git\s+fetch(?:\s+--prune)?(?:\s+[A-Za-z0-9._/-]+)?$/i.test(command) ||
    /^git\s+branch\s+--show-current(?:\s|$)/i.test(command) ||
    /^git\s+merge-base(?:\s+--(?:is-ancestor|all|octopus|independent|fork-point))?(?:\s+[A-Za-z0-9._/^-]+)*\s*$/i.test(
      command,
    ) ||
    /^git\s+ls-remote(?:\s+--(?:heads|tags|refs|exit-code|get-url|symref|sort=\S+))?(?:\s+[A-Za-z0-9._/^*-]+)*\s*$/i.test(
      command,
    ) ||
    /^git\s+branch(?:\s+-[rva]+|\s+--list)+(?:\s+[A-Za-z0-9._/^*-]+)*\s*$/i.test(
      command,
    ) ||
    /^git\s+remote\s+(?:-v|show\s+[A-Za-z0-9._/-]+|get-url\s+[A-Za-z0-9._/-]+)\s*$/i.test(
      command,
    ) ||
    /^git\s+show-ref(?:\s+--(?:heads|tags|head|hash(?:=\d+)?|abbrev(?:=\d+)?))+\s*$|^git\s+show-ref\s*$/i.test(
      command,
    ) ||
    /^git\s+describe(?:\s+--(?:tags|all|long|always|dirty|abbrev=\d+|match=\S+))?(?:\s+[A-Za-z0-9._/^-]+)*\s*$/i.test(
      command,
    ) ||
    /^git\s+name-rev(?:\s+--(?:name-only|tags|always|no-undefined))?(?:\s+[A-Za-z0-9._/^-]+)*\s*$/i.test(
      command,
    ) ||
    /^git\s+config\s+--get(?:-regexp)?\s+[A-Za-z0-9._/-]+\s*$/i.test(command) ||
    /^git\s+cat-file\s+-(?:t|s|p|e)\s+[A-Za-z0-9._/^-]+\s*$/i.test(command)
  )
}

/**
 * Safe complex git operations for the git-commit profile: branch switch/create,
 * safe branch delete, merge, cherry-pick, stash, soft/mixed reset, tag create,
 * and staged restore. Upstream quote-aware substitution checks plus
 * hasUnquotedShellSyntax already ensure each of these is a single clean command
 * with no active composition, substitution, or redirection, so the anchored
 * regexes below only police git-level flags. Data-loss and history-rewrite
 * shapes (reset --hard, branch -D/--delete/-f/--force, clean, path checkout,
 * checkout -f/--force/-p/--patch/--merge/--theirs/--ours,
 * switch -f/--force/--discard-changes/-C, merge -s/-s<strategy>, rebase,
 * stash drop/clear, config writes) fail closed via explicit guards before any
 * allow regex is consulted.
 */
function isAllowedComplexGitCommand(command: string): boolean {
  // Single clean command only: composition/substitution/redirection are
  // rejected upstream, but fail closed here too so the helper stays safe if it
  // is ever reused outside the single-command branch.
  // Quote-aware substitution (including double-quoted `$(`/backticks); unquoted
  // `<>`/composition only — quoted subjects like `Fix A -> B` stay allowed.
  if (hasActiveCommandSubstitution(command)) return false
  if (hasUnquotedShellSyntax(command)) return false
  // Defense-in-depth: the read-only option denylist also applies to the complex
  // path so --exec-path/--output/--ext-diff/--textconv/-o are rejected by
  // construction rather than relying on each allow regex alone.
  if (hasUnsafeReadOnlyGitOption(command)) return false
  // Data-loss / history-rewrite guards - reject before the allow disjunction so
  // a too-loose pattern can never re-admit a destructive shape.
  if (/\s--hard\b/i.test(command)) return false // reset --hard destroys work
  // pathspec `--` overwrites the worktree for checkout/reset. Staged-only
  // restore uses `--` as a harmless pathspec separator and is exempted.
  if (
    /\s--(?:\s|$)/.test(command) &&
    !/^git\s+restore\s+--staged\b/i.test(command)
  ) {
    return false
  }
  // restore worktree/patch/source/overlay overwrite (data loss): deny any
  // restore carrying --worktree/-W, --patch/-p, --source, or --overlay.
  if (
    /\brestore\b[\s\S]*(?:--worktree\b|-[A-Za-z]*W\b|--patch\b|-[A-Za-z]*p\b|--source\b|--overlay\b)/i.test(
      command,
    )
  )
    return false
  // merge/cherry-pick strategy option: deny `-X` standalone or attached (e.g.
  // `-Xours`), which the in-regex `-X\b` guard cannot catch when attached.
  if (/(?:^|\s)-X/i.test(command)) return false
  if (/\bstash\s+(?:drop|clear)\b/i.test(command)) return false
  // Force delete / force ref reset: `-d` (safe delete) stays allowed;
  // `-D`/`--delete` (force delete) and `-f`/`--force` (reset branch ref) do not.
  if (/\bbranch\s+(?:-[a-zA-Z]*[Df]|--delete|--force)\b/.test(command))
    return false
  if (/^git\s+clean\b/i.test(command)) return false
  if (/^git\s+rebase\b/i.test(command)) return false
  if (/^git\s+config\b/i.test(command)) return false
  // switch force/discard: `-f` aliases `--discard-changes` (discards uncommitted
  // work); `-C` force-creates over an existing branch. Deny before allow regexes.
  if (
    /^git\s+switch\b/i.test(command) &&
    /(?:\s-f\b|\s-C\b|--force\b|--discard-changes\b)/.test(command)
  )
    return false
  // checkout worktree overwrite: `-f`/`--force` discard changes, `-p`/`--patch`
  // selectively overwrite, `--merge`/`--theirs`/`--ours` resolve by discarding.
  if (
    /^git\s+checkout\b/i.test(command) &&
    /(?:\s-f\b|\s-p\b|--force\b|--patch\b|--merge\b|--theirs\b|--ours\b)/.test(
      command,
    )
  )
    return false
  // merge short strategy: `-s` standalone or attached (e.g. `-sours`) selects a
  // strategy (such as `ours`) that discards one side of the merge.
  if (
    /^git\s+merge\b/i.test(command) &&
    /(?:\s-s\b|\s-s[A-Za-z])/.test(command)
  )
    return false

  // Message bodies are inert data (already substitution-scanned on the full
  // string). Strip -m/--message values so quoted subjects like `a -> b` do not
  // have to fit the path/flag token grammar below.
  const commandForAllow = stripCommitMessageArgs(command)

  return (
    // switch: `git switch foo`, `git switch -c foo [start-point]`.
    /^git\s+switch\s+(?:-[A-Za-z]+\s+)*[A-Za-z0-9._/-]+\s*$/i.test(
      commandForAllow,
    ) ||
    // checkout (branch-only): the standalone `--` path form is rejected above
    // and by the negative lookahead, so this cannot overwrite the worktree.
    /^git\s+checkout\s+(?!.*(?:^|\s)--(?:\s|$))(?:-[bB]\s+)?[A-Za-z0-9._/][A-Za-z0-9._/-]*\s*$/i.test(
      commandForAllow,
    ) ||
    // branch create / safe delete: lowercase short flags only, so `-d` (safe
    // delete) and plain create pass while `-D`/`--delete` (force) do not.
    /^git\s+branch\s+(?:-[a-z]+\s+)*[A-Za-z0-9._/-]+\s*$/i.test(
      commandForAllow,
    ) ||
    // merge (no strategy/exec/upload-pack/-X; standalone/attached -X also denied above).
    /^git\s+merge\s+(?!.*(?:--(?:strategy|exec-path|upload-pack)\b|(?:^|\s)-[sX]))(?:--(?:no-ff|ff-only|no-commit|no-edit|edit|squash|abort|continue|quit)\s+)*(?:-[A-Za-z]+\s+)*[A-Za-z0-9._/-]+\s*$/i.test(
      commandForAllow,
    ) ||
    // cherry-pick (no strategy/exec/-X; standalone/attached -X also denied above)
    // with a commit-ish argument.
    /^git\s+cherry-pick\s+(?!.*(?:--(?:strategy|exec-path)\b|(?:^|\s)-X))(?:--(?:abort|continue|skip|no-commit|edit|-?\w+)\s+)*[A-Za-z0-9._/-]+\s*$/i.test(
      commandForAllow,
    ) ||
    // stash (drop/clear rejected above).
    /^git\s+stash\s+(?:push|pop|apply|list|show|save|create|store)(?:\s+(?:-[A-Za-z]+|--(?:message|keep-index|include-untracked|patch|quiet)))*(?:\s+(?:--\s+)?[A-Za-z0-9._/-]+)*\s*$/i.test(
      commandForAllow,
    ) ||
    // reset (soft/mixed/merge/keep only; --hard and pathspec -- rejected above).
    // The commit-ish accepts `~`/`^` revision suffixes (e.g. HEAD~1).
    /^git\s+reset\s+(?:--(?:soft|mixed|merge|keep)\s+)?(?:[A-Za-z0-9._/^~-]+\s*)?$/i.test(
      commandForAllow,
    ) ||
    // tag create/annotate only: the tag name must start with a non-dash so
    // `-d`/`--delete` cannot be consumed as a name; explicit deny for safety.
    (!/(?:^|\s)-d\b/i.test(commandForAllow) &&
      !/--delete\b/i.test(commandForAllow) &&
      /^git\s+tag\s+(?:-[aA]\s+)?(?:-m\s+\S+\s+)*[A-Za-z0-9._/][A-Za-z0-9._/-]*(?:\s+-m\s+\S+)?(?:\s+[A-Za-z0-9._/][A-Za-z0-9._/-]*)?\s*$/i.test(
        commandForAllow,
      )) ||
    // restore --staged only: optional pathspec `--`, then every path token
    // must start with a non-dash (negative lookahead) so --worktree/-W/
    // --patch/-p/--source/--overlay cannot be smuggled as a path; those
    // shapes are also denied by the guard above.
    /^git\s+restore\s+--staged(?:\s+--)?(?:\s+(?!-)[A-Za-z0-9._/-]+)+\s*$/i.test(
      commandForAllow,
    )
  )
}

/** tmux-test permits non-fetch Git commands only through the inspection allowlist. */
function hasUnsafeTmuxGitCommand(command: string): boolean {
  const segments = splitReadOnlyShellSegments(command)
  return (
    segments?.some((segment) => {
      const resolved = resolveTmuxCommand(segment)
      return (
        resolved?.executable === 'git' &&
        (resolved.arguments[0]?.toLowerCase() === 'fetch' ||
          !isReadOnlyGitCommand(`git ${resolved.arguments.join(' ')}`))
      )
    }) ?? true
  )
}

function findOutsideAbsolutePath(
  command: string,
  projectRoot: string,
): string | undefined {
  const root = path.resolve(projectRoot)
  const shellTokens = command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? []
  const outsideShellToken = shellTokens.find((rawToken) => {
    const token = rawToken.replace(/^["']|["',);]+$/g, '')
    return (
      token === '~' ||
      token.startsWith('~/') ||
      token === '$HOME' ||
      token.startsWith('$HOME/') ||
      token.startsWith('${HOME}/')
    )
  })
  if (outsideShellToken) return outsideShellToken
  const tokens = [
    ...command.matchAll(
      /(?:^|[\s"'=(])((?:[A-Za-z]:\\|\/(?!\/))[^\s"'|;&)]*)/g,
    ),
  ].map((match) => match[1])
  for (const rawToken of tokens) {
    const token = rawToken.replace(/[),.:]+$/, '')
    if (token.startsWith('/dev/null')) continue
    if (token.startsWith('/bin/') || token.startsWith('/usr/bin/')) continue
    const resolved = path.resolve(token)
    const tempRoot = path.resolve('/tmp')
    const relativeToTemp = path.relative(tempRoot, resolved)
    // Exempt the temp root itself (`/tmp`, `/tmp/`) as well as anything
    // strictly inside it, so bare-`/tmp` operands like `stat -c '%a %U' /tmp`
    // and the tmux-cli stale-capture sweep (`find /tmp -maxdepth 1 ...`) are
    // tolerated. The gate is the RESOLVED relationship, never a raw `/tmp`
    // string prefix: `'/tmpfoo'.startsWith('/tmp')` is true, so a prefix test
    // would silently admit siblings like `/tmpfoo` and `/tmpevil/x`, which
    // resolve outside the temp root and must stay refused.
    if (
      relativeToTemp === '' ||
      (!relativeToTemp.startsWith('..') && !path.isAbsolute(relativeToTemp))
    ) {
      continue
    }
    const relative = path.relative(root, resolved)
    if (relative.startsWith('..') || path.isAbsolute(relative)) return token
  }
  return undefined
}

export function evaluateTerminalCommandPolicy(params: {
  command: string
  mode: 'assistant' | 'user'
  permissionProfile: TerminalPermissionProfile
  projectRoot: string
  allowedPaths?: string[]
  cwd?: string
}): TerminalPolicyDecision {
  if (params.mode === 'user') return { allowed: true }
  const heredocCommand =
    params.permissionProfile === 'validation-diagnosis'
      ? stripBoundedDiagnosticHeredoc(params.command)
      : undefined
  if (
    params.permissionProfile === 'validation-diagnosis' &&
    /\r|\n/.test(params.command) &&
    !heredocCommand
  ) {
    return {
      allowed: false,
      reason:
        'validation-diagnosis multi-line commands must be a single bounded quoted cat > file heredoc',
    }
  }
  const command = normalizeCommand(heredocCommand ?? params.command)
  let isLibrarianClone = false

  if (params.permissionProfile !== 'full-access') {
    // validation-diagnosis (the debugger profile) and workspace-write may
    // reference paths with `..` segments that still resolve inside the project
    // (e.g. a repro pointing at `../src/languages` from a package subdirectory,
    // or `cd ..` from an in-project cwd). Relative `..` tokens resolve against
    // params.cwd when provided. They still reject segments that escape the
    // project root, and absolute paths outside the project stay blocked by
    // findOutsideAbsolutePath below. Base read-only and librarian-read-only
    // keep the blanket `..` ban.
    const traversalPath =
      params.permissionProfile === 'validation-diagnosis' ||
      params.permissionProfile === 'workspace-write'
        ? findEscapingTraversalPath(command, params.projectRoot, params.cwd)
        : findTraversalPath(command)
    if (traversalPath) {
      return {
        allowed: false,
        reason: `path traversal is not allowed: ${traversalPath}`,
      }
    }
  }

  if (params.permissionProfile === 'tmux-test') {
    const workspaceWriteSyntax = [
      // Command substitution remains active outside single quotes, including
      // inside double quotes, and can mutate the workspace before tmux starts.
      hasActiveCommandSubstitution(command),
      hasActiveParameterExpansion(command),
      hasActiveTmuxCompoundShellSyntax(command),
      hasUnsafeTmuxFileMutation(command),
      hasUnsafeTmuxSedInPlace(command),
      hasUnsafeTmuxExecutable(command),
      hasUnsafeTmuxGitCommand(command),
      /\b(?:npm|pnpm|yarn|bun)\s+(?:install|add|remove|update|publish)\b/i,
      /\bgit\s+(?:commit|push|reset|clean|checkout|switch|merge|rebase)\b/i,
      hasUnsafeTmuxWriteRedirection(command),
      hasShellInterpreterEscape(command),
    ]
    if (
      workspaceWriteSyntax.some(
        (pattern) =>
          pattern === true ||
          (pattern instanceof RegExp && pattern.test(command)),
      )
    ) {
      return {
        allowed: false,
        reason:
          'tmux-test commands cannot write fixtures through the shell; use a dedicated terminal executor with private fixture creation',
      }
    }
  }

  if (params.permissionProfile === 'git-commit') {
    if (hasShellInterpreterEscape(command)) {
      return {
        allowed: false,
        reason:
          'git-commit commands cannot use shell composition or substitution',
      }
    }
    // Quote-aware substitution guard: `$(` and backticks remain active inside
    // double quotes (and unquoted), so reject them on the full command before
    // allowlisting. Redirection/`<>` is NOT active inside quotes — bash does
    // not treat quoted arrows as redirections — so unquoted `<>` and other
    // composition are handled by hasUnquotedShellSyntax below rather than a
    // raw anywhere-`<>` scan that rejected legitimate subjects like `Fix A -> B`.
    if (hasActiveCommandSubstitution(command)) {
      return {
        allowed: false,
        reason:
          'git-commit commands cannot use shell composition or substitution',
      }
    }
    if (hasUnquotedShellSyntax(command)) {
      // Shell composition is allowed only between allowlisted read-only git
      // commands; staging, committing, and pushing stay single-command-only.
      // Substitution, background `&`, and malformed input make the splitter
      // bail out, and any mutating or non-git segment fails the predicate.
      const segments = splitReadOnlyShellSegments(command)
      if (!segments || !segments.every(isReadOnlyGitCommand)) {
        return {
          allowed: false,
          reason:
            'git-commit commands cannot use shell composition or substitution',
        }
      }
    } else {
      const isGitAdd = /^git\s+add\b/i.test(command)
      const isGitRestoreStaged = /^git\s+restore\s+--staged\b/i.test(command)
      if (isGitAdd || isGitRestoreStaged) {
        const rawPaths =
          command
            .replace(
              isGitAdd ? /^git\s+add\s+/i : /^git\s+restore\s+--staged\s+/i,
              '',
            )
            .match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? []
        const stagedPaths = rawPaths
          .map((value) =>
            value.replace(/^["']|["']$/g, '').replace(/^\.\//, ''),
          )
          .filter((value) => value !== '--')
        if (
          stagedPaths.length === 0 ||
          stagedPaths.some(
            (value) =>
              value === '.' ||
              value === '-A' ||
              value === '--all' ||
              value.startsWith('-') ||
              /[*?\[\]{}]/.test(value),
          )
        ) {
          return {
            allowed: false,
            reason:
              'git-commit staging requires explicit owned file paths; broad flags, dot staging, options, and globs are forbidden',
          }
        }
        const allowedPaths = new Set(
          (params.allowedPaths ?? []).map((value) =>
            value.replace(/\\/g, '/').replace(/^\.\//, ''),
          ),
        )
        if (
          allowedPaths.size === 0 ||
          stagedPaths.some(
            (value) => !allowedPaths.has(value.replace(/\\/g, '/')),
          )
        ) {
          return {
            allowed: false,
            reason:
              'git add and git restore --staged paths must be an exact subset of the spawn-bound owned_paths allowlist',
          }
        }
      }
      // A commit whose -m/--message subject is a junk placeholder
      // (probe/test/wip/etc.) is a policy probe or content-free, never a
      // real change description: reject it with guidance instead of
      // committing it.
      if (
        /^git\s+commit\b/i.test(command) &&
        hasPlaceholderCommitMessage(command)
      ) {
        return {
          allowed: false,
          reason:
            'git commit message appears to be a placeholder (probe/test/wip/etc.); write a real imperative commit message',
        }
      }
      const isAllowedGitCommand =
        isReadOnlyGitCommand(command) ||
        isAllowedComplexGitCommand(command) ||
        /^git\s+add\s+(?!.*(?:^|\s)--(?:intent-to-add|chmod)\b).+/i.test(
          command,
        ) ||
        // Defense in depth: the early return above already rejects
        // placeholder messages with a clear reason; keep the guard here so
        // the allow clause stays fail-closed on its own.
        (!/(?:^|\s)--amend\b/i.test(command) &&
          !hasPlaceholderCommitMessage(command) &&
          /^git\s+commit\s+(?=.*(?:-m|--message)(?:\s|=|$)).+/i.test(
            command,
          )) ||
        /^git\s+push\s+(?!.*(?:--force|-f\b|--delete\b|:))(?:-u\s+|--set-upstream\s+)?[A-Za-z0-9._/-]+\s+[A-Za-z0-9._/-]+$/i.test(
          command,
        )
      if (!isAllowedGitCommand) {
        return {
          allowed: false,
          reason:
            'git-commit agents may only inspect/fetch git state, stage owned paths, create a non-amend commit, perform an explicit non-force branch push, and run safe branch/merge/cherry-pick/stash/reset/tag operations (data-loss operations like reset --hard, branch -D, clean, and path checkout remain forbidden)',
        }
      }
    }
    const outsidePath = findOutsideAbsolutePath(
      stripCommitMessageArgs(command),
      params.projectRoot,
    )
    if (outsidePath) {
      return {
        allowed: false,
        reason: `absolute path is outside the project: ${outsidePath}`,
      }
    }
    return { allowed: true }
  }

  if (params.permissionProfile === 'dependency-mutation') {
    if (hasUnquotedShellSyntax(command) || hasShellInterpreterEscape(command)) {
      return {
        allowed: false,
        reason:
          'dependency-mutation commands cannot use shell composition or substitution',
      }
    }
    if (/(?:^|\s)(?:-g|--global|--system|--user)(?:\s|$)/i.test(command)) {
      return {
        allowed: false,
        reason: 'global or user-level dependency mutation is not allowed',
      }
    }
    const isDependencyCommand = DEPENDENCY_MUTATION_COMMANDS.some((pattern) =>
      pattern.test(command),
    )
    if (!isDependencyCommand) {
      return {
        allowed: false,
        reason:
          'dependency-manager commands must match a supported ecosystem dependency operation',
      }
    }
    const outsidePath = findOutsideAbsolutePath(command, params.projectRoot)
    if (outsidePath) {
      return {
        allowed: false,
        reason: `absolute path is outside the project: ${outsidePath}`,
      }
    }
    return { allowed: true }
  }

  // Base read-only and librarian-read-only stay fully strict. The
  // validation-diagnosis profile (debugger agent) additionally tolerates
  // in-project `..` references (handled by the traversal gate above) and
  // `>`/`>>`/heredoc writes to in-project diagnostic output files under a
  // `repro`/`diagnostics` directory, so repro fixtures can be captured
  // without opening workspace-write authority over manifests or source.
  if (
    params.permissionProfile === 'read-only' ||
    params.permissionProfile === 'librarian-read-only' ||
    params.permissionProfile === 'validation-diagnosis'
  ) {
    isLibrarianClone =
      params.permissionProfile === 'librarian-read-only' &&
      /^git clone --depth 1 'https:\/\/github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+(?:\.git)?\/?' '\/tmp\/librarian-[A-Za-z0-9._-]+-[0-9]+'$/.test(
        command,
      )
    if (isLibrarianClone) return { allowed: true }
    const pipeline = splitReadOnlyShellSegments(command)
    if (hasShellInterpreterEscape(command) || !pipeline) {
      return {
        allowed: false,
        reason:
          'read-only commands cannot use shell interpreter escapes or malformed shell composition',
      }
    }
    for (const segment of pipeline) {
      const normalizedSegment =
        params.permissionProfile === 'validation-diagnosis'
          ? stripDiagnosticRedirections(segment, params.projectRoot)
          : stripSafeReadOnlyRedirections(segment)
      if (!normalizedSegment) {
        return {
          allowed: false,
          reason:
            params.permissionProfile === 'validation-diagnosis'
              ? 'validation-diagnosis commands may only redirect writes to in-project diagnostic output files under a repro/ or diagnostics/ directory (.log, .txt, .out, .err, .diff, .json, .csv)'
              : 'read-only commands cannot use unsafe shell redirection',
        }
      }
      const danger = findReadOnlyDanger(normalizedSegment)
      if (danger) return { allowed: false, reason: danger }
    }
  }

  if (params.permissionProfile !== 'full-access') {
    // tmux-test keeps its own workspace-write guard above and skips the
    // shell-indirection and workspace deny patterns so it can drive tmux
    // fixtures, but env-dump policy and outside-absolute-path containment
    // still apply, so `printenv` / `cat /etc/passwd` stay blocked.
    if (params.permissionProfile !== 'tmux-test') {
      if (
        /(?:^|[;&|(\n]\s*)(?:eval|source)\b|\b(?:bash|sh|zsh|fish)\s+-c\b/i.test(
          command,
        )
      ) {
        return {
          allowed: false,
          reason: 'shell indirection requires an explicit full-access workflow',
        }
      }
      for (const [pattern, reason] of WORKSPACE_DENY_PATTERNS) {
        if (pattern.test(command)) return { allowed: false, reason }
      }
    }
    const envIssue = findProcessEnvironmentIssueInCommand(
      command,
      'workspace',
      params.permissionProfile === 'workspace-write'
        ? 'inspect-bodies'
        : 'fail-closed',
    )
    if (envIssue) return { allowed: false, reason: envIssue }
    const outsidePath = findOutsideAbsolutePath(command, params.projectRoot)
    if (outsidePath) {
      return {
        allowed: false,
        reason: `absolute path is outside the project: ${outsidePath}`,
      }
    }
  }

  return { allowed: true }
}

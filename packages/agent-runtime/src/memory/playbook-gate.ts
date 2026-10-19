import { parseAgentId } from '@codebuff/common/util/agent-id-parsing'
import { normalizeSpawnAgentType } from '../tools/handlers/tool/spawn-agent-utils'
import { sessionEvidenceMatches } from './session-evidence-log'

import type {
  MemoryPlaybook,
  PlaybookTrigger,
} from '@codebuff/common/types/memory-playbook'
import type { SessionEvidenceLog } from './session-evidence-log'

/**
 * Playbook gate (memory playbook Phase 1).
 *
 * Deterministically gates a small set of high-consequence tool calls behind a
 * learned procedural rule: when an active playbook's trigger matches the call
 * and a required piece of evidence is missing, the gate produces a `warned`
 * (default) or `blocked` verdict. No model call, no I/O, no prose parsing, and
 * no regex built from playbook-supplied strings — every match is an exact
 * string or argv-token comparison.
 */
export type PlaybookGateVerdict =
  | { outcome: 'allowed' }
  | { outcome: 'warned' | 'blocked'; playbook: MemoryPlaybook; message: string }

const PLAYBOOK_GATE_ENV_KEY = 'OPENBUFF_PLAYBOOK_GATE'

/**
 * Resolve the session-wide gate mode from the environment.
 *
 * The default is 'warn': Phase 1 never aborts a dispatch unless the operator
 * explicitly opts into 'block'. `playbook.enforcement` can only DOWNGRADE the
 * resolved mode (a 'block' playbook under 'warn' mode still only warns) — a
 * playbook can never escalate itself into a hard block.
 */
export const resolvePlaybookGateMode = (
  env: Record<string, string | undefined>,
): 'off' | 'warn' | 'block' => {
  const raw = (env[PLAYBOOK_GATE_ENV_KEY] ?? '').trim().toLowerCase()
  if (raw === 'off') return 'off'
  if (raw === 'block') return 'block'
  return 'warn'
}

type ClassifiedTerminalAction = 'git-push' | 'git-commit' | 'git-stage'

/**
 * Classify a run_terminal_command line into one of the modeled git actions by
 * ARGV TOKENS only: the command is trimmed, split on whitespace, and only the
 * leading `git <subcommand>` pair is inspected. Leading git global options
 * (`-C <dir>`, `-c <key=value>`) are skipped so `git -C <dir> push` still
 * classifies as a push. Prose is never inspected — a command that merely
 * MENTIONS pushing does not classify.
 */
const classifyTerminalAction = (
  command: string,
): ClassifiedTerminalAction | undefined => {
  const tokens = command.trim().split(/\s+/).filter(Boolean)
  if (tokens[0] !== 'git') return undefined
  let index = 1
  while (index < tokens.length && tokens[index].startsWith('-')) {
    index += tokens[index] === '-C' || tokens[index] === '-c' ? 2 : 1
  }
  const subcommand = tokens[index]
  if (subcommand === 'push') return 'git-push'
  if (subcommand === 'commit') return 'git-commit'
  if (subcommand === 'add' || subcommand === 'stage') return 'git-stage'
  return undefined
}

/**
 * The normalized agent types an input requests to spawn.
 *
 * `spawn_agents` carries `agents: [{ agent_type }]`; `spawn_agent_inline`
 * carries a single top-level `agent_type`. Both are run through
 * normalizeSpawnAgentType — the same canonicalizer the spawn gate and the tool
 * executor use — so an alias spelling (`git_committer`) cannot slip past a
 * playbook.
 */
const spawnedAgentTypes = (input: Record<string, unknown>): string[] => {
  const agentTypes: string[] = []
  const collect = (agentType: string) => {
    if (agentType.length > 0) agentTypes.push(normalizeSpawnAgentType(agentType))
  }
  const agents = input.agents
  if (Array.isArray(agents)) {
    for (const agent of agents) {
      if (!agent || typeof agent !== 'object' || Array.isArray(agent)) continue
      const agentType = (agent as Record<string, unknown>).agent_type
      if (typeof agentType === 'string') collect(agentType)
    }
  }
  const inlineAgentType = input.agent_type
  if (typeof inlineAgentType === 'string') collect(inlineAgentType)
  return agentTypes
}

/**
 * Does a requested agent type refer to the playbook's agent?
 *
 * `normalizeSpawnAgentType` / `normalizeAgentIdForLookup` deliberately PRESERVE
 * the publisher segment and the `@version` suffix (they only canonicalize
 * `_` → `-`), because version and publisher are meaningful identity parts for
 * spawn resolution. A playbook names a bare agent id, so a version-pinned or
 * publisher-qualified spelling (`codebuff/git-committer@1.0.0`) would never
 * match under naive string equality — and would be a trivial bypass of the
 * rule it is meant to enforce. The comparison therefore parses both sides with
 * the shared `parseAgentId` (the SAME parser `getMatchingSpawn` uses): the
 * agent-name segment must match, and the requested publisher/version may only
 * constrain the match when it is actually specified. A version pin never
 * escapes the playbook that governs the underlying agent.
 */
const agentTypeMatchesPlaybookTarget = (params: {
  requestedAgentType: string
  playbookAgentType: string
}): boolean => {
  const requested = parseAgentId(params.requestedAgentType)
  const target = parseAgentId(params.playbookAgentType)
  if (!requested.agentId || !target.agentId) return false
  if (requested.agentId !== target.agentId) return false
  // Publisher/version constraints apply only where the PLAYBOOK names them. A
  // bare target (`git-committer`) governs EVERY publisher- and version-
  // qualified spelling of that agent — a version pin must never be a bypass —
  // while a target that itself names a publisher/version narrows the match to
  // exactly that identity.
  if (target.publisherId && target.publisherId !== requested.publisherId) {
    return false
  }
  if (target.version && target.version !== requested.version) return false
  return true
}

/**
 * Trigger match: does this playbook apply to this tool call? Every comparison
 * is deterministic and exact — no prose is ever parsed.
 */
const playbookTriggerMatches = (params: {
  playbook: MemoryPlaybook
  toolName: string
  input: Record<string, unknown>
}): boolean => {
  const { playbook, toolName, input } = params
  const { trigger } = playbook
  if (trigger.tool !== toolName) return false

  if (toolName === 'spawn_agents' || toolName === 'spawn_agent_inline') {
    if (!trigger.spawnAgentType) return false
    return spawnedAgentTypes(input).some((requestedAgentType) =>
      agentTypeMatchesPlaybookTarget({
        requestedAgentType,
        playbookAgentType: trigger.spawnAgentType as string,
      }),
    )
  }

  if (toolName === 'run_terminal_command') {
    const command = typeof input.command === 'string' ? input.command : ''
    const terminalAction = trigger.terminalAction
    if (!command || !terminalAction) return false
    // 'any' is an explicit, opt-in wildcard. Every other action must match the
    // token-classified git action, so an unrelated command never matches a
    // git-* playbook (and vice versa).
    if (terminalAction === 'any') return true
    return classifyTerminalAction(command) === terminalAction
  }

  return false
}

type RequiredEvidence = PlaybookTrigger['requireEvidence'][number]

/**
 * Is one required-evidence entry satisfied by the session ledger?
 *
 * Only `toolSucceeded` is implemented in Phase 1. The Phase 2 kinds
 * (`fileDigestUnchanged`, `claimPinned`, `observationPresent`) return NOT
 * satisfied: the gate then fails CLOSED (warns or blocks) instead of silently
 * allowing a call whose playbook demanded evidence this runtime cannot verify.
 * Implement each kind together with its evidence producer rather than
 * defaulting to allow.
 */
const evidenceIsSatisfied = (params: {
  evidence: RequiredEvidence
  trigger: PlaybookTrigger
  evidenceLog: SessionEvidenceLog
  nowMs: number
}): boolean => {
  const { evidence, trigger, evidenceLog, nowMs } = params
  if (evidence.kind === 'toolSucceeded') {
    return sessionEvidenceMatches(evidenceLog, {
      tool: evidence.tool ?? trigger.tool,
      commandPattern: evidence.commandPattern,
      withinMs: evidence.withinMs,
      nowMs,
    })
  }
  // Phase 2 kinds: not verifiable yet — fail closed (see the doc comment).
  return false
}

/**
 * Agent-facing description of one required-evidence entry, e.g.
 * "a successful run_terminal_command matching *check:ci-local*".
 */
const describeRequiredEvidence = (params: {
  evidence: RequiredEvidence
  trigger: PlaybookTrigger
}): string => {
  const { evidence, trigger } = params
  if (evidence.kind === 'toolSucceeded') {
    const tool = evidence.tool ?? trigger.tool
    return evidence.commandPattern
      ? `a successful ${tool} matching ${evidence.commandPattern}`
      : `a successful ${tool}`
  }
  return `a ${evidence.kind} assertion (not yet verifiable by this runtime)`
}

const formatPlaybookVerdictMessage = (params: {
  playbook: MemoryPlaybook
  toolName: string
  missing: string[]
}): string => {
  const { playbook, toolName, missing } = params
  return [
    `Playbook "${playbook.title}" requires ${missing.join(' and ')} before ${toolName}.`,
    `Instruction: ${playbook.instruction}`,
    'Satisfy the requirement with a real tool call, then retry; do not claim the evidence exists without it.',
  ].join(' ')
}

/**
 * Evaluate every installed playbook against one tool call and return the
 * verdicts that must be surfaced. An empty array means "proceed silently":
 * no playbook applied, or every applicable playbook was satisfied. An
 * `allowed` verdict is never emitted — a satisfied playbook simply contributes
 * nothing — so callers only ever act on `warned`/`blocked` entries.
 */
export const evaluatePlaybookGate = (params: {
  toolName: string
  input: Record<string, unknown>
  playbooks: MemoryPlaybook[] | undefined
  evidenceLog: SessionEvidenceLog
  nowMs: number
  env: Record<string, string | undefined>
}): PlaybookGateVerdict[] => {
  const { toolName, input, playbooks, evidenceLog, nowMs } = params
  // Zero-cost fast path: no playbooks installed (the common case) or the gate
  // is switched off. The mode is resolved only once playbooks exist.
  if (!playbooks || playbooks.length === 0) return []
  const mode = resolvePlaybookGateMode(params.env)
  if (mode === 'off') return []

  const verdicts: PlaybookGateVerdict[] = []
  for (const playbook of playbooks) {
    if (playbook.status !== 'active') continue
    if (playbook.expiresAt !== undefined && playbook.expiresAt <= nowMs) {
      continue
    }
    if (!playbookTriggerMatches({ playbook, toolName, input })) continue

    const missing = playbook.trigger.requireEvidence
      .filter(
        (evidence) =>
          !evidenceIsSatisfied({
            evidence,
            trigger: playbook.trigger,
            evidenceLog,
            nowMs,
          }),
      )
      .map((evidence) =>
        describeRequiredEvidence({ evidence, trigger: playbook.trigger }),
      )
    if (missing.length === 0) continue

    verdicts.push({
      // Downgrade-only: a 'block' enforcement aborts ONLY in 'block' mode.
      outcome:
        playbook.enforcement === 'block' && mode === 'block'
          ? 'blocked'
          : 'warned',
      playbook,
      message: formatPlaybookVerdictMessage({ playbook, toolName, missing }),
    })
  }
  return verdicts
}

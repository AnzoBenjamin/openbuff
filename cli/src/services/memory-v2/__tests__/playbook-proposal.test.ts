import { describe, expect, test } from 'bun:test'

import {
  parsePlaybookProposal,
  PlaybookProposalError,
  PROPOSAL_INSTRUCTION_MAX_CHARS,
  PROPOSAL_TITLE_MAX_CHARS,
  renderPlaybookProposalLines,
} from '../playbook-proposal'

const VALID_PROPOSAL = {
  title: 'Verify before push',
  instruction: 'Run the local CI check in a separate command before pushing.',
  trigger: { tool: 'run_terminal_command', terminalAction: 'git-push' },
}

describe('parsePlaybookProposal', () => {
  test('accepts a minimal valid proposal and applies the schema defaults', () => {
    const proposal = parsePlaybookProposal(VALID_PROPOSAL)
    expect(proposal.title).toBe('Verify before push')
    expect(proposal.instruction).toBe(VALID_PROPOSAL.instruction)
    // Schema defaults: absent scope → { repos: [] }; absent evidence → [].
    expect(proposal.scope).toEqual({ repos: [] })
    expect(proposal.trigger.requireEvidence).toEqual([])
    expect(proposal.expiresAt).toBeUndefined()
  })

  test('rejects extra keys (strict schema)', () => {
    // The proposal must not be able to smuggle command-owned fields.
    expect(() =>
      parsePlaybookProposal({ ...VALID_PROPOSAL, status: 'active' }),
    ).toThrow(PlaybookProposalError)
    expect(() =>
      parsePlaybookProposal({ ...VALID_PROPOSAL, enforcement: 'block' }),
    ).toThrow(PlaybookProposalError)
  })

  test('rejects an empty title and an empty instruction', () => {
    expect(() =>
      parsePlaybookProposal({ ...VALID_PROPOSAL, title: '' }),
    ).toThrow(PlaybookProposalError)
    expect(() =>
      parsePlaybookProposal({ ...VALID_PROPOSAL, instruction: '' }),
    ).toThrow(PlaybookProposalError)
  })

  test('enforces the MemoryPlaybookSchema length limits exactly', () => {
    // The limits are the store's own, so a parsed proposal always passes
    // the store's write-time MemoryPlaybookSchema validation.
    expect(PROPOSAL_TITLE_MAX_CHARS).toBe(200)
    expect(PROPOSAL_INSTRUCTION_MAX_CHARS).toBe(4_096)
    expect(() =>
      parsePlaybookProposal({
        ...VALID_PROPOSAL,
        title: 't'.repeat(PROPOSAL_TITLE_MAX_CHARS),
        instruction: 'i'.repeat(PROPOSAL_INSTRUCTION_MAX_CHARS),
      }),
    ).not.toThrow()
    expect(() =>
      parsePlaybookProposal({
        ...VALID_PROPOSAL,
        title: 't'.repeat(PROPOSAL_TITLE_MAX_CHARS + 1),
      }),
    ).toThrow(PlaybookProposalError)
    expect(() =>
      parsePlaybookProposal({
        ...VALID_PROPOSAL,
        instruction: 'i'.repeat(PROPOSAL_INSTRUCTION_MAX_CHARS + 1),
      }),
    ).toThrow(PlaybookProposalError)
  })

  test('rejects an invalid trigger kind', () => {
    expect(() =>
      parsePlaybookProposal({
        ...VALID_PROPOSAL,
        trigger: { tool: 'delete_files' },
      }),
    ).toThrow(PlaybookProposalError)
  })

  test('rejects a non-positive expiresAt and accepts a positive one', () => {
    expect(() =>
      parsePlaybookProposal({ ...VALID_PROPOSAL, expiresAt: -1 }),
    ).toThrow(PlaybookProposalError)
    expect(() =>
      parsePlaybookProposal({ ...VALID_PROPOSAL, expiresAt: 0 }),
    ).toThrow(PlaybookProposalError)
    expect(
      parsePlaybookProposal({
        ...VALID_PROPOSAL,
        expiresAt: 1_800_000_000_000,
      }).expiresAt,
    ).toBe(1_800_000_000_000)
  })

  test('defaults scope to empty repos and accepts an explicit scope', () => {
    expect(parsePlaybookProposal(VALID_PROPOSAL).scope).toEqual({ repos: [] })
    expect(
      parsePlaybookProposal({
        ...VALID_PROPOSAL,
        scope: { repos: ['github.com/acme/widget'] },
      }).scope,
    ).toEqual({ repos: ['github.com/acme/widget'] })
  })

  test('throws a clean bounded error listing the first few issues', () => {
    let error: unknown
    try {
      parsePlaybookProposal({
        title: '',
        instruction: '',
        trigger: { tool: 'nope' },
        expiresAt: -5,
        status: 'active',
      })
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(PlaybookProposalError)
    const proposalError = error as PlaybookProposalError
    // Bounded render: one line, issue count, no raw zod dump.
    expect(proposalError.message.split('\n')).toHaveLength(1)
    expect(proposalError.message).toContain('issue(s)')
    expect(proposalError.issues.length).toBeGreaterThanOrEqual(4)
  })

  test('bounds the rendered messages when the proposal has many issues', () => {
    // Eight invalid evidence entries produce more issues than the render
    // shows: the hidden remainder is counted, never silently dropped.
    const requireEvidence = Array.from({ length: 8 }, () => ({
      kind: 'not-a-kind',
    }))
    let error: unknown
    try {
      parsePlaybookProposal({
        ...VALID_PROPOSAL,
        trigger: { tool: 'run_terminal_command', requireEvidence },
      })
    } catch (caught) {
      error = caught
    }
    const proposalError = error as PlaybookProposalError
    expect(proposalError.message).toMatch(/\(\+\d+ more\)/)
    expect(proposalError.message.length).toBeLessThanOrEqual(1_024)
  })
})

describe('renderPlaybookProposalLines', () => {
  test('renders the proposal-state preview lines with trigger qualifiers and an epoch expiry', () => {
    const lines = renderPlaybookProposalLines(
      parsePlaybookProposal({
        title: 'Gate delegated pushes',
        // No trailing period: the canonical render appends its own sentence
        // period, so this input pins that append in isolation (the
        // period-terminated instruction case is pinned by the bare-trigger
        // test below, which expects the verbatim `${instruction}.` form).
        instruction: 'Spawn the git-committer only after CI is green',
        trigger: { tool: 'spawn_agents', spawnAgentType: 'git-committer' },
        scope: { repos: ['github.com/acme/widget'] },
        expiresAt: 1_800_000_000_000,
      }),
    )
    expect(lines).toEqual([
      'Proposal: Gate delegated pushes.',
      'Instruction: Spawn the git-committer only after CI is green.',
      'Trigger: spawn_agents git-committer.',
      'Scope: repos 1.',
      'Expires at: 1800000000000 epoch ms.',
    ])
  })

  test('renders a bare terminal trigger without qualifiers and a (none) expiry', () => {
    const lines = renderPlaybookProposalLines(
      parsePlaybookProposal(VALID_PROPOSAL),
    )
    expect(lines).toEqual([
      'Proposal: Verify before push.',
      `Instruction: ${VALID_PROPOSAL.instruction}.`,
      'Trigger: run_terminal_command git-push.',
      'Scope: repos 0.',
      'Expires at: (none).',
    ])
  })

  test('renders every scope segment the command preview shows', () => {
    const lines = renderPlaybookProposalLines(
      parsePlaybookProposal({
        ...VALID_PROPOSAL,
        scope: {
          repos: ['github.com/acme/widget'],
          glob: ['src/**/*.ts'],
          agentTypes: ['git-committer'],
        },
      }),
    )
    expect(lines).toContain('Scope: repos 1, globs 1, agent types 1.')
  })
})

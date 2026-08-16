import z from 'zod/v4'

import {
  $getNativeToolCallExampleString,
  coerceToArray,
  jsonToolResultSchema,
} from '../utils'

import type { $ToolParams } from '../../constants'

const toolName = 'suggest_followups'
const endsAgentStep = false

const followupSchema = z.object({
  prompt: z
    .string()
    .describe('The full prompt text to send as a user message when clicked'),
  label: z
    .string()
    .optional()
    .describe(
      'Short display label for the card (defaults to truncated prompt if not provided)',
    ),
})

export type SuggestFollowup = z.infer<typeof followupSchema>

const inputSchema = z
  .object({
    followups: z
      .preprocess(
        coerceToArray,
        z.array(followupSchema).min(1, 'Must provide at least one followup'),
      )
      .describe(
        'List of suggested followup prompts the user can click to send',
      ),
  })
  .describe(
    `Suggest clickable followup prompts to the user. Each followup becomes a card the user can click to send that prompt.`,
  )

const outputSchema = z.object({
  message: z.string(),
})

const description = `
Suggest ~3 clickable followup prompts (assistant-executable next steps). Absolute last actionable tool after a brief user-visible completion summary (and after git-committer if committing this turn); never mid-turn and never before remaining work. Write the summary first so the user is not left with only cards.

Good: alternatives, related features, refactors, unit tests, "Continue with the next step". Avoid: bare commits, vague "test x", or manual user-only testing. Vary from prior suggestions.

Example:
${$getNativeToolCallExampleString({
  toolName,
  inputSchema,
  input: {
    followups: [
      { prompt: 'Continue with the next step', label: 'Continue' },
      {
        prompt: 'Add unit tests for the new UserService class',
        label: 'Add tests',
      },
      {
        prompt: 'Refactor the authentication logic into a separate module',
        label: 'Refactor auth',
      },
    ],
  },
  endsAgentStep,
})}
`.trim()

export const suggestFollowupsParams = {
  toolName,
  endsAgentStep,
  description,
  inputSchema,
  outputSchema: jsonToolResultSchema(outputSchema),
} satisfies $ToolParams

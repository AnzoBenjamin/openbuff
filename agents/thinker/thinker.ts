import { publisher } from '../constants'

import type { SecretAgentDefinition } from '../types/secret-agent-definition'

const definition: SecretAgentDefinition = {
  id: 'thinker',
  publisher,
  displayName: 'Theo the Theorizer',
  spawnerPrompt:
    'Makes a focused architecture, design, or root-cause decision from a self-contained evidence packet. It has read-only repository access (read_files) to verify evidence but does not inherit conversation history, so include evidence, constraints, options, and unknowns.',
  inputSchema: {
    prompt: {
      type: 'string',
      description:
        'A self-contained decision packet: decision to make, confirmed evidence, constraints, competing options, risks, and unknowns.',
    },
    params: {
      type: 'object' as const,
      properties: {
        // M2.3: optional depth hint lets the spawner dial reasoning effort.
        depth: {
          type: 'string' as const,
          enum: ['shallow', 'deep'] as const,
          description:
            'Optional reasoning-depth hint. "shallow" asks for a concise, first-principles answer with a short thinking chain; "deep" (default) asks for extended reasoning before the final answer.',
        },
        // M2.3: optional outputSchemaHint lets the spawner request a specific
        // shape for the `message` content. The runtime contract stays
        // { message: string }; this hint only guides how the model formats
        // that string (e.g. serialize a JSON object into it).
        outputSchemaHint: {
          type: 'string' as const,
          description:
            'Optional description of the desired shape of the `message` content (e.g. "a JSON object with fields: summary, risks, recommendation"). The thinker still returns { message: string }; this hint only guides how the message string is formatted.',
        },
      },
      required: [] as const,
    },
  },
  outputSchema: {
    type: 'object',
    properties: {
      message: {
        type: 'string',
        description: "The response to the user's request",
      },
    },
  },
  outputMode: 'structured_output',
  inheritParentSystemPrompt: false,
  includeMessageHistory: false,
  spawnableAgents: [],
  toolNames: ['read_files'],
  programmaticToolNames: ['set_output'],

  instructionsPrompt: `
You are a thinker agent. Reason from the self-contained decision packet in the current prompt. Do not assume access to parent conversation history or operational state. You have read-only repository access: you may call read_files to verify evidence in the packet when helpful, but do not modify anything. Use native reasoning if available; otherwise reason silently. Then write the final answer as ordinary assistant text.

When satisfied, prefer plain assistant text for the final answer: write it as ordinary response text so it is visible in the message itself (not only inside a tool call). The parent agent will see that response. Structured output is harvested automatically from that plain text for you.

If the caller passed params.depth === 'shallow', keep your thinking chain short and lead with the answer. If params.depth === 'deep' (or omitted), reason thoroughly before the final answer.
If the caller passed params.outputSchemaHint, format your final message content to match that shape (e.g. valid JSON with the requested fields). The runtime still wraps your output as { message: string }, so serialize structured content into that string.
`.trim(),

  handleSteps: function* ({
    params,
  }: {
    params?: { depth?: string; outputSchemaHint?: string }
  }) {
    // M2.3: depth/outputSchemaHint are surfaced to the model via the
    // instructionsPrompt; the handleSteps body only needs agentState. Params
    // are accepted (so the signature matches the input schema) but not
    // consumed here because the model reads them during generation.
    void params

    // Shared local helper: extract assistant text (string or text parts) and
    // remove text within <think> tags (including the tags themselves).
    // Matches run-agent-step: strip closed pairs, then any unclosed <think>
    // tail so truncated thinking is not harvested as the answer. Kept as a
    // closure inside handleSteps so the generator stays serializable for
    // sandbox execution.
    const cleanedTextFromContent = (content: unknown): string => {
      let text = ''
      if (typeof content === 'string') {
        text = content
      } else if (Array.isArray(content)) {
        text = content
          .filter(
            (part) =>
              part && typeof part === 'object' && part.type === 'text',
          )
          .map((part) => part.text)
          .join('')
      }
      return text
        .replace(/<think>[\s\S]*?<\/think>/g, '')
        .replace(/<think>[\s\S]*$/, '')
        .trim()
    }

    // A read_files call is endsAgentStep=true, so the step can end on a
    // tool-call-only assistant message before a final answer exists. Keep
    // yielding STEP until the last assistant message is a genuine final
    // answer, but always break out on stepsComplete / hitStepCap so we never
    // re-trigger a fixed step cap and loop forever.
    let agentState
    let stepsComplete = false
    let hitStepCap = false
    let lastAssistantMessage
    while (true) {
      const resumed = yield 'STEP'
      agentState = resumed.agentState
      stepsComplete = resumed.stepsComplete
      // hitStepCap is passed at runtime but not declared on the agents
      // package's local step-resume type; cast narrowly (base2 pattern).
      hitStepCap = (resumed as { hitStepCap?: boolean }).hitStepCap === true

      // Find the last assistant message
      lastAssistantMessage = [...agentState.messageHistory]
        .reverse()
        .find((m) => m.role === 'assistant')

      if (stepsComplete || hitStepCap) {
        // Natural turn end or fixed step cap reached — run the harvest on the
        // current state rather than re-yielding STEP.
        break
      }

      const stepContent = lastAssistantMessage?.content
      const stepCleanedText = cleanedTextFromContent(stepContent)
      const hasPendingToolCall =
        Array.isArray(stepContent) &&
        stepContent.some(
          (part) =>
            part &&
            typeof part === 'object' &&
            part.type === 'tool-call' &&
            part.toolName !== 'set_output',
        )

      if (stepCleanedText && !hasPendingToolCall) {
        // Genuine final answer — proceed to the harvest below.
        break
      }
    }

    // Prefer non-empty cleaned assistant text > set_output tool-call message >
    // existing agentState.output.message. Never clobber a successful prior
    // set_output with an empty harvest (buffbench empty-harvest clobber).
    const existingOutput = agentState.output
    const existingMessage =
      existingOutput &&
      typeof existingOutput === 'object' &&
      typeof existingOutput.message === 'string' &&
      existingOutput.message.trim()
        ? existingOutput.message
        : undefined

    if (!lastAssistantMessage) {
      if (existingMessage) {
        // Usable prior output already present — leave it intact.
        return
      }
      const errorMsg =
        'Error: No assistant message found in conversation history'
      yield {
        toolName: 'set_output',
        input: { message: errorMsg },
        includeToolCall: false,
      }
      return
    }

    // Extract optional set_output tool-call payload from the last assistant
    // message. Helpers stay inside the generator so handleSteps remains
    // serializable for sandbox execution.
    const content = lastAssistantMessage.content
    let toolCallMessage: string | undefined

    const messageFromSetOutputInput = (
      input: Record<string, unknown>,
    ): string | undefined => {
      if (typeof input.message === 'string' && input.message.trim()) {
        return input.message
      }
      const data = input.data
      if (data && typeof data === 'object' && !Array.isArray(data)) {
        const nested = (data as Record<string, unknown>).message
        if (typeof nested === 'string' && nested.trim()) {
          return nested
        }
      }
      return undefined
    }

    if (Array.isArray(content)) {
      for (const part of content) {
        if (
          !part ||
          typeof part !== 'object' ||
          part.type !== 'tool-call' ||
          part.toolName !== 'set_output'
        ) {
          continue
        }
        const input = part.input
        if (!input || typeof input !== 'object' || Array.isArray(input)) {
          continue
        }
        const recovered = messageFromSetOutputInput(
          input as Record<string, unknown>,
        )
        if (recovered) {
          // Last matching set_output part wins (most recent in the message).
          toolCallMessage = recovered
        }
      }
    }

    // Remove text within <think> tags (including the tags themselves)
    const cleanedText = cleanedTextFromContent(content)

    if (cleanedText) {
      yield {
        toolName: 'set_output',
        input: { message: cleanedText },
        includeToolCall: false,
      }
      return
    }

    if (toolCallMessage) {
      yield {
        toolName: 'set_output',
        input: { message: toolCallMessage },
        includeToolCall: false,
      }
      return
    }

    if (existingMessage) {
      // Empty harvest must not overwrite a successful prior set_output.
      return
    }

    // No usable text, tool-call payload, or prior output — keep empty path.
    yield {
      toolName: 'set_output',
      input: { message: cleanedText },
      includeToolCall: false,
    }
  },
}

export default definition

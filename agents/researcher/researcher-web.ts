import { publisher } from '../constants'

import type { SecretAgentDefinition } from '../types/secret-agent-definition'

const definition: SecretAgentDefinition = {
  id: 'researcher-web',
  publisher,
  displayName: 'Weeb',
  spawnerPrompt: `Browses the web to find relevant information.`,
  inputSchema: {
    prompt: {
      type: 'string',
      description: 'A question you would like answered using web search',
    },
    params: {
      type: 'object',
      properties: {
        depth: {
          type: 'string',
          enum: ['standard', 'deep'],
          description: 'Search depth. Defaults to standard.',
        },
        locale: {
          type: 'string',
          description:
            'Optional locale or region to include in search queries.',
        },
        sourceDomains: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional preferred source domains.',
        },
        dateRange: {
          type: 'string',
          description:
            'Optional date/freshness constraint to include in queries.',
        },
      },
    },
  },
  outputMode: 'structured_output',
  outputSchema: {
    type: 'object',
    properties: {
      questions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            question: { type: 'string' },
            status: {
              type: 'string',
              enum: ['answered', 'failed', 'skipped'],
            },
            answer: { type: 'string' },
            citations: { type: 'array', items: { type: 'string' } },
          },
          required: ['question', 'status', 'answer', 'citations'],
        },
      },
      sources: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            url: { type: 'string' },
            title: { type: 'string' },
          },
          required: ['url', 'title'],
        },
      },
      skippedQuestions: { type: 'array', items: { type: 'string' } },
    },
    required: ['questions', 'sources', 'skippedQuestions'],
  },
  includeMessageHistory: false,
  toolNames: ['web_search', 'set_output'],
  programmaticToolNames: [],
  spawnableAgents: [],

  systemPrompt: `You are an expert researcher who can search the web to find relevant information. Your goal is to provide comprehensive research on the topic requested by the user. You have full control of the research process: run web_search, read results, refine queries, and iterate until the topic is covered before calling set_output.`,
  instructionsPrompt: `Research the user's prompt thoroughly using web_search.

Start from the seed questions listed in the first message. For each:
- Run web_search with a focused query. Adapt and refine your queries based on the results you actually read: if a search comes back thin or noisy, reformulate the query with better keywords, synonyms, or site: filters, and search again.
- Read the returned results before deciding anything. When a result includes links you can pass include_links, follow the most promising ones to get richer source material or fetch a specific URL directly with web_search.
- Follow leads that appear mid-research (new terms, contradicting sources, missing details). Iterate as many rounds as the topic needs — there is no fixed number of searches.
- Stop only when every seed question is answered well or you have honestly exhausted useful searches.
- Depth guidance: prefer deeper, multi-round research for broad or multi-part prompts; fewer rounds for narrow questions.

Then call set_output with the structured output contract:
- questions: every seed question, each with status "answered", "failed", or "skipped", its answer text, and citations as URLs of the sources that support the answer.
- sources: every URL you consulted during research, with a title.
- skippedQuestions: the question strings for anything you could not answer.
Be honest: mark questions you could not answer as failed or skipped instead of inventing content. Always cite real URLs from your searches in citations;
never fabricate citations.

The web_search backend also enforces egress/SSRF protection on any URL: do not attempt to fetch internal or private hosts.
`.trim(),

  // Bootstrap-only handleSteps: decompose the prompt into seed questions,
  // seed them into the model's reasoning, then hand full control to the
  // model-driven STEP loop. No deterministic search budget; the model decides
  // how many web_search calls the topic needs.
  handleSteps: function* ({ prompt, params }) {
    // Keep helpers inside handleSteps because built-in agents serialize this
    // function without top-level lexical bindings.

    // Strip meta-instructions from text: "search for", "research", "find info
    // about", "look up", "can you find", etc. These are instructions to the
    // agent, not search query terms.
    function stripMetaInstructions(text: string): string {
      return text
        .replace(
          /\b(search the web for|find information about|research|look up|can you find|I need you to search|please search|help me find|do a web search for|use web search to find|find out about|gather information on|tell me about|provide information on)\s+/gi,
          '',
        )
        .replace(/^[,;:\s]+/, '')
        .trim()
    }

    // Extract topic phrases from a comparison-style prompt by splitting on
    // delimiters like "vs", "compared to", "versus", "or".
    function extractTopics(p: string): string[] {
      const cleaned = stripMetaInstructions(p)
      const parts = cleaned.split(
        /\s+(?:vs\.?|versus|compared to|compared with|rather than|instead of|or)\s+/i,
      )
      if (parts.length >= 2) {
        return parts
          .map((part) =>
            part
              .replace(/^and\s+/i, '')
              .replace(/[?.,;:!]+$/, '')
              .trim(),
          )
          .filter((t) => t.length > 3)
      }
      return []
    }

    // Decompose a broad prompt into focused seed questions heuristically.
    // These are starting points for the model's own research loop, not a
    // fixed list of one-shot searches.
    const MAX_SUBQUERIES = 5
    function decomposePrompt(
      p: string,
    ): Array<{ question: string }> {
      const subquestions: Array<{ question: string }> = []

      // Strategy 1: Split on numbered items (1. 2. 3. or 1) 2) etc)
      const numberedSplit = p.split(/(?:^|\n)\s*\d+[.)]\s+/m).filter(Boolean)
      if (numberedSplit.length >= 2) {
        for (
          let i = 0;
          i < numberedSplit.length && subquestions.length < MAX_SUBQUERIES;
          i++
        ) {
          const item = stripMetaInstructions(numberedSplit[i].trim())
          if (item.length > 5) {
            subquestions.push({ question: item })
          }
        }
        if (subquestions.length >= 2) return subquestions
      }

      // Strategy 2: Extract sentences ending with ? as individual questions
      const questionSentences = p.match(/[^.!?]+\?/g)
      if (questionSentences && questionSentences.length >= 2) {
        for (
          let i = 0;
          i < questionSentences.length && subquestions.length < MAX_SUBQUERIES;
          i++
        ) {
          const q = stripMetaInstructions(questionSentences[i].trim())
          if (q.length > 5) {
            subquestions.push({ question: q })
          }
        }
        if (subquestions.length >= 2) return subquestions
      }

      // Strategy 3: Split on bullet markers (- * •)
      const bulletSplit = p.split(/(?:^|\n)\s*[\-*•]\s+/m).filter(Boolean)
      if (bulletSplit.length >= 2) {
        for (
          let i = 0;
          i < bulletSplit.length && subquestions.length < MAX_SUBQUERIES;
          i++
        )
        {
          const item = stripMetaInstructions(bulletSplit[i].trim())
          if (item.length > 5) {
            subquestions.push({ question: item })
          }
        }
        if (subquestions.length >= 2) return subquestions
      }

      // Strategy 4: Split on comparison connectors to extract topic pairs.
      const topics = extractTopics(p)
      if (topics.length >= 2 && subquestions.length === 0) {
        for (
          let i = 0;
          i < topics.length && subquestions.length < MAX_SUBQUERIES;
          i++
        ) {
          subquestions.push({ question: topics[i] })
        }
      }

      return subquestions
    }

    const queryControls = [
      typeof params?.locale === 'string' ? params.locale : '',
      typeof params?.dateRange === 'string' ? params.dateRange : '',
      ...(Array.isArray(params?.sourceDomains)
        ? params.sourceDomains
            .filter((domain): domain is string => typeof domain === 'string')
            .map((domain) => `site:${domain}`)
        : []),
    ]
      .filter(Boolean)
      .join(' ')

    const cleanedPrompt = prompt ? stripMetaInstructions(prompt) : ''
    const subquestions = cleanedPrompt
      ? decomposePrompt(cleanedPrompt)
      : []
    const seedQuestions =
      subquestions.length >= 2
        ? subquestions.map((sq) => sq.question)
        : [prompt && prompt.trim() ? prompt.trim() : 'the user\'s request']

    const seedList = seedQuestions
      .map((question, index) => `${index + 1}. ${question}`)
      .join('\n')

    yield {
      toolName: 'add_message',
      input: {
        role: 'user',
        content:
          'Research this request using web_search. First, a suggested decomposition into seed questions (adapt them as you learn more; they are not a fixed checklist):\n\n' +
          seedList +
          '\n\nHow to research:\n- Run web_search for each seed question with focused queries.' +
          (queryControls ? ` Prefer queries that also include these constraints: "${queryControls}".` : '') +
          ' READ each result before your next move: refine queries that returned thin or noisy results, try different keywords, synonyms, or site: filters, and follow up with include_links or a direct URL fetch when a result points somewhere promising.\n' +
          '- Iterate for as many rounds as the topic needs. There is no hard cap on searches; stop only when the seed questions are covered well or further searching is clearly not helping.\n' +
          '- If your searches turn up questions beyond the seeds that matter for the request, research those too.\n\n' +
          "Here is the request:\n\n" +
          (prompt ?? '') +
          '\n\nWhen coverage is adequate, call set_output with ALL of: questions (every seed question with status answered/failed/skipped, its answer, and citations as real URLs), sources (every URL you consulted, with a title), and skippedQuestions (question strings you could not answer). Cite URLs in answers; be honest about failures instead of inventing content.',
      },
      includeToolCall: false,
    }

    // Hand full control to the model-driven STEP loop; the structured
    // set_output contract is enforced by outputMode/outputSchema.
    yield 'STEP_ALL'
  },
}

export default definition

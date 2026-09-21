import { publisher } from '../constants'

import type {
  AgentDefinition,
  AgentStepContext,
} from '../types/agent-definition'

const librarian: AgentDefinition = {
  id: 'librarian',
  publisher,
  displayName: 'Librarian',

  spawnerPrompt:
    'Spawn the librarian agent to shallow-clone a GitHub repository into /tmp and answer questions about its code, structure, or documentation. The runtime deletes the owned clone after the answer by default. Requires params.repoUrl. Set params.retainClone=true only when the caller explicitly needs to inspect returned files after completion; retained clones require caller cleanup.',

  inputSchema: {
    prompt: {
      type: 'string',
      description: 'Question to answer about the cloned repository',
    },
    params: {
      type: 'object',
      properties: {
        repoUrl: {
          type: 'string',
          description:
            'GitHub repository URL to clone (e.g. https://github.com/owner/repo)',
        },
        retainClone: {
          type: 'boolean',
          description:
            'Retain the owned /tmp clone after completion. Defaults to false. Set true only when the caller explicitly needs follow-up file access and will clean it up.',
        },
      },
      required: ['repoUrl'],
    },
  },

  outputMode: 'structured_output',
  outputSchema: {
    type: 'object',
    properties: {
      answer: {
        type: 'string',
        description: 'Full answer to the question about the repository',
      },
      relevantFiles: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Absolute file paths in the cloned repo that are relevant to the answer',
      },
      cloneDir: {
        type: 'string',
        description:
          'The clone directory while retained, or an empty string after automatic cleanup',
      },
      cloneRetained: {
        type: 'boolean',
        description:
          'Whether the clone still exists for caller inspection after completion',
      },
      status: {
        type: 'string',
        enum: ['answered', 'failed'],
      },
      error: { type: 'string' },
    },
    required: [
      'status',
      'answer',
      'relevantFiles',
      'cloneDir',
      'cloneRetained',
    ],
  },
  includeMessageHistory: false,

  toolNames: ['run_terminal_command', 'set_output'],
  terminalPermissionProfile: 'librarian-read-only',

  systemPrompt: `You are the Librarian, an expert at quickly understanding codebases. You have been given access to a freshly cloned repository in a /tmp directory. Your job is to explore its structure, read relevant files, and answer the user's question thoroughly and accurately.

CRITICAL RULES:
- The cloned repo is OUTSIDE the project directory in /tmp.
- You MUST use run_terminal_command for ALL file operations. Use shell commands like:
  - \`ls -la <dir>\` or \`tree -L 2 <dir>\` to list directory contents
  - \`cat <file>\` to read file contents
  - \`head -100 <file>\` to preview large files
  - \`find <dir> -name '*.ts' -type f\` to find files by pattern
  - \`grep -rn 'pattern' <dir> --include='*.ts'\` to search file contents
  - \`wc -l <file>\` to check file sizes
- NEVER copy files from /tmp into the project directory. This will overwrite project files and cause damage.
- NEVER modify files in the project directory.

When exploring a repo:
- Start with \`ls -la\` and \`cat README.md\` (or similar) at the repo root
- Check package.json, pyproject.toml, Cargo.toml, or similar entry points with \`cat\`
- Use \`find\` and \`grep\` to search for specific patterns or files
- Read the most relevant files with \`cat\`
- Provide clear, well-structured answers with references to specific files

When you are done, call set_output with status: "answered", your answer, all relevant file paths (absolute), cloneDir, and cloneRetained matching params.retainClone === true. Include every file you read or referenced in relevantFiles. The runtime, not the model, owns default clone cleanup.`,

  instructionsPrompt: `Answer the user's question about the cloned repository. Be thorough but concise. Reference specific files and code when relevant. When finished, call set_output with status, answer, relevantFiles, and cloneDir.`,

  handleSteps: function* ({ prompt, params, logger }: AgentStepContext) {
    const repoUrl = params?.repoUrl
    if (!repoUrl) {
      yield {
        toolName: 'set_output',
        input: {
          status: 'failed',
          answer: '',
          relevantFiles: [],
          cloneDir: '',
          cloneRetained: false,
          error:
            'repoUrl is required. Provide a GitHub repository URL in params.',
        },
      }
      return
    }

    // SECURITY: repoUrl is interpolated into a shell command string passed to
    // run_terminal_command (which executes via a shell). Validate it against a
    // strict GitHub URL allowlist BEFORE building the command so an attacker
    // can't inject shell metacharacters (e.g. a repoUrl containing `'` would
    // break out of the single-quote wrapping in the old code and run arbitrary
    // shell). The regex accepts http(s)://github.com/<owner>/<repo> with an
    // optional .git suffix and optional trailing slash, where owner and repo
    // are limited to the GitHub-safe charset [A-Za-z0-9._-]. Anything else is
    // rejected with a clear error instead of being executed.
    const GITHUB_URL_RE =
      /^https?:\/\/github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+(?:\.git)?\/?$/
    if (typeof repoUrl !== 'string' || !GITHUB_URL_RE.test(repoUrl)) {
      yield {
        toolName: 'set_output',
        input: {
          status: 'failed',
          answer: '',
          relevantFiles: [],
          cloneDir: '',
          cloneRetained: false,
          error:
            'repoUrl must be a GitHub URL of the form https://github.com/<owner>/<repo>. Refusing to clone an untrusted URL.',
        },
      }
      return
    }

    // POSIX single-quote escape: wrap in single quotes and escape any literal
    // single quotes inside. Belt-and-suspenders defense: the regex above
    // already rejects single quotes, but shellQuoting here means the command is
    // safe even if the validation regex is ever loosened or a path-derived
    // value (cloneDir) contains surprising characters.
    const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`

    const timestamp = Date.now()
    const repoName =
      repoUrl
        .split('/')
        .pop()
        ?.replace(/\.git$/, '') || 'repo'
    const cloneDir = '/tmp/librarian-' + repoName + '-' + timestamp

    logger.info('Cloning ' + repoUrl + ' into ' + cloneDir)

    const { toolResult } = yield {
      toolName: 'run_terminal_command',
      input: {
        command:
          'git clone --depth 1 ' +
          shellQuote(repoUrl) +
          ' ' +
          shellQuote(cloneDir),
        // Large repos can exceed the default terminal timeout; a timeout here
        // would fail the whole run, so give the clone a generous 10 minutes.
        timeout_seconds: 600,
      },
    }

    const result = toolResult?.[0]
    if (result && result.type === 'json') {
      const value = result.value as Record<string, unknown>
      const exitCode =
        typeof value?.exitCode === 'number' ? value.exitCode : undefined
      if (exitCode !== 0) {
        const stderr =
          typeof value?.stderr === 'string' ? value.stderr : 'Unknown error'
        logger.error('Clone failed: ' + stderr)
        yield {
          toolName: 'set_output',
          input: {
            status: 'failed',
            answer: '',
            relevantFiles: [],
            cloneDir: '',
            cloneRetained: false,
            error: 'Failed to clone repository: ' + stderr,
          },
        }
        return
      }
    }

    logger.info('Clone complete. Exploring repo...')

    yield {
      toolName: 'add_message',
      input: {
        role: 'user',
        content:
          'The repository has been cloned to `' +
          cloneDir +
          '`. Use run_terminal_command with shell commands (ls, cat, find, grep, head, tree) to explore it. Do NOT use read_files, list_directory, glob, or code_search — they cannot access /tmp paths. Do NOT copy files into the project directory.\n\nNow answer this question about the repo:\n\n' +
          (prompt || 'Provide an overview of this repository.') +
          '\n\nWhen done, call set_output with status: "answered", your answer, relevantFiles (absolute paths), and cloneDir: "' +
          cloneDir +
          '", and cloneRetained: ' +
          String(params?.retainClone === true) +
          '.',
      },
      includeToolCall: false,
    }

    // ---- Post-STEP_ALL guarantee: the parent MUST receive structured output ----
    // This generator is serialized for sandbox execution without top-level
    // bindings, so every helper lives inside the generator body (same
    // precedent as general-agent.ts's needsHarvestedAnswer/harvestedAnswerText).

    // Step results carry agentState (output + messageHistory) in this
    // codebase; the shared type doesn't expose it, so cast narrowly like
    // general-agent.ts does.
    type ResumedAgentState = {
      output?: unknown
      messageHistory?: unknown[]
      lastSetOutputError?: unknown
    }

    const harvestedAnswerText = (messageHistory: unknown): string => {
      if (!Array.isArray(messageHistory)) return ''
      // Mirrors getLastAssistantTurnMessages: harvest the whole contiguous
      // trailing assistant turn, not only its last message.
      let turnEnd = -1
      for (let index = messageHistory.length - 1; index >= 0; index--) {
        const message = messageHistory[index] as
          | { role?: unknown }
          | undefined
        if (message && message.role === 'assistant') {
          turnEnd = index
          break
        }
      }
      if (turnEnd < 0) return ''
      let turnStart = turnEnd
      while (turnStart > 0) {
        const previous = messageHistory[turnStart - 1] as
          | { role?: unknown }
          | undefined
        if (!previous || previous.role !== 'assistant') break
        turnStart--
      }
      const messageTexts: string[] = []
      for (let index = turnStart; index <= turnEnd; index++) {
        const message = messageHistory[index] as
          | { content?: unknown; tags?: unknown }
          | undefined
        if (!message) continue
        // A runtime terminal notice (step cap, tool-call error) is never the
        // model's answer, so it must never be reported as one.
        const tags = Array.isArray(message.tags)
          ? (message.tags as unknown[])
          : []
        if (
          tags.includes('STEP_CAP_REACHED') ||
          tags.includes('TOOL_CALL_ERROR')
        ) {
          continue
        }
        // Message content may be a string or an array of typed parts; parse
        // defensively and harvest only text parts.
        const content = message.content
        const text = Array.isArray(content)
          ? content
              .filter(
                  (part) =>
                    part &&
                    (part as { type?: unknown }).type === 'text' &&
                    typeof (part as { text?: unknown }).text === 'string',
                )
                .map((part) => (part as { text: string }).text)
                .join('')
            : typeof content === 'string'
              ? content
              : ''
        if (text) messageTexts.push(text)
      }
      return messageTexts
        .join('\n')
        .replace(/<think>[\s\S]*?<\/think>/g, '')
        .replace(/<think>[\s\S]*$/, '')
        .trim()
    }

    // Only an output carrying a real status is a successful set_output; an
    // object without one (e.g. a zod-parse failure record) must be harvested.
    const hasSuccessfulOutput = (output: unknown): boolean =>
      !!output &&
      typeof output === 'object' &&
      !Array.isArray(output) &&
      typeof (output as { status?: unknown }).status === 'string'

    // run-agent's set_output schema-validation failure is surfaced here; the
    // error may be a plain string or an Error-like object.
    const lastSetOutputErrorText = (state: ResumedAgentState | undefined): string => {
      const err = state?.lastSetOutputError
      if (typeof err === 'string' && err.trim()) return err
      if (err && typeof err === 'object') {
        const message = (err as { message?: unknown }).message
        if (typeof message === 'string' && message.trim()) return message
      }
      return ''
    }

    // Relevant files are harvested from text parts of assistant messages that
    // mention paths under the clone directory. Best-effort: an empty array is
    // always a valid result.
    const harvestedRelevantFiles = (
      messageHistory: unknown,
      dir: string,
    ): string[] => {
      if (!dir || !Array.isArray(messageHistory)) return []
      const escaped = dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const pathRe = new RegExp(escaped + '\\/[^\\s\'"\\)\\]}:`,;]+', 'g')
      const found = new Set<string>()
      for (const message of messageHistory) {
        const m = message as { role?: unknown; content?: unknown } | undefined
        if (!m || typeof m !== 'object' || m.role !== 'assistant') continue
        const content = m.content
        const texts = Array.isArray(content)
          ? content
              .filter(
                  (part) =>
                    part &&
                    (part as { type?: unknown }).type === 'text' &&
                    typeof (part as { text?: unknown }).text === 'string',
                )
                .map((part) => (part as { text: string }).text)
          : [typeof content === 'string' ? content : '']
        for (const text of texts) {
          for (const match of text.matchAll(pathRe)) {
            found.add(match[0].replace(/[.,;]+$/, ''))
          }
        }
      }
      return [...found].slice(0, 50)
    }

    let stepAllResult = (yield 'STEP_ALL') as
      | { agentState?: ResumedAgentState }
      | undefined

    // One guided retry max, then a guaranteed harvest — never an infinite
    // loop, never a silent exit with no output for the parent.
    for (let attempt = 0; attempt < 2; attempt++) {
      const state = stepAllResult?.agentState as ResumedAgentState | undefined
      const output = state?.output
      if (hasSuccessfulOutput(output)) break

      const validationError = lastSetOutputErrorText(state)
      if (attempt === 0) {
        // Guided recovery: name the exact required fields so the model
        // understands what set_output was missing, then give it one STEP.
        yield {
          toolName: 'add_message',
          input: {
            role: 'user',
            content:
              '<system>Your previous set_output call ' +
              (validationError
                ? 'failed validation: ' + validationError + '. '
                : 'never succeeded, so no structured output was recorded. ') +
              'Call set_output again with ALL required fields: status ("answered" or "failed"), answer (non-empty string), relevantFiles (array of strings), cloneDir: "' +
              cloneDir +
              '", and cloneRetained: ' +
              String(params?.retainClone === true) +
              '.</system>',
          },
          includeToolCall: false,
        }
        stepAllResult = (yield 'STEP') as typeof stepAllResult
        continue
      }

      // Terminal harvest: guaranteed structured output for the parent.
      const harvestedText = harvestedAnswerText(state?.messageHistory)
      yield {
        toolName: 'set_output',
        input: {
          status: harvestedText ? 'answered' : 'failed',
          answer: harvestedText,
          relevantFiles: harvestedRelevantFiles(
            state?.messageHistory,
            cloneDir,
          ),
          cloneDir,
          cloneRetained: params?.retainClone === true,
          agentHarvestedFallback: true,
          ...(harvestedText
            ? {}
            : {
                error:
                  'Librarian finished without a valid set_output and no harvestable answer text.',
              }),
        },
        includeToolCall: false,
      }
      break
    }
  },
}

export default librarian

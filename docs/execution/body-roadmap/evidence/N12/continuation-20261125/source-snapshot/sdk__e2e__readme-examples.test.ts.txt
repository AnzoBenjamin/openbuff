import { describe, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import ts from 'typescript'

const sdkDir = path.resolve(import.meta.dir, '..')
const repoDir = path.dirname(sdkDir)
const readmePath = path.join(sdkDir, 'README.md')
const readme = fs.readFileSync(readmePath, 'utf8')
const sourceIndex = path.join(sdkDir, 'src/index.ts')
// Opt in to an already-built/public-consumer index; never build or install here.
const selectedIndex = process.env.OPENBUFF_README_SDK_INDEX ?? sourceIndex
if (!path.isAbsolute(selectedIndex) || !fs.statSync(selectedIndex).isFile())
  throw new Error('OPENBUFF_README_SDK_INDEX must name an existing absolute SDK index')
const publicTypes = selectedIndex === sourceIndex
  ? sourceIndex
  : path.join(path.dirname(selectedIndex), 'index.d.ts')
const CHILD_DEADLINE_MS = 20_000
const HELLO = 'Hello from the README example.'
const WORD = 'ORCHID-27'
const structuredValue = { summary: HELLO, changedFiles: [] }
function messageText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(messageText).join('')
  if (value && typeof value === 'object') {
    if ('content' in value) return messageText(value.content)
    if ('text' in value && typeof value.text === 'string') return value.text
  }
  return ''
}

type Fence = { filename: string; code: string; label: string }

/** Walk Markdown fences, including longer delimiters and the typescript alias. */
function extractTypeScript(markdown: string): Fence[] {
  const fences: Fence[] = []
  let filename: string | undefined
  let open: { delimiter: string; width: number; language: string; line: number; code: string[] } | undefined
  for (const [index, line] of markdown.split(/\r?\n/).entries()) {
    if (open) {
      const close = line.match(/^ {0,3}(`{3,}|~{3,})\s*$/)
      if (close && close[1]![0] === open.delimiter && close[1]!.length >= open.width) {
        if (['ts', 'typescript', 'tsx'].includes(open.language)) {
          const name = filename ?? `fence-${fences.length + 1}.${open.language === 'tsx' ? 'tsx' : 'ts'}`
          if (fences.some((fence) => fence.filename === name)) throw new Error(`Duplicate README example: ${name}`)
          fences.push({ filename: name, code: open.code.join('\n') + '\n',
            label: `sdk/README.md fence ${fences.length + 1}: ${name} (line ${open.line})` })
        }
        open = undefined
        filename = undefined
      } else open.code.push(line)
      continue
    }
    const marker = line.match(/^<!-- sdk-example: ([a-z0-9-]+\.tsx?) -->$/)
    if (marker) filename = marker[1]
    const start = line.match(/^ {0,3}(`{3,}|~{3,})\s*([^\s]*)/)
    if (start) open = { delimiter: start[1]![0]!, width: start[1]!.length,
      language: start[2]!.toLowerCase(), line: index + 1, code: [] }
  }
  if (open) throw new Error(`Unclosed README fence at line ${open.line}`)
  if (!fences.length) throw new Error('sdk/README.md contains no TypeScript examples')
  return fences
}
const fences = extractTypeScript(readme)

function workspace() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'openbuff-readme-')))
  const project = path.join(root, 'workspace')
  const config = path.join(root, 'config')
  const harness = path.join(root, 'harness')
  for (const directory of [project, config, harness]) fs.mkdirSync(directory)
  for (const fence of fences) fs.writeFileSync(path.join(project, fence.filename), fence.code)
  return { root, project, config, harness }
}
function removeWorkspace(root: string) {
  fs.rmSync(root, { recursive: true, force: true })
  expect(fs.existsSync(root), `Temporary workspace cleanup: ${root}`).toBe(false)
}

type WireRequest = { model: string; messages: unknown[]; tools?: Array<{ function: { name: string; parameters: unknown } }> }
type ChildObservation = { inFlight: number; blocked: string[]; homeUnchanged: boolean; sdkIndex: string; sdkReady: boolean }

async function executeFence(fence: Fence, mode: 'success' | 'missing-config' | 'invalid-output' = 'success') {
  const owned = workspace()
  const requests: WireRequest[] = []
  const replies: string[] = []
  const protocolErrors: string[] = []
  let serving = 0
  const server = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    async fetch(request) {
      serving++
      try {
        if (request.method !== 'POST' || new URL(request.url).pathname !== '/v1/chat/completions')
          throw new Error(`Unexpected provider request: ${request.method} ${request.url}`)
        if (request.headers.has('authorization') || request.headers.has('x-api-key'))
          throw new Error('The loopback provider must be keyless')
        const body = await request.json() as WireRequest
        requests.push(body)
        if (requests.length > 12) throw new Error('Example exceeded the fixture request budget')
        const outputTool = body.tools?.find((tool) => tool.function.name === 'set_output')
        const structured = !!outputTool && messageText(body.messages).includes('## Output Schema')
        replies.push(structured ? 'set_output' : 'text')
        const history = JSON.stringify(body.messages)
        const text = history.includes(WORD) ? WORD : history.includes('Say ready') ? 'READY' : HELLO
        const deltas = structured ? [
          { role: 'assistant' },
          { tool_calls: [{ index: 0, id: `readme-output-${requests.length}`, type: 'function',
            function: { name: 'set_output', arguments: '' } }] },
          { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(mode === 'invalid-output' && requests.length === 1
            ? { summary: HELLO, changedFiles: 'not-an-array' } : structuredValue) } }] },
        ] : [{ role: 'assistant', content: text.slice(0, 5) }, { content: text.slice(5) }]
        const chunk = (delta: unknown, finish: string | null) => `data: ${JSON.stringify({
          id: 'readme-completion', object: 'chat.completion.chunk', created: 0, model: body.model,
          choices: [{ index: 0, delta, finish_reason: finish }],
          ...(finish ? { usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } } : {}),
        })}\n\n`
        return new Response(deltas.map((delta) => chunk(delta, null)).join('') +
          chunk({}, structured ? 'tool_calls' : 'stop') + 'data: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } })
      } catch (error) {
        protocolErrors.push(String(error))
        return Response.json({ error: { message: String(error) } }, { status: 400 })
      } finally { serving-- }
    },
  })
  let child: ReturnType<typeof spawn> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let closed = false
  const grouped = process.platform !== 'win32'
  const groupAlive = () => {
    if (!child?.pid || !grouped) return false
    try { process.kill(-child.pid, 0); return true }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error }
  }
  const killOwnedChild = () => {
    if (!child?.pid) return
    try { if (grouped) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL') }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
  }
  try {
    // Use the README's actual provider config; change only its loopback port and
    // select explicit test-only budgets, not new SDK defaults.
    const configFence = readme.match(/<!-- sdk-example-config: openbuff.json -->\s*```json\r?\n([\s\S]*?)\r?\n```/)
    if (!configFence) throw new Error('README provider setup is missing its executable config')
    const configuration = JSON.parse(configFence[1]!)
    configuration.providers.local.baseURL = `http://127.0.0.1:${server.port}/v1`
    configuration.maxAgentSteps = 6
    configuration.maxMissingOutputRetries = 1
    const configBytes = JSON.stringify(configuration)
    const configPath = path.join(owned.config, 'provider.json')
    if (mode !== 'missing-config') fs.writeFileSync(configPath, configBytes)
    const observationPath = path.join(owned.harness, 'child-observation.json')
    const preload = path.join(owned.harness, 'preload.ts')
    const importMap = path.join(owned.harness, 'tsconfig.json')
    // This is the ONLY import mapping. No SDK/runtime functions are replaced.
    fs.writeFileSync(importMap, JSON.stringify({ compilerOptions: {
      baseUrl: owned.harness, paths: { '@openbuff/sdk': [selectedIndex] },
    } }))
    fs.writeFileSync(preload, [
      "import { writeFileSync } from 'node:fs'",
      `const sdkIndex = ${JSON.stringify(selectedIndex)}`,
      `const origin = ${JSON.stringify(`http://127.0.0.1:${server.port}`)}`,
      'const home = process.env.HOME',
      'const blocked: string[] = []; let inFlight = 0',
      'const transport = globalThis.fetch',
      'function check(input: string | URL | Request) {',
      "  const url = new URL(input instanceof Request ? input.url : String(input))",
      "  if (url.origin !== origin || url.pathname !== '/v1/chat/completions') { blocked.push(url.href); throw new Error('External fetch forbidden: ' + url.href) }",
      '}',
      'globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {',
      '  check(input); inFlight++',
      '  try { return await transport(input, init) } finally { inFlight-- }',
      '}, { preconnect: (url: string | URL) => { check(url); transport.preconnect(url) } })',
      "const sdkReady = typeof (await import('@openbuff/sdk')).OpenbuffClient === 'function'",
      `process.on('exit', () => writeFileSync(${JSON.stringify(observationPath)}, JSON.stringify({ inFlight, blocked, homeUnchanged: process.env.HOME === home, sdkIndex, sdkReady })))`,
    ].join('\n'))
    const stdout: Buffer[] = [], stderr: Buffer[] = []
    const environment: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      // Preserve HOME exactly; hostConfiguration disables home/global discovery.
      ...(process.env.HOME === undefined ? {} : { HOME: process.env.HOME }),
      OPENBUFF_PROVIDER_CONFIG: configPath,
      OPENBUFF_CONFIG_DIR: owned.config,
      OPENBUFF_PROCESS_SUPERVISION: '0', OPENBUFF_TELEMETRY: '0', DO_NOT_TRACK: '1',
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
    }
    child = spawn(process.execPath, ['--no-env-file', '--no-install', '--tsconfig-override', importMap, '--preload', preload,
      path.join(owned.project, fence.filename)], {
      cwd: owned.project, env: environment, detached: grouped, stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout!.on('data', (bytes) => stdout.push(Buffer.from(bytes)))
    child.stderr!.on('data', (bytes) => stderr.push(Buffer.from(bytes)))
    const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child!.once('close', (code, signal) => { closed = true; resolve({ code, signal }) })
      child!.once('error', reject)
    })
    let expired = false
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        expired = true
        killOwnedChild()
        reject(new Error(`Child exceeded its ${CHILD_DEADLINE_MS} ms test deadline`))
      }, CHILD_DEADLINE_MS)
    })
    const status = await Promise.race([exit, deadline])
    clearTimeout(timer)
    const out = Buffer.concat(stdout).toString('utf8'), err = Buffer.concat(stderr).toString('utf8')
    const last = requests.at(-1)
    const detail = `${fence.label} [${mode}]\nstdout:\n${out}\nstderr:\n${err}\n` +
      `fixture replies: ${JSON.stringify(replies)}\nlast request: ${JSON.stringify(last && {
        model: last.model, toolNames: last.tools?.map((tool) => tool.function.name), messages: last.messages.slice(-5),
      })}`
    expect(expired, detail).toBe(false)
    expect(status.signal, detail).toBeNull()
    expect(status.code, detail).toBe(mode === 'missing-config' ? 1 : 0)
    expect(groupAlive(), `${detail}\nChild process group survived exit`).toBe(false)
    expect(serving, detail).toBe(0)
    expect(protocolErrors, detail).toEqual([])
    const observation = JSON.parse(fs.readFileSync(observationPath, 'utf8')) as ChildObservation
    expect(observation, detail).toEqual({ inFlight: 0, blocked: [], homeUnchanged: true, sdkIndex: selectedIndex, sdkReady: true })
    if (mode !== 'missing-config') expect(fs.readFileSync(configPath, 'utf8'), detail).toBe(configBytes)
    if (mode === 'missing-config') {
      expect(requests, detail).toHaveLength(0)
      expect(out, detail).not.toContain('Final output:')
      expect(err, detail).toContain(configPath)
    } else if (mode === 'invalid-output') {
      expect(requests, detail).toHaveLength(2)
      expect(replies, detail).toEqual(['set_output', 'set_output'])
      const toolResults = requests[1]!.messages.filter((message) =>
        !!message && typeof message === 'object' && 'role' in message && message.role === 'tool')
      expect(messageText(toolResults), detail).toMatch(/(validation|schema|array)/i)
      expect(JSON.parse(out.split('Structured output:')[1]!.trim()), detail).toEqual(structuredValue)
    } else if (fence.filename === 'example-setup.ts') {
      expect(requests, detail).toHaveLength(0)
    } else {
      expect(requests.length, detail).toBeGreaterThan(0)
      if (fence.filename === 'quickstart.ts') {
        expect(requests, detail).toHaveLength(1)
        expect(requests[0]!.model, detail).toBe('qwen3:8b')
        expect(out.split('Final output:')[0], detail).toContain(HELLO)
        const final = JSON.parse(out.split('Final output:')[1]!.trim())
        expect(final.type, detail).toBe('lastMessage')
        expect(messageText(final.value), detail).toBe(HELLO)
      } else if (fence.filename === 'structured-output.ts') {
        expect(requests, detail).toHaveLength(1)
        expect(requests.every((request) => request.model === 'qwen3-coder:30b'), detail).toBe(true)
        expect(JSON.parse(out.split('Structured output:')[1]!.trim()), detail).toEqual(structuredValue)
        expect(requests[0]!.tools?.some((tool) => tool.function.name === 'set_output'), detail).toBe(true)
        expect(messageText(requests[0]!.messages), detail).toContain('changedFiles')
      } else if (fence.filename === 'continuation.ts') {
        expect(requests, detail).toHaveLength(2)
        expect(requests.map((request) => request.model), detail).toEqual(['qwen3-coder:30b', 'qwen3:8b'])
        const history = requests[1]!.messages as Array<{ role: string; content: unknown }>
        expect(history.some((message) => message.role === 'assistant' && JSON.stringify(message.content).includes(WORD)), detail).toBe(true)
        expect(messageText(JSON.parse(out.split('Continued output:')[1]!.trim()).value), detail).toBe(WORD)
      } else if (fence.filename === 'deadline.ts') {
        expect(requests, detail).toHaveLength(1)
        expect(messageText(JSON.parse(out.split('Deadline output:')[1]!.trim()).value), detail).toBe('READY')
      }
    }
  } catch (error) {
    throw new Error(`${fence.label} [${mode}]: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  } finally {
    if (timer) clearTimeout(timer)
    try {
      if (!closed || groupAlive()) {
        killOwnedChild()
        if (child && !closed) {
          let cleanupTimer: ReturnType<typeof setTimeout> | undefined
          try {
            await Promise.race([
              new Promise<void>((resolve) => child!.once('close', () => resolve())),
              new Promise<never>((_, reject) => {
                cleanupTimer = setTimeout(() => reject(new Error(`${fence.label}: child cleanup was not observed`)), 2_000)
              }),
            ])
          } finally { if (cleanupTimer) clearTimeout(cleanupTimer) }
        }
      }
    } finally {
      server.stop(true)
      removeWorkspace(owned.root)
    }
  }
}

describe('SDK README executable TypeScript examples', () => {
  test('typechecks ALL fences and this harness against the selected public exports', () => {
    const owned = workspace()
    try {
      expect(fences[0]!.filename, 'The leading TypeScript fence must be the quickstart').toBe('quickstart.ts')
      expect(fences[0]!.code.trimEnd().split('\n').length, fences[0]!.label).toBeLessThanOrEqual(10)
      const config = ts.readConfigFile(path.join(sdkDir, 'tsconfig.json'), ts.sys.readFile)
      if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'))
      const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, sdkDir)
      const files = fences.map((fence) => path.join(owned.project, fence.filename))
      const program = ts.createProgram([...files, import.meta.path], {
        ...parsed.options, noEmit: true,
        typeRoots: [path.join(repoDir, 'node_modules/@types'), path.join(repoDir, 'node_modules')],
        paths: { ...parsed.options.paths, '@openbuff/sdk': [publicTypes] },
      })
      // Dependency implementation diagnostics belong to their owners. Check the
      // real imported types, but report syntactic/semantic errors in every fence.
      const diagnostics = [...program.getOptionsDiagnostics(), ...program.getGlobalDiagnostics()]
      for (const filename of [...files, import.meta.path]) {
        const file = program.getSourceFile(filename)
        if (!file) throw new Error(`TypeScript did not load ${filename}`)
        diagnostics.push(...program.getSyntacticDiagnostics(file), ...program.getSemanticDiagnostics(file))
      }
      const formatted = diagnostics.map((diagnostic) => {
        const index = files.indexOf(diagnostic.file?.fileName ?? '')
        const label = index < 0 ? diagnostic.file?.fileName ?? 'TypeScript options' : fences[index]!.label
        const position = diagnostic.file && diagnostic.start !== undefined
          ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start) : undefined
        return `${label}${position ? `:${position.line + 1}:${position.character + 1}` : ''}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`
      }).join('\n')
      expect(diagnostics, formatted).toHaveLength(0)
    } finally { removeWorkspace(owned.root) }
  }, 60_000)

  for (const fence of fences) test(fence.label, () => executeFence(fence), CHILD_DEADLINE_MS + 5_000)

  test('quickstart reports missing provider configuration honestly without a fetch', () => {
    const fence = fences.find((item) => item.filename === 'quickstart.ts')
    if (!fence) throw new Error('Missing quickstart.ts fence')
    return executeFence(fence, 'missing-config')
  }, CHILD_DEADLINE_MS + 5_000)

  test('structured example rejects invalid provider output and validates its repair before reporting success', () => {
    const fence = fences.find((item) => item.filename === 'structured-output.ts')
    if (!fence) throw new Error('Missing structured-output.ts fence')
    return executeFence(fence, 'invalid-output')
  }, CHILD_DEADLINE_MS + 5_000)
})

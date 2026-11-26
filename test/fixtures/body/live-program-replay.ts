import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { pathToFileURL } from 'node:url'
import { Database } from 'bun:sqlite'

type Part = string | { input: string } | { result: string }
type Operation = { id: string } & (
  | { kind: 'STEP' | 'STEP_ALL'; prompt: Part[] }
  | { kind: 'GENERATE_N'; count: number; prompt: Part[] }
  | { kind: 'clock' | 'random' }
  | { kind: 'sha256'; value: Part[] }
)
type RequestOptions = {
  journalPath: string
  program: { version: 1; operations: Operation[] }
  inputs: Record<string, string>
  model: { endpoint: string; name: string }
  resumeRunId?: string
  pauseAfter?: string
}
type Completed = {
  status: 'completed'
  runId: string
  agentId: string
  userInputId: string
  outputs: Record<string, unknown>
  retainedAttempts: number
  newAttempts: number
}
type Result = Completed | { status: string; reason: string; runId?: string }
type Frame = { pid: number; result: Result }
type Task = {
  entry: string
  request: RequestOptions
  hold?: true
  gate?: string
}
type Event = { run_id: string; seq: number; kind: string; payload: string }

const repo = path.resolve(import.meta.dir, '../../..')
const route = '/v1/chat/completions'
const seed = 'local 🔑 e\u0301\r\ninput'
const hash = (data: string | Uint8Array) =>
  createHash('sha256').update(data).digest('hex')
const fileHash = (file: string) => hash(fs.readFileSync(file))
const digestPrefix = 'openbuff-live-program-digest:'
const expectedDigest = hash(digestPrefix + seed)
const text = {
  first: 'recorded STEP reply',
  partial: 'recorded STEP_ALL partial; ',
  stop: 'recorded STEP_ALL stop',
  candidates: ['z-first candidate', 'a-second candidate'],
  tail: 'only the resumed run should get this reply',
}
const retainedOutputIds = [
  'first',
  'group',
  'candidates',
  'time',
  'entropy',
  'digest',
]
const prefix = ['first', 'group', ...retainedOutputIds.slice(1)]
const tag = (id: string) => `openbuff-live-program/${id}:`
const program: RequestOptions['program'] = {
  version: 1,
  operations: [
    { id: 'first', kind: 'STEP', prompt: [tag('first'), { input: 'seed' }] },
    {
      id: 'group',
      kind: 'STEP_ALL',
      prompt: [tag('group'), { result: 'first' }],
    },
    {
      id: 'candidates',
      kind: 'GENERATE_N',
      count: 2,
      prompt: [tag('candidates'), { result: 'group' }],
    },
    { id: 'time', kind: 'clock' },
    { id: 'entropy', kind: 'random' },
    { id: 'digest', kind: 'sha256', value: [digestPrefix, { input: 'seed' }] },
    {
      id: 'tail',
      kind: 'STEP',
      prompt: [
        tag('tail'),
        ...retainedOutputIds.flatMap((id) => [`\n${id}=`, { result: id }]),
      ],
    },
  ],
}
const writeJson = (file: string, data: unknown) =>
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', {
    flag: 'wx',
    mode: 0o600,
  })
const readJson = <T>(file: string) =>
  JSON.parse(fs.readFileSync(file, 'utf8')) as T

async function waitFor<T>(
  label: string,
  observe: () => T | undefined,
): Promise<T> {
  const until = performance.now() + 30_000
  while (performance.now() < until) {
    const seen = observe()
    if (seen !== undefined) return seen
    await Bun.sleep(10)
  }
  throw new Error(`Timed out waiting for ${label}`)
}

async function worker(dir: string) {
  const { entry, request, hold, gate } = readJson<Task>(
    path.join(dir, 'task.json'),
  )
  const endpoint = request.model.endpoint
  assert.match(endpoint, /^http:\/\/127\.0\.0\.1:\d+\/v1\/chat\/completions$/)
  const localFetch = globalThis.fetch.bind(globalThis)
  // A network guard, not a replay seam: every accepted call goes over real HTTP.
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input)
      if (url !== endpoint) {
        fs.appendFileSync(path.join(dir, 'denied-fetch.log'), url + '\n', {
          mode: 0o600,
        })
        throw new Error(
          'Fixture refuses fetch outside its owned loopback endpoint',
        )
      }
      return localFetch(input, init)
    },
    { preconnect() {} },
  ) as typeof fetch
  const { runReplayableProgram } = (await import(
    pathToFileURL(entry).href
  )) as {
    runReplayableProgram?: (request: RequestOptions) => Promise<Result>
  }
  assert.equal(
    typeof runReplayableProgram,
    'function',
    `Missing public runReplayableProgram export in ${entry}`,
  )
  if (gate) {
    writeJson(path.join(dir, 'ready.json'), { pid: process.pid })
    await waitFor('parent race release', () => fs.existsSync(gate) || undefined)
  }
  const result = await runReplayableProgram!(request)
  const draft = path.join(dir, 'result.tmp')
  writeJson(draft, { pid: process.pid, result } satisfies Frame)
  fs.renameSync(draft, path.join(dir, 'result.json'))
  // pauseAfter must leave the real run non-terminal; only the parent may kill it.
  if (hold)
    await new Promise<never>(() => {
      setInterval(() => {}, 1_000)
    })
}

function tape(file: string) {
  const db = new Database(file, { readonly: true })
  try {
    return db.transaction(() => ({
      runs: db
        .query('SELECT * FROM program_runs ORDER BY run_id')
        .all() as Record<string, unknown>[],
      events: db
        .query(
          'SELECT run_id, seq, kind, payload FROM program_events ORDER BY run_id, seq',
        )
        .all() as Event[],
    }))()
  } finally {
    db.close()
  }
}

type Tape = ReturnType<typeof tape>
const payload = (event: Event): unknown => JSON.parse(event.payload)
const contains = (tree: unknown, leaf: unknown): boolean =>
  isDeepStrictEqual(tree, leaf) ||
  (tree !== null &&
    typeof tree === 'object' &&
    Object.values(tree).some((value) => contains(value, leaf)))

function checkTape(snapshot: Tape, runId: string, kinds: string[]) {
  assert.deepEqual(
    snapshot.runs.map((row) => row.run_id),
    [runId],
  )
  assert.deepEqual(
    snapshot.events.map((event) => event.kind),
    kinds,
  )
  const start = snapshot.events[0]!.seq
  assert(start === 0 || start === 1, 'Journal must include its full sequence')
  for (const [index, event] of snapshot.events.entries()) {
    assert.equal(event.run_id, runId)
    assert.equal(event.seq, start + index)
  }
}

function copyForRefusal(
  source: string,
  target: string,
  mutate: (db: Database) => void,
) {
  // Copy a real killed-worker snapshot (including WAL data), never synthesize
  // a positive tape. Changes to the copy are strictly negative controls.
  const original = new Database(source, { readonly: true })
  try {
    original.run('VACUUM INTO ?', [target])
  } finally {
    original.close()
  }
  fs.chmodSync(target, 0o600)
  assert.deepEqual(tape(target), tape(source))
  const copy = new Database(target)
  try {
    mutate(copy)
  } finally {
    copy.close()
  }
}

type Chat = {
  model: string
  n?: number
  stream?: boolean
  messages: { role: string; content: string }[]
}
type Wire = {
  phase: string
  method: string
  url: string
  body?: Chat
  response?: unknown
  error?: string
}
const actions = [
  { id: 'first', finish: 'stop', choices: [text.first] },
  { id: 'group', finish: 'length', choices: [text.partial] },
  { id: 'group', finish: 'stop', choices: [text.stop] },
  { id: 'candidates', finish: 'stop', choices: text.candidates },
  { id: 'tail', finish: 'stop', choices: [text.tail] },
]
const userPrompt = (body: Chat) =>
  body.messages.filter(({ role }) => role === 'user').at(-1)?.content
const rendered = (value: unknown, jsonStrings: boolean) =>
  typeof value === 'string' && !jsonStrings ? value : JSON.stringify(value)

async function parent(args: string[]) {
  assert.equal(
    args.length,
    4,
    'Usage: --manifest <path> --evidence-dir <fresh-dir>',
  )
  const arg = (name: string) => {
    const i = args.indexOf(name)
    assert((i === 0 || i === 2) && args[i + 1], `Missing ${name}`)
    return path.resolve(args[i + 1]!)
  }
  const manifestPath = arg('--manifest')
  const manifestBytes = fs.readFileSync(manifestPath)
  const manifest = JSON.parse(manifestBytes.toString('utf8')) as {
    schemaVersion: number
    type: string
    tools: {
      bun: {
        expectedVersion: string
        expectedSha256ByHost: Record<string, string>
      }
    }
  }
  const fixtureSha256 = fileHash(import.meta.path)
  const executable = fs.realpathSync(process.execPath)
  const runtimeSha256 = fileHash(executable)
  assert.equal(manifest.schemaVersion, 1)
  assert.equal(manifest.type, 'body-bootstrap-selection')
  assert.equal(Bun.version, manifest.tools.bun.expectedVersion)
  assert.equal(
    runtimeSha256,
    manifest.tools.bun.expectedSha256ByHost[
      `${process.platform}-${process.arch}`
    ],
  )
  const artifact = process.env.OPENBUFF_LIVE_PROGRAM_ARTIFACT ?? 'esm'
  assert(
    artifact === 'esm',
    'Only the built SDK has a load-bound replay identity',
  )
  const explicitEntry = process.env.OPENBUFF_LIVE_PROGRAM_ESM_ENTRY
  assert(
    !explicitEntry ||
      (artifact === 'esm' &&
        path.isAbsolute(explicitEntry) &&
        explicitEntry.endsWith('.mjs')),
  )
  const entry = fs.realpathSync(
    explicitEntry ?? path.join(repo, 'sdk/dist/index.mjs'),
  )
  const entrySha256 = fileHash(entry)
  fs.mkdirSync(arg('--evidence-dir'), { mode: 0o700 })
  const root = fs.realpathSync(arg('--evidence-dir'))
  const home = path.join(root, 'home')
  fs.mkdirSync(home, { mode: 0o700 })
  const journal = (name: string) => path.join(root, `${name}.sqlite`)
  const common = { journalPath: journal('program'), program, inputs: { seed } }

  const wire: Wire[] = []
  let phase = 'prefix'
  let releaseTail!: () => void
  let releaseUnmatched!: () => void
  const tailResponse = new Promise<void>((resolve) => {
    releaseTail = resolve
  })
  const unmatchedResponse = new Promise<void>((resolve) => {
    releaseUnmatched = resolve
  })
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    idleTimeout: 60,
    async fetch(req) {
      const call: Wire = { phase, method: req.method, url: req.url }
      const index = wire.filter((prior) => prior.phase === call.phase).length
      wire.push(call)
      try {
        assert.equal(req.method, 'POST')
        assert.equal(new URL(req.url).pathname, route)
        assert.equal(
          req.headers.get('authorization'),
          null,
          'No API key is needed',
        )
        const body = (call.body = (await req.json()) as Chat)
        assert.equal(body.model, 'fixture')
        assert.notEqual(
          body.stream,
          true,
          'Fixture serves ordinary JSON, not SSE',
        )
        if (call.phase === 'large-output' || call.phase === 'wrong-role') {
          const role = call.phase === 'large-output' ? 'assistant' : 'user'
          call.response = {
            choices: [
              {
                index: 0,
                message: { role, content: 'x'.repeat(16 * 1024) },
                finish_reason: 'stop',
              },
            ],
          }
          return Response.json(call.response)
        }
        if (call.phase === 'redirect') {
          return Response.redirect(new URL('/unapproved', req.url), 307)
        }
        const action =
          call.phase === 'prefix' && index < 4
            ? actions[index]
            : call.phase === 'race' && index === 0
              ? actions[4]
              : call.phase === 'unmatched' && index === 0
                ? actions[0]
                : undefined
        assert(
          action,
          `Unexpected provider dispatch in ${call.phase} at ${index}`,
        )
        assert.equal(body.n ?? 1, action.choices.length)
        if (action.id === 'first')
          assert.equal(userPrompt(body), tag('first') + seed)
        else if (call.phase === 'prefix' && index === 2) {
          assert(
            body.messages.some(
              ({ role, content }) =>
                role === 'assistant' && content === text.partial,
            ),
            'STEP_ALL continuation must see its length reply',
          )
        } else assert(userPrompt(body)?.startsWith(tag(action.id)))
        if (call.phase === 'race') await tailResponse
        if (call.phase === 'unmatched') {
          await unmatchedResponse
          return new Response(null, { status: 503 }) // only released after kill/control
        }
        call.response = {
          id: `chatcmpl-${call.phase}-${index}`,
          object: 'chat.completion',
          created: 1,
          model: body.model,
          choices: action.choices.map((content, index) => ({
            index,
            message: { role: 'assistant', content },
            finish_reason: action.finish,
          })),
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
        }
        return Response.json(call.response)
      } catch (error) {
        call.error = String(error)
        return Response.json(
          { error: { message: call.error } },
          { status: 400 },
        )
      }
    },
  })
  const model = {
    endpoint: `http://127.0.0.1:${server.port}${route}`,
    name: 'fixture',
  }
  const request = { ...common, model }
  const command = [
    executable,
    '--no-env-file',
    '--no-install',
    'run',
    import.meta.path,
  ]
  function start(
    name: string,
    options: RequestOptions,
    extra: Pick<Task, 'hold' | 'gate'> = {},
  ) {
    const dir = path.join(root, name)
    fs.mkdirSync(dir, { mode: 0o700 })
    writeJson(path.join(dir, 'task.json'), {
      entry,
      request: options,
      ...extra,
    } satisfies Task)
    const child = Bun.spawn([...command, '--worker', dir], {
      cwd: root,
      env: { HOME: home, PATH: '/usr/bin:/bin', DO_NOT_TRACK: '1' },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const logs = Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    function readFrame(): Frame | undefined {
      const file = path.join(dir, 'result.json')
      if (fs.existsSync(file)) {
        const frame = readJson<Frame>(file)
        assert.equal(frame.pid, child.pid)
        return frame
      }
      assert.equal(
        child.exitCode,
        null,
        `${name} exited without a result; see ${dir}/stderr.log`,
      )
    }
    const result = () => waitFor(`${name} result`, readFrame)
    return {
      dir,
      child,
      readFrame,
      result,
      async finish() {
        const frame = await result()
        const code = await waitFor(
          `${name} exit`,
          () => child.exitCode ?? undefined,
        )
        assert.equal(code, 0, `Failed worker: ${name}`)
        return frame
      },
      async stop() {
        if (child.exitCode === null && child.signalCode === null)
          child.kill('SIGKILL')
        await child.exited
      },
      async save() {
        const [stdout, stderr] = await logs
        fs.writeFileSync(path.join(dir, 'stdout.log'), stdout, { mode: 0o600 })
        fs.writeFileSync(path.join(dir, 'stderr.log'), stderr, { mode: 0o600 })
      },
    }
  }
  const workers: ReturnType<typeof start>[] = []
  const launch: typeof start = (...args) => {
    const worker = start(...args)
    workers.push(worker)
    return worker
  }
  const noWireErrors = () =>
    assert.deepEqual(
      wire.flatMap((call) => (call.error ? [call.error] : [])),
      [],
    )
  const refusals: Record<string, Result> = {}
  function unavailable(result: Result, id: string) {
    assert.equal(result.status, 'replay_unavailable', JSON.stringify(result))
    assert(
      'reason' in result &&
        typeof result.reason === 'string' &&
        result.reason.trim(),
    )
    if (result.runId !== undefined) assert.equal(result.runId, id)
  }
  async function refuse(name: string, opts: RequestOptions) {
    phase = name
    const before = tape(opts.journalPath)
    const calls = wire.length
    const { result } = await launch(name, opts).finish()
    unavailable(result, opts.resumeRunId!)
    assert.equal(
      wire.length,
      calls,
      `${name} must refuse before provider dispatch`,
    )
    assert.deepEqual(
      tape(opts.journalPath),
      before,
      `${name} must not alter the tape or mint a run`,
    )
    refusals[name] = result
  }

  try {
    const beforeClock = Date.now()
    const original = launch(
      'original',
      { ...request, pauseAfter: 'digest' },
      { hold: true },
    )
    const pause = (await original.result()).result
    assert.notEqual(pause.status, 'completed')
    const runId = pause.runId
    assert(
      typeof runId === 'string' && runId.length > 0,
      'Pause must report the original run id',
    )
    const afterClock = Date.now()
    const paired = prefix.flatMap(() => ['request', 'reply'])
    const before = tape(request.journalPath)
    checkTape(before, runId, paired)
    for (const [index, operationId] of prefix.entries()) {
      assert(
        contains(payload(before.events[2 * index]!), operationId),
        `Wrong request at ${operationId}/${index}`,
      )
    }
    assert.equal(wire.length, 4, 'No tail dispatch at the durable cut')
    noWireErrors()
    await refuse('live-owner', { ...request, resumeRunId: runId })
    await original.stop()
    assert.equal(original.child.signalCode, 'SIGKILL')
    assert.deepEqual(
      tape(request.journalPath),
      before,
      'The prefix survives SIGKILL unchanged',
    )
    const resume = { ...request, resumeRunId: runId }
    await refuse('changed-input', {
      ...resume,
      inputs: { seed: seed + ' changed' },
    })
    const operations = structuredClone(program.operations)
    const tail = operations.at(-1)!
    assert(tail.kind === 'STEP')
    tail.prompt.push(' changed suffix only')
    await refuse('changed-bundle', {
      ...resume,
      program: { ...program, operations },
    })
    await refuse('missing-run', {
      ...resume,
      resumeRunId: 'local-program-' + '0'.repeat(32),
    })

    const runtime = journal('changed-runtime')
    copyForRefusal(request.journalPath, runtime, (db) => {
      assert.equal(
        db.run('UPDATE program_runs SET runtime_sha256 = ? WHERE run_id = ?', [
          '0'.repeat(64),
          runId,
        ]).changes,
        1,
      )
    })
    await refuse('changed-runtime', { ...resume, journalPath: runtime })
    const missing = journal('missing-reply')
    copyForRefusal(request.journalPath, missing, (db) => {
      assert.equal(
        db.run(
          'DELETE FROM program_events WHERE run_id = ? AND seq = ? AND kind = ?',
          [runId, before.events[7]!.seq, 'reply'],
        ).changes,
        1,
      )
    })
    await refuse('missing-reply', { ...resume, journalPath: missing })

    const gate = path.join(root, 'race-go.json')
    const racers = ['claimant-a', 'claimant-b'].map((name) =>
      launch(name, resume, { gate }),
    )
    assert.notEqual(racers[0]!.child.pid, racers[1]!.child.pid)
    await Promise.all(
      racers.map(({ dir, child }) =>
        waitFor(`${dir} ready`, () => {
          assert.equal(
            child.exitCode,
            null,
            `Claimant exited before the gate; see ${dir}/stderr.log`,
          )
          return fs.existsSync(path.join(dir, 'ready.json')) || undefined
        }),
      ),
    )
    phase = 'race'
    writeJson(gate, { release: true })
    const loser = await waitFor(
      'one claimant refused with the tail reply withheld',
      () => {
        noWireErrors()
        return racers
          .map((racer) => racer.readFrame())
          .find((frame) => frame !== undefined)
      },
    )
    unavailable(loser.result, runId)
    await waitFor('the single winning tail request', () => {
      noWireErrors()
      return wire.length === 5 && wire[4]!.body ? true : undefined
    })
    const pendingTail = tape(request.journalPath)
    checkTape(pendingTail, runId, [...paired, 'request'])
    assert.deepEqual(pendingTail.events.slice(0, -1), before.events)
    assert(contains(payload(pendingTail.events.at(-1)!), 'tail'))
    assert.equal(
      wire[4]!.response,
      undefined,
      'Winner must be awaiting its real provider reply',
    )
    releaseTail()
    const contenders = await Promise.all(racers.map((racer) => racer.finish()))
    assert.deepEqual(contenders.map(({ result }) => result.status).sort(), [
      'completed',
      'replay_unavailable',
    ])
    const resumed = contenders.find(
      ({ result }) => result.status === 'completed',
    )!.result as Completed
    assert.equal(resumed.runId, runId)
    assert.equal(resumed.agentId, before.runs[0]!.agent_id)
    assert.equal(resumed.userInputId, before.runs[0]!.user_input_id)
    assert(
      resumed.agentId && resumed.userInputId,
      'Retain both original actor identifiers',
    )
    assert.equal(resumed.retainedAttempts, prefix.length)
    assert.equal(resumed.newAttempts, 1)
    const { outputs } = resumed
    assert.deepEqual(
      Object.keys(outputs).sort(),
      [...retainedOutputIds, 'tail'].sort(),
    )
    assert.equal(outputs.first, text.first)
    assert(
      isDeepStrictEqual(outputs.group, [text.partial, text.stop]) ||
        outputs.group === text.partial + text.stop,
    )
    assert.deepEqual(outputs.candidates, text.candidates)
    assert.equal(outputs.tail, text.tail)
    assert.equal(
      outputs.digest,
      expectedDigest,
      'sha256 is a genuine tool result over fixture bytes',
    )
    const time =
      typeof outputs.time === 'number'
        ? outputs.time
        : Date.parse(String(outputs.time))
    assert(
      time >= beforeClock && time <= afterClock,
      'Clock value must come from the original worker',
    )
    assert(
      typeof outputs.entropy === 'number'
        ? Number.isFinite(outputs.entropy)
        : typeof outputs.entropy === 'string' && outputs.entropy.length > 0,
    )
    const values = [
      text.first,
      text.partial,
      text.stop,
      text.candidates,
      outputs.time,
      outputs.entropy,
      expectedDigest,
    ]
    for (const [index, value] of values.entries()) {
      const data = payload(before.events[2 * index + 1]!) as { reply?: unknown }
      const reply = data.reply
      const actual = Array.isArray(reply)
        ? reply.map((entry) => entry.text)
        : reply
      assert.deepEqual(
        actual,
        index < 3 ? [value] : value,
        `Retained reply differs for ${prefix[index]}`,
      )
    }
    const tailPrompt = userPrompt(wire[4]!.body!)
    assert(
      [false, true].some((jsonStrings) => {
        const parts = retainedOutputIds.map(
          (id) => `\n${id}=${rendered(outputs[id], jsonStrings)}`,
        )
        return tailPrompt === tag('tail') + parts.join('')
      }),
      'Live suffix must consume the exact retained values',
    )
    const after = tape(request.journalPath)
    checkTape(after, runId, [...paired, 'request', 'reply', 'terminal'])
    assert.deepEqual(
      after.events.slice(0, pendingTail.events.length),
      pendingTail.events,
      'No durable request or reply may be rewritten',
    )
    assert(contains(payload(after.events.at(-2)!), text.tail))
    noWireErrors()
    assert.equal(
      wire.length,
      5,
      'Exactly four original provider calls and one live suffix call',
    )
    await refuse('already-terminal', resume)

    phase = 'unmatched'
    const interrupted = { ...request, journalPath: journal('unmatched') }
    const inflight = launch('unmatched-original', interrupted)
    await waitFor('real unmatched model HTTP request', () => {
      assert.equal(
        inflight.child.exitCode,
        null,
        'Unmatched worker exited before dispatch',
      )
      noWireErrors()
      return wire.length === 6 && wire[5]!.body ? true : undefined
    })
    const uncertain = tape(interrupted.journalPath)
    const unmatchedId = uncertain.runs[0]?.run_id
    assert(typeof unmatchedId === 'string' && unmatchedId !== runId)
    checkTape(uncertain, unmatchedId, ['request'])
    assert(contains(payload(uncertain.events[0]!), 'first'))
    await inflight.stop()
    assert.equal(inflight.child.signalCode, 'SIGKILL')
    assert.deepEqual(tape(interrupted.journalPath), uncertain)
    await refuse('unmatched-resume', {
      ...interrupted,
      resumeRunId: unmatchedId,
    })
    assert.equal(wire.length, 6)
    assert.equal(wire[5]!.response, undefined)
    const tiny: RequestOptions['program'] = {
      version: 1,
      operations: [{ id: 'one', kind: 'STEP', prompt: ['owned text'] }],
    }
    phase = 'wrong-role'
    const wrongRole = {
      ...request,
      journalPath: journal('wrong-role'),
      program: tiny,
    }
    const invalidRole = (await launch('wrong-role', wrongRole).finish()).result
    assert.equal(invalidRole.status, 'failed')
    assert.equal(tape(wrongRole.journalPath).events.length, 1)
    phase = 'redirect'
    const redirect = {
      ...request,
      journalPath: journal('redirect'),
      program: tiny,
    }
    const beforeRedirect = wire.length
    const redirectRefused = (await launch('redirect', redirect).finish()).result
    assert.equal(redirectRefused.status, 'failed')
    assert.equal(
      wire.length,
      beforeRedirect + 1,
      'The client must not follow the redirect',
    )
    assert.equal(tape(redirect.journalPath).events.length, 1)
    phase = 'large-output'
    const many = {
      ...request,
      journalPath: journal('large-output'),
      program: {
        version: 1 as const,
        operations: Array.from({ length: 9 }, (_, index) => ({
          id: `item${index}`,
          kind: 'STEP' as const,
          prompt: ['owned text'],
        })),
      },
    }
    const wide = (await launch('large-output', many).finish())
      .result as Completed
    assert.equal(wide.status, 'completed')
    assert.equal(
      Object.values(wide.outputs).map(String).join('').length,
      9 * 16 * 1024,
    )
    assert.equal(tape(many.journalPath).events.at(-1)?.kind, 'terminal')
    await refuse('completed-unclaimed', { ...many, resumeRunId: wide.runId })
    for (const worker of workers)
      assert(
        !fs.existsSync(path.join(worker.dir, 'denied-fetch.log')),
        `Blocked network attempt in ${worker.dir}`,
      )
    assert.equal(
      fileHash(entry),
      entrySha256,
      'Selected entry bytes changed mid-run',
    )
    assert.equal(
      fileHash(executable),
      runtimeSha256,
      'Selected Bun bytes changed mid-run',
    )
    assert.equal(
      fileHash(import.meta.path),
      fixtureSha256,
      'Fixture bytes changed mid-run',
    )
    assert.deepEqual(
      fs.readFileSync(manifestPath),
      manifestBytes,
      'Manifest changed mid-run',
    )
    writeJson(path.join(root, 'observation.json'), {
      artifact,
      entry,
      entrySha256,
      fixtureSha256,
      runtime: { executable, version: Bun.version, sha256: runtimeSha256 },
      manifestSha256: hash(manifestBytes),
      cut: {
        pid: original.child.pid,
        signal: original.child.signalCode,
        pause,
        tape: before,
      },
      contenders,
      completedTape: after,
      edgeCases: {
        invalidRole,
        redirectRefused,
        largeOutputCount: Object.keys(wide.outputs).length,
      },
      refusals,
      unmatched: {
        pid: inflight.child.pid,
        signal: inflight.child.signalCode,
        tape: uncertain,
      },
    })
    console.log(
      'Verified live program replay: one claimant, seven retained attempts, one live suffix; unmatched request refused',
    )
  } finally {
    await Promise.all(workers.map((worker) => worker.stop()))
    releaseTail()
    releaseUnmatched()
    await server.stop(true)
    await Promise.all(workers.map((worker) => worker.save()))
    writeJson(path.join(root, 'provider-wire.json'), wire)
  }
}

const args = process.argv.slice(2)
if (args[0] === '--worker') {
  assert(args.length === 2 && args[1])
  await worker(args[1])
} else {
  await parent(args)
}

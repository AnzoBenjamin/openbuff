import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import {
  captureValueSha256,
  inspectReplayCapture,
  sealReplayCapture,
  verifyReplayWitness,
  type ReplayBasis,
  type ReplayCapture,
  type ReplayCaptureSeal,
  type ReplayEntry,
  type ReplayRequest,
  type ReplayWitness,
} from '../../../packages/agent-runtime/src/util/recorded-replay-prefix'
import type { JSONValue } from '../../../common/src/types/json'

const repo = path.resolve(import.meta.dir, '../../..')
const verifier = 'packages/agent-runtime/src/util/recorded-replay-prefix.ts'
const configuration = { lane: 'owned-pure-fixture', stepsAreSerial: true }
const input = {
  prompt: 'Record this owned fixture',
  workingValue: 'before\r\n',
}
const fileHash = (file: string) =>
  createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const json = <T>(file: string): T => {
  assert(
    fs.statSync(file).size <= 2 * 1024 * 1024,
    'Fixture capture is too large',
  )
  return JSON.parse(fs.readFileSync(file, 'utf8')) as T
}
const writeJson = (file: string, value: unknown) =>
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', {
    flag: 'wx',
    mode: 0o600,
  })

// The only reconstruction adapter used here. It is this known, data-only
// function, not a user bundle, a plugin hook, or the production agent loader.
function* fixture(
  initial: typeof input,
): Generator<ReplayRequest, JSONValue, JSONValue> {
  const clock = yield { kind: 'host', input: { call: 'clock.now' } }
  const random = yield { kind: 'host', input: { call: 'random.u32' } }
  const model = yield { kind: 'STEP', input: { prompt: initial.prompt, clock } }
  const all = yield { kind: 'STEP_ALL', input: { model, random } }
  const candidates = yield { kind: 'GENERATE_N', input: { n: 2, all } }
  const write = {
    kind: 'tool' as const,
    input: { name: 'owned_effect', value: initial.workingValue },
  }
  const first = yield write
  const second = yield write
  return { clock, random, candidates, effects: [first, second] }
}

function basisFor(runId: string, executable: string): ReplayBasis {
  return {
    runId,
    bundleSha256: fileHash(import.meta.path),
    runtimeSha256: fileHash(executable),
    contractSha256: fileHash(path.join(repo, verifier)),
    configurationSha256: captureValueSha256(configuration),
    inputSha256: captureValueSha256(input),
  }
}

function record(basis: ReplayBasis, effectFile: string): ReplayCapture {
  let effects = 0
  const observe = (request: ReplayRequest): JSONValue => {
    switch (request.kind) {
      case 'host': {
        assert(
          request.input &&
            typeof request.input === 'object' &&
            !Array.isArray(request.input),
        )
        if (request.input.call === 'clock.now') return Date.now()
        assert.equal(request.input.call, 'random.u32')
        return crypto.getRandomValues(new Uint32Array(1))[0]!
      }
      case 'STEP':
        return { text: 'first recorded model reply' }
      case 'STEP_ALL':
        return { text: 'recorded step-all reply' }
      case 'GENERATE_N':
        return ['first candidate', 'second candidate']
      case 'tool': {
        const observed = {
          effect: ++effects,
          inputSha256: captureValueSha256(request.input),
        }
        fs.appendFileSync(effectFile, JSON.stringify(observed) + '\n', {
          mode: 0o600,
        })
        return observed
      }
    }
  }
  const iterator = fixture(input)
  const entries: ReplayEntry[] = []
  const occurrences = new Map<string, number>()
  let next = iterator.next()
  while (!next.done) {
    const request = next.value
    const requestSha256 = captureValueSha256(request)
    const occurrence = occurrences.get(requestSha256) ?? 0
    occurrences.set(requestSha256, occurrence + 1)
    const result = observe(request)
    entries.push({
      ordinal: entries.length,
      occurrence,
      request,
      completion: { kind: 'recorded', requestSha256, result },
    })
    next = iterator.next(result)
  }
  assert.equal(effects, 2)
  return { version: 1, basis, entries, terminal: { output: next.value } }
}

function reconstruct(
  capture: unknown,
  basis: ReplayBasis,
  seal: ReplayCaptureSeal,
  perturb = false,
) {
  const observations = inspectReplayCapture(capture, basis, seal)
  const witness: ReplayWitness = { requests: [] }
  let entered = false
  if (observations.status === 'eligible_observations') {
    entered = true
    const iterator = fixture(input)
    let prior: JSONValue = null
    for (const pair of observations.pairs) {
      const next = iterator.next(prior)
      if (next.done) break
      const request =
        perturb && pair.ordinal === 1
          ? { kind: 'host' as const, input: { call: 'unexpected-input' } }
          : next.value
      witness.requests.push(request)
      if (captureValueSha256(request) !== pair.requestSha256) break
      prior = pair.result
    }
    if (
      observations.stop === 'terminal' &&
      witness.requests.length === observations.pairs.length &&
      witness.requests.every(
        (request, index) =>
          captureValueSha256(request) ===
          observations.pairs[index]!.requestSha256,
      )
    ) {
      const terminal = iterator.next(prior)
      if (terminal.done) witness.terminal = { output: terminal.value }
      else witness.requests.push(terminal.value)
    }
  }
  return {
    entered,
    verification: verifyReplayWitness(capture, basis, seal, witness),
    terminal: witness.terminal,
  }
}

type Checkpoint = { basis: ReplayBasis; seal: ReplayCaptureSeal }
function worker(directory: string) {
  const checkpoint = json<Checkpoint>(path.join(directory, 'checkpoint.json'))
  const capture = json<ReplayCapture>(path.join(directory, 'capture.json'))
  const basis = basisFor(
    checkpoint.basis.runId,
    fs.realpathSync(process.execPath),
  )
  assert.deepEqual(
    basis,
    checkpoint.basis,
    'The selected fixture source or environment changed',
  )
  const cases: Record<string, ReturnType<typeof reconstruct>> = {}
  const withTrace = (
    candidate: ReplayCapture,
    seal: ReplayCaptureSeal,
    perturb = false,
  ) => reconstruct(candidate, basis, seal, perturb)
  cases.recorded = withTrace(capture, checkpoint.seal)
  assert.deepEqual(cases.recorded.verification, {
    status: 'verified',
    verifiedSteps: 7,
    liveReplayPermitted: false,
  })
  assert.deepEqual(cases.recorded.terminal, capture.terminal)
  for (const field of [
    'bundleSha256',
    'runtimeSha256',
    'contractSha256',
    'configurationSha256',
    'inputSha256',
  ] as const) {
    cases[field] = reconstruct(
      capture,
      { ...basis, [field]: captureValueSha256({ changed: field }) },
      checkpoint.seal,
    )
    assert.equal(cases[field]!.entered, false)
    assert.deepEqual(cases[field]!.verification, {
      status: 'unavailable',
      reason: 'basis_mismatch',
      verifiedSteps: 0,
      liveReplayPermitted: false,
    })
  }
  cases.missingRow = withTrace(
    { ...capture, entries: capture.entries.slice(1) },
    checkpoint.seal,
  )
  assert.equal(cases.missingRow.entered, false)
  assert.deepEqual(cases.missingRow.verification, {
    status: 'unavailable',
    reason: 'seal_mismatch',
    verifiedSteps: 0,
    liveReplayPermitted: false,
  })

  const { terminal: _terminal, entries: _entries, ...head } = capture
  const unfinished = (ordinal: number, uncertain: boolean): ReplayCapture => {
    const entries = capture.entries.slice(0, ordinal + 1)
    const { completion: _completion, ...frontier } = entries[ordinal]!
    entries[ordinal] = uncertain
      ? {
          ...frontier,
          completion: {
            kind: 'uncertain',
            requestSha256: captureValueSha256(frontier.request),
          },
        }
      : frontier
    return { ...head, entries }
  }
  const missingRandom = unfinished(1, false)
  cases.unrecordedRandom = withTrace(
    missingRandom,
    sealReplayCapture(missingRandom),
  )
  assert.deepEqual(cases.unrecordedRandom.verification, {
    status: 'unavailable',
    reason: 'missing_result',
    verifiedSteps: 1,
    liveReplayPermitted: false,
  })
  const uncertainEffect = unfinished(5, true)
  cases.uncertainEffect = withTrace(
    uncertainEffect,
    sealReplayCapture(uncertainEffect),
  )
  assert.deepEqual(cases.uncertainEffect.verification, {
    status: 'unavailable',
    reason: 'uncertain_effect',
    verifiedSteps: 5,
    liveReplayPermitted: false,
  })
  cases.divergence = withTrace(capture, checkpoint.seal, true)
  assert.deepEqual(cases.divergence.verification, {
    status: 'unavailable',
    reason: 'yield_diverged',
    verifiedSteps: 1,
    liveReplayPermitted: false,
  })
  process.stdout.write('B15_PREFIX ' + JSON.stringify(cases) + '\n')
}

function parent(args: string[]) {
  assert.equal(
    args.length,
    4,
    'Usage: --manifest <file> --evidence-dir <fresh directory>',
  )
  const flag = (name: string) => {
    const index = args.indexOf(name)
    assert((index === 0 || index === 2) && args[index + 1], `Missing ${name}`)
    return path.resolve(args[index + 1]!)
  }
  const executable = fs.realpathSync(process.execPath)
  const manifestPath = flag('--manifest')
  const manifest = json<{
    schemaVersion: number
    type: string
    tools: {
      bun: {
        expectedVersion: string
        expectedSha256ByHost: Record<string, string>
      }
    }
  }>(manifestPath)
  const host = `${process.platform}-${process.arch}`
  const manifestSha256 = fileHash(manifestPath)
  assert.equal(manifest.schemaVersion, 1)
  assert.equal(manifest.type, 'body-bootstrap-selection')
  assert.equal(Bun.version, manifest.tools.bun.expectedVersion)
  const basis = basisFor(crypto.randomUUID(), executable)
  assert.equal(
    basis.runtimeSha256,
    manifest.tools.bun.expectedSha256ByHost[host],
  )
  const directory = flag('--evidence-dir')
  fs.mkdirSync(directory, { mode: 0o700 })
  const effectFile = path.join(directory, 'owned-effects.jsonl')
  const capture = record(basis, effectFile)
  writeJson(path.join(directory, 'capture.json'), capture)
  writeJson(path.join(directory, 'checkpoint.json'), {
    basis,
    seal: sealReplayCapture(capture),
  })
  const ownedBefore = fs.readFileSync(effectFile, 'utf8')
  assert.equal(ownedBefore.trimEnd().split('\n').length, 2)
  const files = ['capture.json', 'checkpoint.json', 'owned-effects.jsonl']
  const hashes = () =>
    Object.fromEntries(
      files.map((file) => [file, fileHash(path.join(directory, file))]),
    )
  const before = hashes()
  const command = [
    executable,
    '--no-env-file',
    '--no-install',
    'run',
    import.meta.path,
    '--replay-worker',
    directory,
  ]
  const observed = Bun.spawnSync({
    cmd: command,
    cwd: directory,
    env: { PATH: '/usr/bin:/bin', HOME: directory, DO_NOT_TRACK: '1' },
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 30_000,
  })
  const stdout = observed.stdout.toString()
  const stderr = observed.stderr.toString()
  fs.writeFileSync(path.join(directory, 'worker.stdout.log'), stdout)
  fs.writeFileSync(path.join(directory, 'worker.stderr.log'), stderr)
  assert.equal(observed.exitCode, 0, stderr)
  assert.deepEqual(hashes(), before, 'Reconstruction changed an owned artifact')
  assert.equal(fileHash(manifestPath), manifestSha256)
  assert.deepEqual(basisFor(basis.runId, executable), basis)
  const line = stdout
    .split('\n')
    .filter((text) => text.startsWith('B15_PREFIX '))
  assert.equal(line.length, 1)
  const cases = JSON.parse(line[0]!.slice('B15_PREFIX '.length))
  writeJson(path.join(directory, 'observations.json'), cases)
  writeJson(path.join(directory, 'receipt.json'), {
    schemaVersion: 1,
    kind: 'local-recorded-prefix-evidence',
    node: 'B15',
    accepted: false,
    basis,
    command,
    exitCode: observed.exitCode,
    manifestPath,
    manifestSha256,
    host,
    bunVersion: Bun.version,
    artifactSha256: {
      ...before,
      observations: fileHash(path.join(directory, 'observations.json')),
    },
    effectsBeforeReplay: 2,
    effectsAfterReplay: 2,
    scope:
      'Known pure fixture reconstructed in a fresh process from sealed observations. This is not verification of production agent bundles or permission to resume live execution.',
  })
  console.log(
    `B15 sealed prefix: ${Object.keys(cases).length} controls; two owned effects, no replay effects`,
  )
}

const args = process.argv.slice(2)
if (args[0] === '--replay-worker') {
  assert.equal(args.length, 2)
  worker(path.resolve(args[1]!))
} else parent(args)

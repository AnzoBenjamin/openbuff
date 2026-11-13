import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

// Source SDK/runtime/common modules are imported only after this barrier.
const fetchObservations = { attempted: 0, refused: 0, forwarded: 0 }
globalThis.fetch = Object.assign(async () => {
  fetchObservations.attempted++
  fetchObservations.refused++
  throw new Error('B05 byte fixture refuses external fetch')
}, { preconnect() {} }) as typeof fetch
assert.equal(Bun.version, '1.3.5')
const out = path.resolve(process.argv[2] ?? '')
assert(process.argv[2], 'A fresh evidence directory is required')
fs.mkdirSync(out, { recursive: false })
const hash = (bytes: Uint8Array | string) => 'sha256:' + createHash('sha256').update(bytes).digest('hex')
const write = (name: string, value: unknown) => fs.writeFileSync(name, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' })

const { OpenbuffClient } = await import('../../../sdk/src/client')
const { createNodeFileSystem } = await import('../../../sdk/src/tools/node-filesystem')
const { WorkspaceMutationBroker } = await import('../../../sdk/src/services/workspace-mutation-broker')
const { getCustomToolDefinition } = await import('../../../sdk/src/custom-tool')
const { z } = await import('zod/v4')
const codec = await import('../../../common/src/util/byte-text')
const caps = await import('../../../common/src/util/content-hash')
const { fileMutationResultV1Schema, getConfirmedAppliedActionsV1 } = await import('../../../common/src/tools/results/filesystem')

type Case = {
  name: string
  before: string
  read: 'whole' | 'range' | 'window' | 'around'
  operation: 'range' | 'str_replace' | 'transaction_range' | 'delete' | 'move' | 'rollback' | 'foreign_rollback' | 'partial_rollback' | 'read_only'
  expected: string | null
  drift?: string
  token?: 'legacy' | 'unsigned' | 'missing'
  adapter?: 'missing_basis' | 'partial' | 'virtual_view' | 'unsigned_basis'
  refused?: boolean
  finalEntry?: boolean
  child?: boolean
  line?: number
  noReadAuthority?: boolean
  forceBounded?: boolean
  growBeforeBoundedRead?: boolean
}
const target = 'OLD😀e\u0301'
const replacement = 'NEW😀e\u0301'
const base = 'prefix\r\n' + target + '\r\nsuffix\n'
const cases: Case[] = []
for (const bom of [false, true]) {
  for (const eol of ['lf', 'crlf', 'mixed'] as const) {
    for (const final of [false, true]) {
      const first = eol === 'lf' ? '\n' : '\r\n'
      const second = eol === 'crlf' ? '\r\n' : '\n'
      const before = (bom ? '\uFEFF' : '') + 'prefix' + first + target + second + 'suffix' + (final ? second : '')
      for (const operation of ['range', 'str_replace', 'transaction_range'] as const) {
        cases.push({ name: `${bom ? 'bom' : 'plain'}-${eol}-${final ? 'terminated' : 'unterminated'}-${operation}`,
          before, read: 'range', operation, expected: before.replace(target, replacement) })
      }
    }
  }
}
for (const [name, before] of [
  ['lone-cr-content', 'prefix\rcontent\n' + target + '\nsuffix\rcontent'],
  ['later-feff-content', 'prefix\n' + target + '\uFEFF\nsuffix'],
] as const) cases.push({ name, before, read: 'range', operation: 'range',
  expected: before.replace(target + (name === 'later-feff-content' ? '\uFEFF' : ''), replacement) })
for (const before of ['', '\uFEFF', 'a\n', '\uFEFFa\r\n']) {
  const name = before === '' ? 'empty' : before === '\uFEFF' ? 'bom-only' : before.startsWith('\uFEFF') ? 'bom-final-empty' : 'final-empty'
  cases.push({ name, before, read: 'whole', operation: 'range', finalEntry: true,
    expected: before + replacement })
}
for (const operation of ['delete', 'move', 'rollback', 'foreign_rollback', 'partial_rollback'] as const) {
  cases.push({ name: operation + '-bom-mode', before: '\uFEFF' + base, read: 'whole', operation,
    expected: operation === 'delete' || operation === 'move' ? null : operation === 'foreign_rollback' ? 'foreign\r\n' : '\uFEFF' + base })
}
cases.push({ name: 'whole-localized-healthy', before: '\uFEFF' + base, read: 'whole', operation: 'range',
  expected: ('\uFEFF' + base).replace(target, replacement) })
for (const [name, drift] of [
  ['bom-only-drift', base], ['eol-only-drift', ('\uFEFF' + base).replaceAll('\r\n', '\n')],
  ['final-terminator-drift', ('\uFEFF' + base).slice(0, -1)], ['outside-insertion', 'inserted\n\uFEFF' + base],
] as const) cases.push({ name: 'whole-refuses-' + name, before: '\uFEFF' + base, read: 'whole',
  operation: 'range', drift, expected: drift, refused: true })
cases.push({ name: 'scoped-unique-reanchor', before: base, read: 'range', operation: 'range',
  drift: 'inserted\n' + base, expected: ('inserted\n' + base).replace(target, replacement) })
cases.push({ name: 'scoped-outside-raw-eol-drift', before: base, read: 'range', operation: 'range',
  drift: base.replace('prefix\r\n', 'prefix\n'), expected: base.replace('prefix\r\n', 'prefix\n').replace(target, replacement) })
cases.push({ name: 'scoped-outside-bom-removal', before: '\uFEFF' + base, read: 'range', operation: 'range',
  drift: base, expected: base.replace(target, replacement) })
cases.push({ name: 'scoped-refuses-included-bom-drift', before: '\uFEFF' + target + '\r\nsuffix\n', read: 'range', line: 1,
  operation: 'range', drift: target + '\r\nsuffix\n', expected: target + '\r\nsuffix\n', refused: true })
for (const [name, drift] of [
  ['inside-eol', base.replace(target + '\r\n', target + '\n')],
  ['duplicate-at-original-bounds', 'prefix\r\n' + target + '\r\n' + target + '\r\nsuffix\n'],
  ['duplicate-after-original', base + target + '\r\n'],
  ['over-budget-ambiguity', base + 'x\n'.repeat(2_000_001) + target + '\r\n'],
] as const) cases.push({ name: 'scoped-refuses-' + name, before: base, read: 'range', operation: 'range',
  drift, expected: drift, refused: true })
for (const token of ['legacy', 'unsigned', 'missing'] as const) cases.push({ name: token + '-basis-refusal',
  before: base, read: 'range', operation: 'range', token, expected: base, refused: true })
for (const adapter of ['missing_basis', 'partial', 'virtual_view', 'unsigned_basis'] as const) cases.push({ name: adapter + '-read-refusal',
  before: base, read: 'range', operation: 'range', adapter, expected: base, refused: true })
for (const read of ['window', 'around'] as const) cases.push({ name: read + '-raw-source', before: '\uFEFF' + base,
  read, operation: 'range', expected: ('\uFEFF' + base).replace(target, replacement) })
cases.push({ name: 'child-remint-raw-source', before: '\uFEFF' + base, read: 'range', operation: 'range', child: true,
  expected: ('\uFEFF' + base).replace(target, replacement) })
cases.push({ name: 'scoped-view-leading-feff-content', before: 'prefix\n\uFEFF' + target + '\r\nsuffix',
  read: 'range', operation: 'str_replace', forceBounded: true,
  expected: ('prefix\n\uFEFF' + target + '\r\nsuffix').replace(target, replacement) })
const huge = 'x'.repeat(24 * 1024 * 1024)
cases.push({ name: 'actual-long-selected-no-authority', before: huge, read: 'range', line: 1, operation: 'read_only',
  expected: huge, noReadAuthority: true })
cases.push({ name: 'actual-long-skipped-scoped-authority', before: huge + '\n' + target + '\r\n', read: 'range',
  operation: 'read_only', expected: huge + '\n' + target + '\r\n' })
cases.push({ name: 'actual-long-remainder-scoped-authority', before: target + '\r\n' + huge, read: 'range', line: 1,
  operation: 'read_only', expected: target + '\r\n' + huge })
cases.push({ name: 'actual-stat-growth-no-whole-authority', before: base, read: 'whole', operation: 'read_only',
  expected: base + huge, noReadAuthority: true, growBeforeBoundedRead: true })
const requestedCase = process.argv.includes('--case') ? process.argv[process.argv.indexOf('--case') + 1] : undefined
assert(!requestedCase || cases.some(spec => spec.name === requestedCase), 'Unknown requested case')
const selectedCases = requestedCase ? cases.filter(spec => spec.name === requestedCase) : cases

function readInput(spec: Case) {
  if (spec.read === 'whole') return { paths: ['target.txt', ...(spec.operation.includes('rollback') ? ['second.txt'] : [])] }
  if (spec.read === 'window') return { windows: [{ path: 'target.txt', windowSize: 3, window: 1 }] }
  if (spec.read === 'around') return { around: [{ path: 'target.txt', match: target, contextLines: 1 }] }
  return { ranges: [{ path: 'target.txt', startLine: spec.line ?? 2, endLine: spec.line ?? 2 }] }
}

function generator(spec: Case): string {
  // The generator receives actual tool results. It never imports source or mints authority.
  return `function* () {
    const read = yield { toolName: 'read_files', input: ${JSON.stringify(readInput(spec))} };
    const values = read.toolResult.filter(x => x.type === 'json').map(x => x.value);
    const items = values.flatMap(x => Array.isArray(x) ? x : x.results || [x]);
    const item = items.find(x => x.path === 'target.txt');
    const anchors = item ? [item.editAnchor, ...(item.slices || []).map(x => x.editAnchor)].filter(Boolean) : [];
    const original = anchors[0] && anchors[0].readCapability;
    const checked = yield { toolName: 'b05_fixture_checkpoint', input: { token: original || '', runId: read.agentState.runId } };
    const token = checked.toolResult.find(x => x.type === 'json').value.token;
    const edits = [];
    const mode = ${JSON.stringify(spec.operation)};
    const line = ${spec.finalEntry ? `((item && item.editAnchor && item.editAnchor.endLine) || 1)` : String(spec.line ?? 2)};
    if (mode === 'read_only') {
      // Persist the actual read result and its scope without attempting a mutation.
    } else if (mode === 'range') {
      const changed = yield {toolName: 'replace_range', input: {path:'target.txt',readCapability:token,startLine:line,endLine:line,newContent:${JSON.stringify(replacement)}}};
      edits.push(changed.toolResult);
    } else if (mode === 'str_replace') {
      const changed = yield {toolName:'str_replace',input:{path:'target.txt',replacements:[{oldString:${JSON.stringify(target)},newString:${JSON.stringify(replacement)},basedOnRead:token}]}};
      edits.push(changed.toolResult);
    } else {
      const group = mode === 'delete' ? [{type:'delete',path:'target.txt'}]
        : mode === 'move' ? [{type:'move',path:'target.txt',destinationPath:'moved.txt'}]
        : mode === 'transaction_range' ? [{type:'replace_range',path:'target.txt',readCapability:token,startLine:2,endLine:2,newContent:${JSON.stringify(replacement)}}]
        : [{type:'str_replace',path:'target.txt',replacements:[{oldString:${JSON.stringify(target)},newString:${JSON.stringify(replacement)},basedOnRead:token}]},
           {type:'str_replace',path:'second.txt',replacements:[{oldString:'second-before',newString:'second-after'}]}];
      const changed = yield {toolName:'edit_transaction',input:{edits:group}};
      edits.push(changed.toolResult);
    }
    yield {toolName:'set_output',input:{readResults:values,originalToken:original || null,usedToken:token,editResults:edits,done:true}};
  }`
}

function tokens(value: unknown): string[] {
  if (typeof value === 'string') return value.startsWith('cap.v4.') ? [value] : []
  if (Array.isArray(value)) return value.flatMap(tokens)
  return value && typeof value === 'object' ? Object.values(value).flatMap(tokens) : []
}

function observedToken(token: string, separateChild: boolean) {
  const verified = caps.decodeReadCapabilityToken(token)
  if (!separateChild) return verified
  // A parent cannot authenticate a child's HMAC with the parent's key. These
  // are diagnostic payload facts only; the actual child edit must consume the
  // capability successfully, and bridge tests verify child-local signatures.
  assert.equal(typeof verified, 'string', 'A separate child reused the parent signing key')
  try {
    if (!token.startsWith('cap.v4.')) return verified
    return { ...JSON.parse(Buffer.from(token.split('.')[2]!, 'base64url').toString('utf8')), tokenVersion: 'v4' }
  } catch { return verified }
}

function snapshot(directory: string, workspace: string, label: string) {
  const result: Record<string, unknown> = {}
  for (const name of ['target.txt', 'second.txt', 'moved.txt']) {
    const file = path.join(workspace, name)
    if (!fs.existsSync(file)) { result[name] = null; continue }
    const bytes = fs.readFileSync(file)
    const artifact = path.join(directory, label + '-' + name + '.bin')
    fs.writeFileSync(artifact, bytes, { flag: 'wx' })
    result[name] = { path: file, bytes: bytes.length, rawHash: hash(bytes), mode: fs.statSync(file).mode & 0o777,
      artifact, ...(bytes.length <= 65536 ? { hex: bytes.toString('hex') } : { firstHex: bytes.subarray(0, 64).toString('hex'), lastHex: bytes.subarray(-64).toString('hex') }) }
  }
  return result
}

const reports: unknown[] = []
for (const spec of selectedCases) {
  const directory = path.join(out, spec.name)
  const workspace = path.join(directory, 'workspace')
  fs.mkdirSync(workspace, { recursive: true })
  fs.writeFileSync(path.join(workspace, 'target.txt'), spec.before)
  fs.writeFileSync(path.join(workspace, 'second.txt'), 'second-before\r\n')
  fs.chmodSync(path.join(workspace, 'target.txt'), 0o751)
  fs.chmodSync(path.join(workspace, 'second.txt'), 0o640)
  const before = snapshot(directory, workspace, 'before')
  const broker = await WorkspaceMutationBroker.create({ cwd: workspace, stateDir: path.join(directory, 'broker') })
  const source = createNodeFileSystem({ mutationBroker: broker })
  const adapterEvents: unknown[] = []
  const checkpointEvents: unknown[] = []
  const observedReadBases: any[] = []
  const observers: unknown[] = []
  const afterCapabilityObservations: unknown[] = []
  const events: any[] = []
  const errors: string[] = []
  const check = (condition: unknown, message: string) => { if (!condition) errors.push(message) }
  const baseCommit = source.conditionalCommit!.bind(source)
  let grewBeforeRead = false
  let initialReadCheckpointReached = false
  for (const name of ['readTextFile', 'readTextRange'] as const) {
    const original = source[name]
    if (!original) continue
    ;(source as any)[name] = Object.assign(async (...args: unknown[]) => {
      if (spec.growBeforeBoundedRead && name === 'readTextFile' && !grewBeforeRead) {
        grewBeforeRead = true
        fs.appendFileSync(path.join(workspace, 'target.txt'), huge)
        adapterEvents.push({ grewBeforeBoundedRead: true, appendedBytes: Buffer.byteLength(huge) })
      }
      const result = await (original as any)(...args)
      observedReadBases.push({ reader: name, complete: result.complete, metadataComplete: result.metadataComplete,
        returnedBytes: result.data.byteLength, rawBasis: result.rawBasis ? { ...result.rawBasis } : null })
      return result
    }, { readFileView: original.readFileView })
  }
  if (spec.operation.includes('rollback')) source.conditionalCommit = async (file, data, options) => {
    if (String(file) === path.join(workspace, 'second.txt') && String(data).includes('second-after')) {
      if (spec.operation === 'foreign_rollback') fs.writeFileSync(path.join(workspace, 'target.txt'), 'foreign\r\n')
      if (spec.operation === 'partial_rollback') fs.writeFileSync(path.join(workspace, 'second.txt'), 'partial\r\n')
      adapterEvents.push({ path: String(file), requestedHash: hash(typeof data === 'string' ? data : new Uint8Array(data.buffer, data.byteOffset, data.byteLength)), threw: 'B05 injected later commit failure' })
      throw new Error('B05 injected later commit failure')
    }
    const result = await baseCommit(file, data, options)
    adapterEvents.push({ path: String(file), options, result })
    return result
  }
  if (spec.adapter) {
    // Decorate actual capabilities, preserving their view identity except in the deliberate virtual-view control.
    for (const name of ['readTextFile', 'readTextRange'] as const) {
      const original = (source as any)[name]
      if (!original) continue
      ;(source as any)[name] = Object.assign(async (...args: unknown[]) => {
        const result = await original(...args)
        adapterEvents.push({ name, original: { ...result, data: undefined }, returnedBytes: result.data.byteLength })
        const changed = { ...result }
        if (spec.adapter === 'missing_basis') { delete changed.rawBasis; delete changed.metadataComplete }
        if (spec.adapter === 'partial') changed.complete = false
        if (spec.adapter === 'unsigned_basis' && changed.rawBasis) changed.rawBasis = { ...changed.rawBasis,
          rawHash: 'sha256:' + '0'.repeat(64), documentRawHash: 'sha256:' + '0'.repeat(64) }
        return changed
      }, { readFileView: original.readFileView })
    }
    if (spec.adapter === 'virtual_view') source.readFile = async () => Buffer.from('virtual\n' + target + '\nview') as any
    // Force the bounded range path without allocating an oversized fixture for unsupported-adapter controls.
    if (spec.adapter !== 'virtual_view') {
      const baseStat = source.stat.bind(source)
      source.stat = async (...args: any[]) => { const stat = await (baseStat as any)(...args); return Object.assign(Object.create(stat), { size: 11 * 1024 * 1024 }) }
    }
  }
  if (spec.forceBounded) {
    const baseStat = source.stat.bind(source)
    source.stat = async (...args: any[]) => { const stat = await (baseStat as any)(...args); return initialReadCheckpointReached ? stat : Object.assign(Object.create(stat), { size: 11 * 1024 * 1024 }) }
  }
  const checkpoint = getCustomToolDefinition({
    toolName: 'b05_fixture_checkpoint', description: 'Owned byte fixture drift and token attack control',
    inputSchema: z.object({ token: z.string(), runId: z.string().min(1) }),
    execute: ({ token, runId }) => {
      initialReadCheckpointReached = true
      const decoded = token ? observedToken(token, Boolean(spec.child)) : 'missing'
      if (spec.noReadAuthority) check(!token, 'Incomplete actual large-line read granted fresh authority')
      else if (!spec.adapter) {
        check(typeof decoded !== 'string' && decoded.tokenVersion === 'v4', 'Fresh actual SDK read did not mint v4 raw authority')
        if (typeof decoded !== 'string') {
          check(caps.readCapabilityMatchesScope(decoded, { projectId: workspace, path: 'target.txt', runId }), 'Actual read token scope differs from receiving agent')
          check(decoded.rawBasis?.documentRawHash === hash(spec.before), 'Read raw basis differs from exact disk preimage')
          check(decoded.rawBasis?.documentBytes === Buffer.byteLength(spec.before), 'Read basis document byte count differs')
          check(observedReadBases.some(source => source.rawBasis?.generation === decoded.rawBasis?.generation &&
            source.rawBasis?.view === decoded.rawBasis?.view && source.rawBasis?.coherence === decoded.rawBasis?.coherence),
            'Reminted basis provenance is not an actual observed adapter source')
          if (spec.read === 'range') check(decoded.rawBasis?.scope === 'lines', 'Range read widened to whole raw authority')
          if (spec.read === 'whole') check(decoded.rawBasis?.scope === 'whole', 'Whole read lacks whole raw authority')
          check(decoded.rawBasis?.view === 'descriptor' && decoded.rawBasis?.coherence === 'checked' && Boolean(decoded.rawBasis.generation), 'Descriptor source provenance was dropped or invented during remint')
        }
      } else check(!token, 'Missing/partial/virtual adapter granted fresh edit authority')
      let used = token
      if (spec.token === 'legacy' && typeof decoded !== 'string') {
        used = caps.encodeReadCapabilityToken({ startLine: decoded.startLine, endLine: decoded.endLine, hash: decoded.hash,
          scope: { projectId: workspace, path: 'target.txt', runId } })
        check(typeof caps.decodeReadCapabilityToken(used) !== 'string', 'Legacy attack is not an authenticated v3 control')
      }
      if (spec.token === 'unsigned' && token.startsWith('cap.v4.')) {
        const parts = token.split('.')
        const payload = JSON.parse(Buffer.from(parts[2]!, 'base64url').toString())
        payload.rawBasis.rawHash = 'sha256:' + '0'.repeat(64)
        used = `cap.v4.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${parts[3]}`
        check(typeof caps.decodeReadCapabilityToken(used) === 'string', 'Unsigned raw-basis tamper authenticated')
      }
      if (spec.token === 'missing') used = ''
      if (spec.drift !== undefined) fs.writeFileSync(path.join(workspace, 'target.txt'), spec.drift)
      checkpointEvents.push({ token, decoded, usedToken: used, runId,
        tokenAuthentication: spec.child ? 'diagnostic-child-payload; requires actual child edit verification' : 'authenticated-parent-process',
        driftHash: spec.drift === undefined ? null : hash(spec.drift) })
      return [{ type: 'json', value: { token: used } }]
    },
  })
  const client = new OpenbuffClient({ cwd: workspace, fsSource: source, projectFiles: {}, projectContextMode: 'paths',
    harnessStateDir: path.join(directory, 'harness'), customToolDefinitions: [checkpoint],
    onFilesystemMutation: (event) => { observers.push(event) }, handleEvent: (event) => { events.push(event) },
    inheritEnv: false, runTimeoutMs: 30000 })
  let result: unknown
  try {
    const leaf = { id: 'b05-byte-leaf', displayName: 'Byte fixture leaf', model: 'openai/gpt-4.1',
      toolNames: ['read_files', 'replace_range', 'str_replace', 'edit_transaction', 'b05_fixture_checkpoint', 'set_output'],
      outputMode: 'structured_output' as const, handleSteps: generator(spec) }
    const agentDefinitions: any[] = spec.child ? [leaf, { id: 'b05-byte-parent', displayName: 'Byte fixture parent', model: 'openai/gpt-4.1',
      toolNames: ['spawn_agents', 'set_output'], spawnableAgents: ['b05-byte-leaf'], outputMode: 'structured_output',
      handleSteps: "function* () { const child = yield {toolName:'spawn_agents',input:{agents:[{agent_type:'b05-byte-leaf',prompt:'Fixed byte child control'}]}}; yield {toolName:'set_output',input:{child:child.toolResult,done:true}} }" }] : [leaf]
    result = await client.run({ agent: spec.child ? 'b05-byte-parent' : leaf.id, prompt: 'Fixed source SDK byte/mode/receipt fixture', agentDefinitions, inheritEnv: false })
  } catch (error) { errors.push('SDK threw: ' + String(error)) }
  const after = snapshot(directory, workspace, 'after')
  const expectedBytes = spec.expected === null ? null : Buffer.from(spec.expected)
  const actualFile = path.join(workspace, 'target.txt')
  check(expectedBytes === null ? !fs.existsSync(actualFile) : fs.existsSync(actualFile) && fs.readFileSync(actualFile).equals(expectedBytes), 'Final target bytes differ from independent expected bytes')
  if (expectedBytes !== null) check(fs.existsSync(actualFile) && (fs.statSync(actualFile).mode & 0o777) === 0o751, 'Target permission mode changed')
  if (spec.operation === 'move') {
    const moved = path.join(workspace, 'moved.txt')
    check(fs.existsSync(moved) && fs.readFileSync(moved).equals(Buffer.from(spec.before)), 'Moved exact bytes differ')
    check(fs.existsSync(moved) && (fs.statSync(moved).mode & 0o777) === 0o751, 'Moved permission mode changed')
  }
  const second = fs.readFileSync(path.join(workspace, 'second.txt'))
  check(second.equals(Buffer.from(spec.operation === 'partial_rollback' ? 'partial\r\n' : 'second-before\r\n')), 'Second-file rollback bytes differ')
  check((fs.statSync(path.join(workspace, 'second.txt')).mode & 0o777) === 0o640, 'Second-file mode changed')
  const mutationValues = events.filter(e => e.type === 'tool_result' && ['replace_range', 'str_replace', 'edit_transaction'].includes(e.toolName))
    .flatMap(e => (e.output ?? []).filter((p: any) => p.type === 'json').map((p: any) => p.value))
  const mutations = mutationValues.map(value => fileMutationResultV1Schema.safeParse(value)).filter(parsed => parsed.success).map(parsed => parsed.data!)
  const confirmed = mutations.flatMap(getConfirmedAppliedActionsV1)
  const validationRefusals = events.filter(e => e.type === 'error' && e.invalidArgumentsValidation === true)
  check(checkpointEvents.length === 1, 'Agent did not consume exactly one actual read checkpoint')
  for (const mutation of mutations) {
    const finalHashes = mutation.authorityReceipt?.finalHashes
    if (finalHashes) {
      for (const [name, digest] of Object.entries(finalHashes)) {
        const file = path.join(workspace, name)
        check(digest === (fs.existsSync(file) ? hash(fs.readFileSync(file)) : null), 'Receipt final hash differs from actual final bytes: ' + name)
      }
    }
  }
  check(spec.operation === 'read_only' || mutationValues.length > 0 || (spec.refused && validationRefusals.length > 0), 'Missing actual SDK mutation result or validation refusal')
  if (spec.operation === 'read_only') {
    check(mutationValues.length === 0 && confirmed.length === 0 && observers.length === 0, 'Read-only consumer produced a mutation')
    const readValues = events.filter(e => e.type === 'tool_result' && e.toolName === 'read_files')
      .flatMap(e => (e.output ?? []).filter((p: any) => p.type === 'json').map((p: any) => p.value))
    check(readValues.length === 1, 'Read-only consumer lacks its actual read result')
    if (spec.noReadAuthority) check(readValues.some(v => v?.results?.some((item: any) => item.complete === false || item.status === 'error')),
      'Oversized selected line was not disclosed as partial/unsupported')
    if (spec.growBeforeBoundedRead) check(grewBeforeRead, 'Actual growth between SDK stat and bounded descriptor read was not reached')
  } else if (spec.refused) {
    check(confirmed.length === 0 && observers.length === 0, 'Refused read/edit manufactured confirmed mutation or observer')
    check(validationRefusals.length > 0 || mutationValues.some(v => v?.error || v?.errorMessage) ||
      mutations.some(m => m.outcome !== 'applied'), 'Refusal lacks a real diagnostic result')
  } else if (spec.operation.includes('rollback')) {
    check(adapterEvents.some((e: any) => e.threw), 'Forced later commit failure was not reached')
    check(mutations.length > 0 && mutations.some(m => m.authorityReceipt), 'Rollback lacks actual authority receipt')
    check(mutations.some(m => m.outcome !== 'applied'), 'Rollback/failure reported full success')
  } else {
    check(confirmed.length === 1 && observers.length === 1, 'Successful mutation lacks one confirmed action and observer')
    check(mutations.some(m => m.authorityReceipt), 'Successful mutation lacks actual authority receipt')
    const finalHash = spec.operation === 'move' ? hash(spec.before) : expectedBytes === null ? null : hash(expectedBytes)
    check(confirmed.some(a => a.beforeHash === hash(spec.drift ?? spec.before) && a.afterHash === finalHash), 'Mutation receipt hashes differ from independent exact bytes')
    if (expectedBytes !== null) {
      const fresh = tokens(mutationValues).map(t => observedToken(t, Boolean(spec.child))).filter(d => typeof d !== 'string' && d.rawBasis?.documentRawHash === hash(expectedBytes))
      check(fresh.length > 0, 'Confirmed after-state has no fresh authenticated raw capability')
      const actualRunId = (checkpointEvents[0] as { runId?: string } | undefined)?.runId ?? ''
      const expectedFingerprint = createHash('sha256').update(workspace + '\0target.txt\0' + actualRunId).digest('base64url')
      const expectedObservation = spec.expected!.replace(/^\uFEFF/, '').replaceAll('\r\n', '\n')
      const expectedEndLine = expectedObservation.split('\n').length
      const expectedObservationHash = hash(expectedObservation)
      const scopedFresh = fresh.filter(d => d.tokenVersion === 'v4' && d.scopeFingerprint === expectedFingerprint &&
        d.startLine === 1 && d.endLine === expectedEndLine && d.hash === expectedObservationHash &&
        d.rawBasis?.scope === 'whole' && d.rawBasis.rawHash === hash(expectedBytes) &&
        d.rawBasis.documentBytes === expectedBytes.byteLength && d.rawBasis.startByte === 0 &&
        d.rawBasis.endByteExclusive === expectedBytes.byteLength)
      check(scopedFresh.length > 0, 'Immediate after-state capability has wrong receiving scope, normalized bounds, hash or raw byte coverage')
      afterCapabilityObservations.push({ actualRunId, path: 'target.txt', expectedFingerprint,
        expectedStartLine: 1, expectedEndLine, expectedObservationHash, expectedRawHash: hash(expectedBytes),
        expectedRawBytes: expectedBytes.byteLength, matchingFacts: scopedFresh,
        authentication: spec.child ? 'diagnostic-child-payload; parent key must reject; original read authenticated by actual child edit' : 'authenticated-parent-process' })
    }
  }
  const brokerReceipts = await broker.listReceipts()
  write(path.join(directory, 'sdk-raw.json'), { result, events, observers, checkpointEvents, afterCapabilityObservations, observedReadBases, adapterEvents, mutations, brokerReceipts })
  const report = { name: spec.name, passed: errors.length === 0, errors, read: spec.read, operation: spec.operation,
    expectedRawHash: spec.expected === null ? null : hash(spec.expected), before, after, confirmedActions: confirmed.length,
    rawEvidence: path.join(directory, 'sdk-raw.json'), childScopeControl: Boolean(spec.child) }
  write(path.join(directory, 'assessment.json'), report)
  reports.push(report)
  console.log(JSON.stringify({ case: spec.name, passed: report.passed, errors }))
}

const codecControls: unknown[] = []
for (const [name, input, offset, expectedHex] of [
  ['bom-astral-boundary', '\uFEFFa😀b\r\n', 1, Buffer.from('\uFEFFaX😀b\r\n').toString('hex')],
  ['lone-cr-boundary', 'a\rb\n', 1, Buffer.from('aX\rb\n').toString('hex')],
] as const) {
  const captured = codec.captureTextDocument(Buffer.from(input), { view: 'adapter_bytes', coherence: 'observed' })
  const actual = codec.spliceDocumentObservation(captured, offset, offset, 'X')
  codecControls.push({ name, passed: Buffer.from(actual).toString('hex') === expectedHex, expectedHex, actualHex: Buffer.from(actual).toString('hex') })
}
for (const [name, action] of [
  ['invalid-utf8', () => codec.captureTextDocument(Uint8Array.from([0xc0, 0x80]))],
  ['unpaired-surrogate', () => codec.captureTextDocument('\ud800')],
  ['split-astral', () => codec.spliceDocumentObservation(codec.captureTextDocument('\uFEFFa😀b'), 2, 2, 'X')],
] as const) {
  let error: string | null = null
  try { action() } catch (caught) { error = String(caught) }
  codecControls.push({ name, passed: error !== null, error })
}
const passed = reports.every((r: any) => r.passed) && codecControls.every((r: any) => r.passed) && fetchObservations.attempted === 0
write(path.join(out, 'observations.json'), { schemaVersion: 1, passed, stage: 'development-consumer-observations',
  reports, codecControls, selectedCases: selectedCases.map(spec => spec.name), totalDeclaredCases: cases.length,
  fullRosterExecuted: selectedCases.length === cases.length, fetch: fetchObservations, independentApproval: false,
  limits: 'Actual source SDK byte/mode/receipt controls; this fixture does not countersign acceptance or establish installed/native or OS network enforcement.' })
console.log(JSON.stringify({ passed, cases: reports.length, codecControls: codecControls.length, fetch: fetchObservations, independentApproval: false }))
if (!passed) process.exitCode = 1

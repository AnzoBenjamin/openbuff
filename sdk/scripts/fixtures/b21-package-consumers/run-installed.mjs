#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../../../..')
const OWNED = path.join(ROOT, 'docs/execution/body-roadmap/evidence/B21/packed-native-consumers-20261112-r1')
const NODE = '/home/ben/.local/share/mise/installs/node/26/bin/node'
const BUN = '/home/ben/.bun/bin/bun'
const NPM = '/home/ben/.local/share/mise/installs/node/26/lib/node_modules/npm/bin/npm-cli.js'
const HELPERS = ['run-installed.mjs', 'consumer.cjs', 'consumer-cjs.cjs', 'consumer-esm.mjs', 'reject-workspace-loader.mjs', 'README.md']
const EXPECTED_SCENARIOS = ['sync-env-files-json-exit7', 'background-exit7-check-job', 'direct-target-signal11']
const sha = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const json = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' })
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'))
const rootPath = file => path.resolve(ROOT, file)
const reference = file => ({ path: path.relative(ROOT, file), sha256: sha(file) })
const same = (a, b) => assert.deepEqual(a, b)

function checkedReference(file, digest) {
  const absolute = rootPath(file)
  assert.ok(absolute.startsWith(ROOT + path.sep) && fs.statSync(absolute).isFile(), 'Expected a repository file reference')
  assert.match(digest, /^[a-f0-9]{64}$/)
  assert.equal(sha(absolute), digest, 'Reference drift: ' + file)
  return { path: path.relative(ROOT, absolute), sha256: digest }
}

function inventory(directory) {
  const result = {}
  function visit(folder) {
    for (const item of fs.readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(folder, item.name)
      if (item.isDirectory()) visit(file)
      else {
        assert.ok(item.isFile(), 'Unexpected link or special file in guarded inventory: ' + file)
        result[path.relative(directory, file)] = sha(file)
      }
    }
  }
  visit(directory)
  return result
}

function liveInputs(names) {
  return Object.fromEntries([...new Set(names)].sort().map(file => [file, sha(rootPath(file))]))
}

// Dependencies are copied from the locked local installation. Every resulting
// link stays inside scratch; no checkout node_modules directory is linked.
function copyDependencies(packageRoot, destination) {
  const store = path.join(destination, 'dependency-store')
  fs.mkdirSync(store)
  const copied = new Map(), records = [], unavailableOptional = []
  function locate(name, from) {
    for (let folder = from; ; folder = path.dirname(folder)) {
      const candidate = path.join(folder, 'node_modules', name)
      if (fs.existsSync(path.join(candidate, 'package.json'))) return fs.realpathSync(candidate)
      if (path.dirname(folder) === folder) return undefined
    }
  }
  function link(name, target, owner) {
    const file = path.join(owner, 'node_modules', name)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    if (!fs.existsSync(file)) fs.symlinkSync(path.relative(path.dirname(file), target), file, 'dir')
    else assert.equal(fs.realpathSync(file), target)
  }
  function copy(actual) {
    if (copied.has(actual)) return copied.get(actual)
    const manifest = read(path.join(actual, 'package.json'))
    assert.ok(!/^@(codebuff|openbuff)\//.test(manifest.name), 'Workspace dependency is forbidden')
    const target = path.join(store, String(records.length).padStart(4, '0'))
    copied.set(actual, target)
    const record = { name: manifest.name, version: manifest.version, sourceDirectory: actual,
      installedDirectory: target, manifestSha256: sha(path.join(actual, 'package.json')), edges: [] }
    records.push(record)
    fs.cpSync(actual, target, { recursive: true, dereference: true,
      filter: file => path.basename(file) !== 'node_modules' && path.basename(file) !== '.git' })
    const files = inventory(target)
    record.fileCount = Object.keys(files).length
    record.fileInventorySha256 = createHash('sha256').update(JSON.stringify(files)).digest('hex')
    record.files = files
    const required = manifest.dependencies ?? {}, optional = manifest.optionalDependencies ?? {}
    const peers = manifest.peerDependencies ?? {}
    for (const [name, declared] of Object.entries({ ...peers, ...required, ...optional })) {
      const actualChild = locate(name, actual)
      const mayBeMissing = name in optional || (!(name in required) && manifest.peerDependenciesMeta?.[name]?.optional === true)
      if (!actualChild) {
        assert.ok(mayBeMissing, 'Installed required dependency unavailable: ' + manifest.name + ' -> ' + name)
        unavailableOptional.push({ owner: manifest.name, name, declared })
        continue
      }
      const child = copy(actualChild)
      link(name, child, target)
      record.edges.push({ name, declared, installedDirectory: child })
    }
    return target
  }
  const manifest = read(path.join(packageRoot, 'package.json')), direct = []
  for (const [name, declared] of Object.entries(manifest.dependencies)) {
    const actual = locate(name, path.join(ROOT, 'sdk'))
    assert.ok(actual, 'Declared dependency is unavailable offline: ' + name)
    const installed = read(path.join(actual, 'package.json'))
    assert.equal(installed.name, name)
    if (/^\d/.test(declared)) assert.equal(installed.version, declared)
    const target = copy(actual)
    link(name, target, destination)
    direct.push({ name, declared, version: installed.version, sourceDirectory: actual, installedDirectory: target })
  }
  return { direct, packages: records, unavailableOptional,
    policy: 'Manifest-declared existing third-party dependency graph copied offline; all dependency links contained in isolated host' }
}

const options = new Map()
let approved = false
for (let index = 2; index < process.argv.length; index++) {
  const key = process.argv[index]
  if (key === '--i2-approved' && !approved) { approved = true; continue }
  assert.ok(['--manifest', '--manifest-sha256', '--native-binary', '--sdk-build', '--sdk-build-sha256',
    '--i2-review', '--i2-review-sha256', '--evidence-dir'].includes(key) && !options.has(key), 'Unexpected/repeated argument: ' + key)
  const value = process.argv[++index]
  assert.ok(value && !value.startsWith('--'), 'Missing value: ' + key)
  options.set(key, value)
}
assert.ok(approved && options.size === 8, 'Require exact candidate/build/review references and explicit root I2 admission')
assert.equal(process.version, 'v26.1.0')
assert.equal(fs.realpathSync(process.execPath), fs.realpathSync(NODE))
const out = rootPath(options.get('--evidence-dir'))
assert.ok(out.startsWith(OWNED + path.sep), 'Use a new attempt beneath the owned packed-native evidence directory')
fs.mkdirSync(out, { recursive: false })
const result = { schemaVersion: 1, card: 'B21', type: 'packed-node-installed-native-consumers',
  status: 'preparing', startedAtUtc: new Date().toISOString(), argv: process.argv,
  commands: [], B21Accepted: false, accepted: false,
  scope: 'Actual packed Node CJS+ESM config-only SDK native consumption; whole card remains unaccepted' }
let scratch, sourceBefore, distBefore, candidateBefore, installedBefore, helperBefore, dependencyBefore, installedPackagePath
const guardNames = new Set()
function save() {
  fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(result, null, 2) + '\n')
}
save()

async function command(name, argv, cwd, environment, timeoutMs = 120000) {
  const stdoutFile = path.join(out, name + '.stdout.log'), stderrFile = path.join(out, name + '.stderr.log')
  const stdout = fs.openSync(stdoutFile, 'wx'), stderr = fs.openSync(stderrFile, 'wx')
  const record = { name, argv, cwd, environment, startedAtUtc: new Date().toISOString(), timeoutMs }
  result.commands.push(record); save()
  try {
    const child = spawn(argv[0], argv.slice(1), { cwd, env: environment, stdio: ['ignore', stdout, stderr], detached: true })
    record.pid = child.pid
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        record.timedOut = true
        try { process.kill(-child.pid, 'SIGKILL') } catch {}
      }, timeoutMs)
      child.once('error', error => { clearTimeout(timer); reject(error) })
      child.once('close', (code, signal) => {
        clearTimeout(timer); record.exitCode = code; record.signal = signal
        record.timedOut ??= false; resolve()
      })
    })
  } finally {
    fs.closeSync(stdout); fs.closeSync(stderr)
    record.finishedAtUtc = new Date().toISOString()
    record.stdout = reference(stdoutFile); record.stderr = reference(stderrFile)
    json(path.join(out, name + '.command.json'), record); save()
  }
  return record
}

function bindSdkBuild() {
  const buildRef = checkedReference(options.get('--sdk-build'), options.get('--sdk-build-sha256'))
  const build = read(rootPath(buildRef.path))
  assert.equal(build.type, 'guarded-sdk-artifact-build')
  assert.equal(build.passed, true); assert.equal(build.sourceStable, true)
  assert.equal(build.exitCode, 0); assert.equal(build.timedOut, false)
  same(build.argv, [BUN, '--no-env-file', 'run', 'scripts/build.ts'])
  const beforeRef = checkedReference(build.sourceBefore.path, build.sourceBefore.sha256)
  const afterRef = checkedReference(build.sourceAfter.path, build.sourceAfter.sha256)
  const before = read(rootPath(beforeRef.path)), after = read(rootPath(afterRef.path))
  same(before, after)
  same(liveInputs(Object.keys(before)), before)
  Object.keys(before).forEach(file => guardNames.add(file))
  same(liveInputs(Object.keys(build.artifacts)), build.artifacts)
  for (const [file, digest] of Object.entries(build.toolPins)) assert.equal(sha(file), digest)
  same(build.toolPins, build.toolsAfter)
  const folder = path.dirname(rootPath(buildRef.path))
  assert.equal(sha(path.join(folder, 'build.stdout')), build.stdoutSha256)
  assert.equal(sha(path.join(folder, 'build.stderr')), build.stderrSha256)
  assert.equal(sha(path.join(folder, 'build.py')), build.driverSha256)
  result.sdkBuild = { reference: buildRef, sourceBefore: beforeRef, sourceAfter: afterRef,
    sourceCount: Object.keys(before).length, artifacts: build.artifacts }
  return build
}

function bindCandidate() {
  const manifestRef = checkedReference(options.get('--manifest'), options.get('--manifest-sha256'))
  const reviewRef = checkedReference(options.get('--i2-review'), options.get('--i2-review-sha256'))
  const manifest = read(rootPath(manifestRef.path))
  assert.equal(manifest.type, 'body-bootstrap-selection'); assert.equal(manifest.schemaVersion, 1)
  const artifact = manifest.artifacts.find(item => item.id === 'native-checkout')
  assert.ok(artifact?.sha256 && artifact.buildReceipt)
  assert.equal(rootPath(artifact.path), rootPath(options.get('--native-binary')))
  assert.equal(sha(rootPath(artifact.path)), artifact.sha256)
  const buildRef = checkedReference(artifact.buildReceipt.path, artifact.buildReceipt.sha256)
  const build = read(rootPath(buildRef.path))
  assert.equal(build.type, 'body-bootstrap-artifact-build'); assert.equal(build.schemaVersion, 1)
  assert.equal(build.exitCode, 0)
  assert.equal(build.artifact.sha256, artifact.sha256)
  assert.equal(rootPath(build.artifact.path), rootPath(artifact.path))
  for (const source of manifest.inputs.sources) {
    checkedReference(source.path, source.sha256)
    assert.equal(build.sourceContractHashes[source.path], source.sha256)
    guardNames.add(source.path)
  }
  for (const source of [...manifest.inputs.packages, ...manifest.inputs.locks, ...manifest.inputs.configuration]) {
    checkedReference(source.path, source.sha256)
    assert.equal(build.contextContractHashes[source.path], source.sha256)
    guardNames.add(source.path)
  }
  const bwrap = '/usr/bin/bwrap'
  for (const [id, file, expectedVersion] of [['node', NODE, '26.1.0'], ['bun', BUN, '1.4.4'], ['bwrap', bwrap, '0.13.1']]) {
    const selected = manifest.tools[id]
    assert.equal(selected.expectedVersion, expectedVersion)
    assert.equal(sha(file), selected.expectedSha256ByHost['linux-x64'])
  }
  candidateBefore = { manifest: manifestRef, build: buildRef, review: reviewRef,
    native: { path: artifact.path, sha256: artifact.sha256 }, bwrap: { path: bwrap, sha256: sha(bwrap) } }
  result.candidate = candidateBefore
  result.i2Admission = { callerExplicitlyApproved: approved, review: reviewRef,
    interpretation: 'Root coordinator supplies admission after independent I2 review; this consumer does not adjudicate the review' }
  return { artifact, bwrap: candidateBefore.bwrap }
}

try {
  const build = bindSdkBuild(), native = bindCandidate()
  helperBefore = liveInputs(HELPERS.map(file => path.relative(ROOT, path.join(HERE, file))))
  Object.keys(helperBefore).forEach(file => guardNames.add(file))
  sourceBefore = liveInputs(guardNames)
  distBefore = inventory(path.join(ROOT, 'sdk/dist'))
  same(Object.fromEntries(Object.entries(build.artifacts).map(([file, digest]) => [file.slice('sdk/dist/'.length), digest])), distBefore)
  json(path.join(out, 'source-before.json'), sourceBefore)
  json(path.join(out, 'dist-before.json'), distBefore)
  json(path.join(out, 'candidate-before.json'), candidateBefore)
  json(path.join(out, 'helpers-before.json'), helperBefore)
  for (const file of HELPERS) fs.copyFileSync(path.join(HERE, file), path.join(out, file + '.source.txt'), fs.constants.COPYFILE_EXCL)
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'openbuff-b21-packed-native-'))
  result.isolatedHost = scratch
  const env = { PATH: path.dirname(NODE) + ':/usr/bin:/bin', HOME: path.join(scratch, 'home'),
    LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TZ: 'UTC', NODE_ENV: 'test', OPENBUFF_TELEMETRY: '0',
    DO_NOT_TRACK: '1', OPENBUFF_PROCESS_SUPERVISION: '0', B21_WORKSPACE_ROOT: ROOT }
  fs.mkdirSync(env.HOME)
  const nodeVersion = await command('node-version', [NODE, '--version'], scratch, env)
  const bunVersion = await command('bun-version', [BUN, '--version'], scratch, env)
  assert.equal(nodeVersion.exitCode, 0); assert.equal(bunVersion.exitCode, 0)
  assert.equal(fs.readFileSync(rootPath(nodeVersion.stdout.path), 'utf8').trim(), 'v26.1.0')
  assert.equal(fs.readFileSync(rootPath(bunVersion.stdout.path), 'utf8').trim(), '1.4.4')
  result.runtime = { node: { path: NODE, version: '26.1.0', sha256: sha(NODE) },
    bun: { path: BUN, version: '1.4.4', sha256: sha(BUN) } }
  assert.equal(read(path.join(path.dirname(NPM), '../package.json')).version, '11.13.0')
  const packEnv = { ...env, npm_config_offline: 'true', npm_config_ignore_scripts: 'true',
    npm_config_update_notifier: 'false', npm_config_cache: path.join(scratch, 'npm-cache') }
  const pack = await command('pack', [NODE, NPM, 'pack', '.', '--ignore-scripts', '--offline', '--json', '--pack-destination', out], path.join(ROOT, 'sdk'), packEnv)
  assert.equal(pack.exitCode, 0); assert.equal(pack.timedOut, false)
  const tarballs = fs.readdirSync(out).filter(file => file.endsWith('.tgz'))
  assert.equal(tarballs.length, 1)
  const tarball = path.join(out, tarballs[0])
  result.tarball = reference(tarball)
  const list = await command('tar-list', ['/usr/bin/tar', '--list', '--verbose', '--gzip', '--file', tarball], scratch, env)
  assert.equal(list.exitCode, 0)
  for (const line of fs.readFileSync(rootPath(list.stdout.path), 'utf8').trim().split('\n')) {
    assert.ok(/^[d-]/.test(line), 'Unexpected tarball link/special file')
    const name = line.split(/\s+/).slice(5).join(' ')
    assert.ok(name.startsWith('package/') && !name.split('/').includes('..'), 'Unsafe tarball member: ' + name)
  }
  const installedPackage = path.join(scratch, 'node_modules/@openbuff/sdk')
  installedPackagePath = installedPackage
  fs.mkdirSync(installedPackage, { recursive: true })
  const extract = await command('tar-extract', ['/usr/bin/tar', '--extract', '--gzip', '--file', tarball,
    '--directory', installedPackage, '--strip-components=1', '--no-same-owner'], scratch, env)
  assert.equal(extract.exitCode, 0)
  same(inventory(path.join(installedPackage, 'dist')), distBefore)
  assert.equal(read(path.join(installedPackage, 'package.json')).name, '@openbuff/sdk')
  const dependencies = copyDependencies(installedPackage, scratch)
  json(path.join(out, 'dependencies.json'), dependencies)
  dependencyBefore = createHash('sha256').update(JSON.stringify(dependencies)).digest('hex')
  result.dependencies = { manifest: reference(path.join(out, 'dependencies.json')), packages: dependencies.packages.length,
    directCount: dependencies.direct.length, boundary: dependencies.policy }
  const installationDir = path.join(scratch, 'installation')
  fs.mkdirSync(installationDir)
  const installedPath = path.join(installationDir, 'openbuff-native')
  fs.copyFileSync(rootPath(native.artifact.path), installedPath, fs.constants.COPYFILE_EXCL)
  fs.chmodSync(installedPath, 0o700)
  installedBefore = { path: installedPath, sha256: sha(installedPath), mode: fs.statSync(installedPath).mode & 0o777 }
  assert.equal(installedBefore.sha256, native.artifact.sha256)
  result.installedNative = installedBefore
  json(path.join(out, 'installed-native-before.json'), installedBefore)
  for (const file of HELPERS.filter(file => file !== 'run-installed.mjs' && file !== 'README.md'))
    fs.copyFileSync(path.join(HERE, file), path.join(scratch, file), fs.constants.COPYFILE_EXCL)
  json(path.join(scratch, 'package.json'), { name: 'b21-packed-native-consumer', private: true, type: 'module' })
  const specification = path.join(scratch, 'specification.json')
  json(specification, { workspace: ROOT, installedPackage, native: { installedPath, sha256: native.artifact.sha256 },
    bwrap: native.bwrap, artifacts: build.artifacts })
  result.status = 'executing'; save()
  for (const format of ['cjs', 'esm'])
    await command(format, [NODE, '--experimental-loader', './reject-workspace-loader.mjs',
      './consumer-' + format + (format === 'cjs' ? '.cjs' : '.mjs'), path.join(out, format + '.result.json'), specification], scratch, env, 90000)
  result.consumers = Object.fromEntries(['cjs', 'esm'].map(format => {
    const file = path.join(out, format + '.result.json'), value = fs.existsSync(file) ? read(file) : { status: 'missing-result' }
    assert.equal(value.format, format, 'Missing or mismatched format completion receipt')
    same(value.scenarios?.map(item => item.name), EXPECTED_SCENARIOS)
    assert.ok(value.scenarios.every(item => item.assertions === 'passed'), 'Incomplete scenario assertions')
    assert.equal(value.input?.native?.sha256, installedBefore.sha256, 'Mismatched installed native descriptor')
    assert.equal(value.input.native.installedPath, installedBefore.path)
    return [format, { status: value.status, fetchCalls: value.fetchCalls, scenarios: value.scenarios?.map(item => ({ name: item.name, assertions: item.assertions })),
      receipt: fs.existsSync(file) ? reference(file) : null }]
  }))
  assert.ok(['cjs', 'esm'].every(format => result.commands.find(item => item.name === format)?.exitCode === 0 &&
    result.consumers[format].status === 'scoped-checks-passed' && result.consumers[format].fetchCalls === 0), 'Packed consumer failed; inspect preserved raw logs/results')
  result.status = 'scoped-checks-passed'
} catch (error) {
  result.status = 'failed'; result.failure = error.stack ?? String(error)
} finally {
  try {
    if (sourceBefore) {
      const sourceAfter = liveInputs(guardNames), distAfter = inventory(path.join(ROOT, 'sdk/dist'))
      json(path.join(out, 'source-after.json'), sourceAfter); json(path.join(out, 'dist-after.json'), distAfter)
      result.sourceStable = JSON.stringify(sourceBefore) === JSON.stringify(sourceAfter)
      result.distStable = JSON.stringify(distBefore) === JSON.stringify(distAfter)
      if (!result.sourceStable || !result.distStable) result.status = 'source-or-artifact-drift'
    }
    if (candidateBefore) {
      const candidateAfter = { manifest: reference(rootPath(candidateBefore.manifest.path)),
        build: reference(rootPath(candidateBefore.build.path)), review: reference(rootPath(candidateBefore.review.path)),
        native: { path: candidateBefore.native.path, sha256: sha(rootPath(candidateBefore.native.path)) },
        bwrap: { path: candidateBefore.bwrap.path, sha256: sha(candidateBefore.bwrap.path) } }
      json(path.join(out, 'candidate-after.json'), candidateAfter)
      result.candidateStable = JSON.stringify(candidateBefore) === JSON.stringify(candidateAfter)
      if (!result.candidateStable) result.status = 'candidate-drift'
    }
    if (installedBefore) {
      const after = { path: installedBefore.path, sha256: sha(installedBefore.path), mode: fs.statSync(installedBefore.path).mode & 0o777 }
      json(path.join(out, 'installed-native-after.json'), after)
      result.installedNativeStable = JSON.stringify(installedBefore) === JSON.stringify(after)
      if (!result.installedNativeStable) result.status = 'installed-native-drift'
    }
    if (installedPackagePath && distBefore) {
      const after = inventory(path.join(installedPackagePath, 'dist'))
      json(path.join(out, 'installed-sdk-dist-after.json'), after)
      result.installedSdkStable = JSON.stringify(distBefore) === JSON.stringify(after)
      if (!result.installedSdkStable) result.status = 'installed-sdk-drift'
    }
    if (result.runtime) {
      const after = { node: { ...result.runtime.node, sha256: sha(NODE) },
        bun: { ...result.runtime.bun, sha256: sha(BUN) } }
      json(path.join(out, 'runtime-after.json'), after)
      result.runtimeStable = JSON.stringify(result.runtime) === JSON.stringify(after)
      if (!result.runtimeStable) result.status = 'runtime-drift'
    }
    if (scratch && dependencyBefore) {
      const dependencies = read(path.join(out, 'dependencies.json'))
      for (const item of dependencies.packages) {
        const files = {}
        for (const name of Object.keys(item.files)) files[name] = sha(path.join(item.installedDirectory, name))
        same(files, item.files)
        for (const edge of item.edges) assert.equal(fs.realpathSync(path.join(item.installedDirectory, 'node_modules', edge.name)), edge.installedDirectory)
      }
      for (const item of dependencies.direct)
        assert.equal(fs.realpathSync(path.join(scratch, 'node_modules', item.name)), item.installedDirectory)
      result.copiedDependenciesStable = true
    }
    if (scratch) {
      for (const format of ['cjs', 'esm']) {
        const workspace = path.join(scratch, format + '-workspace')
        if (fs.existsSync(workspace)) fs.cpSync(workspace, path.join(out, format + '-workspace'), { recursive: true, dereference: false })
      }
      result.isolatedHostTeardown = result.status === 'scoped-checks-passed' ? 'removed-after-consumer-and-guard-oracles' : 'retained-for-failure-reconciliation'
      if (result.status === 'scoped-checks-passed') fs.rmSync(scratch, { recursive: true })
    }
  } catch (error) {
    result.status = 'guard-or-teardown-failed'; result.guardFailure = error.stack ?? String(error)
  }
  result.finishedAtUtc = new Date().toISOString(); save()
}
console.log(JSON.stringify({ status: result.status, evidenceDir: out, failure: result.failure, consumers: result.consumers }))
process.exitCode = result.status === 'scoped-checks-passed' ? 0 : 1

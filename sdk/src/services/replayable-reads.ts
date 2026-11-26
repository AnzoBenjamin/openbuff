import { createHash } from 'node:crypto'
import { closeSync, createReadStream, lstatSync, openSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  beginReadPlanJournal,
  claimReadPlanReplay,
  createRunJournal,
  isReadPlanJournal,
  type CreatedRunJournal,
} from '@codebuff/agent-runtime/util/run-journal'
import {
  READ_PLAN_TEMPLATE_ID,
  verifyReadPlanPrefix,
  type ReadPlanOrigin,
} from '@codebuff/agent-runtime/util/read-plan-replay'
import {
  captureValueSha256,
  snapshotReplayValue,
  type ReplayBasis,
} from '@codebuff/agent-runtime/util/recorded-replay-prefix'
import type { AgentDefinition } from '@codebuff/common/templates/initial-agents-dir/types/agent-definition'
import type { JournalWriter } from '@codebuff/common/types/contracts/agent-runtime'
import type { OpenbuffClientOptions, RunOptions } from '../run'

export type ReplayableReadJournal = CreatedRunJournal &
  Required<Pick<JournalWriter, 'appendDurable'>>
export type ReplayableReadsOptions = {
  batches: readonly (readonly string[])[]
  journal: ReplayableReadJournal
  /** Select the original run after its owning process exits. Omit for a new run. */
  resumeRunId?: string
  signal?: AbortSignal
}

const privateJournals = new WeakSet<ReplayableReadJournal>()

function requirePrivateJournalPath(file: string, uid: number): void {
  const parent = path.dirname(file)
  const ancestors: string[] = []
  for (let directory = parent; ; directory = path.dirname(directory)) {
    ancestors.push(directory)
    if (directory === path.dirname(directory)) break
  }
  // The private directory must not be replaceable by a different user via an
  // ancestor. Root-owned sticky directories such as /tmp are allowed.
  for (const directory of ancestors.reverse()) {
    const info = lstatSync(directory, { throwIfNoEntry: false })
    if (directory === parent) {
      if (
        !info?.isDirectory() ||
        info.uid !== uid ||
        (info.mode & 0o077) !== 0
      ) {
        throw new Error(
          'Read replay requires an existing owner-only private directory for its journal.',
        )
      }
    } else if (
      !info?.isDirectory() ||
      (info.uid !== uid && info.uid !== 0) ||
      ((info.mode & 0o022) !== 0 && (info.mode & 0o1000) === 0)
    ) {
      throw new Error(
        'Read replay requires trusted ancestors for its journal directory.',
      )
    }
  }

  const checkFile = (name: string, optional: boolean) => {
    const info = lstatSync(name, { throwIfNoEntry: false })
    if (!info && optional) return
    if (
      !info?.isFile() ||
      info.uid !== uid ||
      info.nlink !== 1 ||
      (info.mode & 0o077) !== 0
    ) {
      throw new Error(
        'Read replay requires regular, owner-only files for its database and SQLite sidecars.',
      )
    }
  }
  for (const suffix of ['-journal', '-wal', '-shm'])
    checkFile(file + suffix, true)
  try {
    // Do not rely on the host umask or make a public DB private after SQLite
    // has already opened it. Concurrent openers validate the existing file.
    closeSync(openSync(file, 'wx', 0o600))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  checkFile(file, false)
}

/** The journal can retain file contents; use a host-controlled 0700 directory. */
export function openReplayableReadJournal(file: string): ReplayableReadJournal {
  const uid = process.geteuid?.()
  if (
    process.platform !== 'linux' ||
    !process.versions.bun ||
    uid === undefined ||
    !path.isAbsolute(file)
  ) {
    throw new Error(
      'Replayable reads require Linux/Bun and an absolute persistent journal path.',
    )
  }
  const resolved = path.resolve(file)
  requirePrivateJournalPath(resolved, uid)
  const journal = createRunJournal({ path: resolved }) as ReplayableReadJournal
  privateJournals.add(journal)
  return journal
}

export type ReadPlanExecution = {
  original?: ReadPlanOrigin
  completedBatches: number
  verifyRoot(): Promise<void>
  begin(runId: string, agentId: string, userInputId: string): Promise<void>
}

const prepared = new WeakMap<AgentDefinition, ReadPlanExecution>()
export function takeReadPlanExecution(
  agent: RunOptions['agent'],
): ReadPlanExecution | undefined {
  if (typeof agent === 'string') return undefined
  const value = prepared.get(agent)
  prepared.delete(agent)
  return value
}

// The serialized adapter has no external dependencies or live state inputs
// that determine its next yield. Only the literal plan chooses future reads.
// Keep known results as data; never call a tool for a retained batch.
const recipe: NonNullable<AgentDefinition['handleSteps']> = function* ({
  agentState,
  params,
}) {
  const reads = [...(params!.retainedReads as unknown[])]
  for (const paths of params!.remaining as string[][]) {
    const result = yield { toolName: 'read_files', input: { paths } }
    reads.push(result.toolResult)
  }
  agentState.output = { reads }
}

const safeClientOptions = new Set([
  'cwd',
  'apiKey',
  'fingerprintId',
  'logger',
  'handleEvent',
  'handleStreamChunk',
])
const isPath = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 512 &&
  !/[\\:\x00-\x1f\x7f]/.test(value) &&
  value.split('/').every((part) => part !== '' && part !== '.' && part !== '..')

async function fileSha256(file: string | URL): Promise<string> {
  const hash = createHash('sha256')
  for await (const bytes of createReadStream(file)) hash.update(bytes)
  return hash.digest('hex')
}

async function rootIdentity(root: string) {
  const stats = await fs.stat(root, { bigint: true })
  if (!stats.isDirectory())
    throw new Error('Read replay requires a project directory.')
  return { root, dev: stats.dev.toString(), ino: stats.ino.toString() }
}

export async function prepareReplayableReads(
  client: OpenbuffClientOptions,
  request: ReplayableReadsOptions,
): Promise<RunOptions & OpenbuffClientOptions> {
  if (
    process.platform !== 'linux' ||
    !process.versions.bun ||
    !client.cwd ||
    Object.entries(client).some(
      ([key, value]) => value !== undefined && !safeClientOptions.has(key),
    )
  ) {
    throw new Error(
      'Replayable reads require an explicit local Linux/Bun project and default SDK execution options.',
    )
  }
  const { journal, resumeRunId, signal } = request
  if (
    !journal ||
    !privateJournals.has(journal) ||
    !isReadPlanJournal(journal) ||
    (resumeRunId !== undefined &&
      !/^local-run-[0-9a-f-]{36}$/.test(resumeRunId))
  ) {
    throw new Error(
      'Use openReplayableReadJournal and supply a valid original run ID when resuming.',
    )
  }
  signal?.throwIfAborted()
  const snapshot = snapshotReplayValue(request.batches, 64 * 1024).value
  if (
    !Array.isArray(snapshot) ||
    snapshot.length < 1 ||
    snapshot.length > 8 ||
    snapshot.some(
      (batch) =>
        !Array.isArray(batch) ||
        batch.length < 1 ||
        batch.length > 16 ||
        !batch.every(isPath) ||
        new Set(batch).size !== batch.length,
    )
  ) {
    throw new Error(
      'Read plans need 1–8 batches of 1–16 unique, literal project-relative file paths.',
    )
  }
  const batches = snapshot as string[][]
  const root = await fs.realpath(client.cwd)
  const identity = await rootIdentity(root)
  const configurationSha256 = captureValueSha256({
    ...identity,
    pidNamespace: await fs.readlink('/proc/self/ns/pid'),
    bootId: (
      await fs.readFile('/proc/sys/kernel/random/boot_id', 'utf8')
    ).trim(),
    policy: 'sdk-strict-project-read-v1',
  })
  const basis = {
    bundleSha256: captureValueSha256({ recipe: recipe.toString(), batches }),
    runtimeSha256: captureValueSha256({
      executable: await fileSha256('/proc/self/exe'),
      sdkArtifact: await fileSha256(
        typeof __filename === 'string' ? __filename : new URL(import.meta.url),
      ),
      bun: process.versions.bun,
    }),
    contractSha256: captureValueSha256({
      lane: READ_PLAN_TEMPLATE_ID,
      verify: verifyReadPlanPrefix.toString(),
    }),
    configurationSha256,
    inputSha256: captureValueSha256(batches),
  }
  signal?.throwIfAborted()
  const resumed = resumeRunId
    ? claimReadPlanReplay(journal, { ...basis, runId: resumeRunId }, batches)
    : undefined
  const agent: AgentDefinition = {
    id: READ_PLAN_TEMPLATE_ID,
    displayName: 'Replayable project reads',
    // The recipe never yields a model step; the template still needs a name.
    model: 'replayable-read-plan-unused',
    toolNames: ['read_files'],
    spawnableAgents: [],
    programmaticConfig: { strictProjectReads: true },
    outputMode: 'structured_output',
    handleSteps: recipe,
  }
  Object.freeze(agent.toolNames)
  Object.freeze(agent.spawnableAgents)
  Object.freeze(agent.programmaticConfig)
  Object.freeze(agent)
  prepared.set(agent, {
    original: resumed?.origin,
    completedBatches: resumed?.results.length ?? 0,
    async verifyRoot() {
      if (
        captureValueSha256(await rootIdentity(root)) !==
        captureValueSha256(identity)
      ) {
        throw new Error('Read-plan project identity changed before dispatch.')
      }
    },
    async begin(runId, agentId, userInputId) {
      if (resumed)
        throw new Error(
          'A resumed read plan cannot replace its journal origin.',
        )
      await beginReadPlanJournal(journal, {
        version: 1,
        basis: { ...basis, runId },
        ownerPid: process.pid,
        agentId,
        userInputId,
      })
    },
  })
  return {
    agent,
    prompt: 'Execute the immutable project read plan.',
    params: {
      retainedReads: resumed?.results ?? [],
      remaining: batches.slice(resumed?.results.length ?? 0),
    },
    signal,
    cwd: root,
    projectFiles: {},
    knowledgeFiles: {},
    userKnowledgeFiles: {},
    repositoryIntelligence: false,
    journalReader: journal,
    journalWriter: journal,
    inheritEnv: false,
    hostConfiguration: {
      environment: {
        PATH: '/usr/bin:/bin',
        OPENBUFF_PROCESS_SUPERVISION: '0',
        OPENBUFF_TELEMETRY: '0',
        DO_NOT_TRACK: '1',
      },
      platform: 'linux',
      invocationCwd: root,
      projectRoot: root,
      home: { kind: 'none' },
      globals: { kind: 'disabled' },
      selection: { kind: 'none' },
      trust: { ancestorConfig: false, projectReadableRoots: false },
    },
  }
}

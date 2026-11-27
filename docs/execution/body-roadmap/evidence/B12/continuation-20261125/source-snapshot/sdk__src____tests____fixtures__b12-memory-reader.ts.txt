import fs from 'node:fs'
import path from 'node:path'

console.log = console.error
console.info = console.error
console.debug = console.error

const { OpenbuffClient } = await import('../../client')
const { ProjectIdSchema } = await import('@codebuff/common/types/memory-v2')
const { BunSQLiteMemoryRepository } =
  await import('../../../../cli/src/services/memory-v2/bun-sqlite-memory-repository')
const { b12Consumer } = await import('./b12-memory-agents')

const manifest = JSON.parse(fs.readFileSync(process.argv[2]!, 'utf8')) as {
  root: string
  config: string
  stateFile: string
  projectId: string
  prompt: string
}
const opened = await BunSQLiteMemoryRepository.open({
  repositoryRoot: manifest.root,
})
if (opened.status === 'error') throw new Error(opened.error.message)
const repository = opened.repository
try {
  const previousRun = JSON.parse(fs.readFileSync(manifest.stateFile, 'utf8'))
  // No old transcript, compiler band or V1 in-memory decision can mask a
  // failure to retrieve canonical records in this NEW process.
  previousRun.sessionState.mainAgentState.messageHistory = []
  previousRun.sessionState.mainAgentState.taskMemory = undefined
  previousRun.sessionState.mainAgentState.memoryV2Context = undefined
  previousRun.sessionState.mainAgentState.playbookContext = []
  const queries: unknown[] = []
  const originalQuery = repository.query.bind(repository)
  repository.query = async (request) => {
    queries.push(structuredClone(request))
    return originalQuery(request)
  }
  const client = new OpenbuffClient({
    cwd: manifest.root,
    agentDefinitions: [b12Consumer],
    projectFiles: {},
    knowledgeFiles: {},
    userKnowledgeFiles: {},
    repositoryIntelligence: false,
    harnessStateDir: path.join(manifest.root, 'harness-next'),
    runTimeoutMs: 10_000,
    handleEvent() {},
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    memoryV2: {
      repository,
      projectId: ProjectIdSchema.parse(manifest.projectId),
      authority: 'sqlite-v2-opt-in',
      capture: 'safe',
    },
    hostConfiguration: {
      environment: {
        PATH: process.env.PATH,
        OPENBUFF_PROCESS_SUPERVISION: '0',
        OPENBUFF_TELEMETRY: '0',
        DO_NOT_TRACK: '1',
      },
      platform: process.platform,
      invocationCwd: manifest.root,
      projectRoot: manifest.root,
      home: { kind: 'none' },
      globals: { kind: 'disabled' },
      selection: { kind: 'explicit', path: manifest.config, required: true },
      trust: { ancestorConfig: false, projectReadableRoots: false },
    },
  })
  const result = await client.run({
    agent: b12Consumer.id,
    prompt: manifest.prompt,
    previousRun,
  })
  if (result.runOutcome?.termination !== 'completed')
    throw new Error(JSON.stringify(result.output))
  const events = await repository.listEvents({ limit: 1000 })
  if (events.status === 'error') throw new Error(events.error.message)
  process.stdout.write(
    JSON.stringify({
      runOutcome: result.runOutcome,
      authority: result.sessionState?.mainAgentState.memoryAuthority,
      memory: result.sessionState?.mainAgentState.memoryV2,
      context: result.sessionState?.mainAgentState.memoryV2Context,
      queries,
      events: events.events,
    }),
  )
} finally {
  await repository.close()
}

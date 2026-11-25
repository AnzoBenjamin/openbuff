import type { Database } from 'bun:sqlite'
import { lstatSync } from 'node:fs'
import { Worker } from 'node:worker_threads'
import type { MemoryRetrievalRequest } from '../../../../common/src/types/memory-v2'
import {
  knowledgeSelectorKey,
  KNOWLEDGE_PRODUCER_VERSION,
} from './knowledge-projection'

type SqlQuery = { sql: string; params: Array<string | number> }
export interface KnowledgeQueryRows {
  observations: Array<{ state_json: string }>
  tasks: Array<{ state_json: string }>
  coverage: Array<{ event_json: string }>
  corpus: Array<{
    observation_id: string
    kind: string
    summary: string
    detail: string
    claim_id: string | null
  }>
  metadata: Array<{ key: string; value: string }>
  candidateCapReached: boolean
  lexicalFallback: boolean
}

export function knowledgeQueryPlan(
  request: MemoryRetrievalRequest,
  includeCorpus: boolean,
) {
  const maxCandidates = Math.max(400, request.maxResultsPerCategory * 20)
  const tokens = [
    ...new Set(
      [request.query, ...request.selectors.map(knowledgeSelectorKey)]
        .join(' ')
        .toLowerCase()
        .split(/[^\p{L}\p{N}_./:-]+/u)
        .filter(Boolean),
    ),
  ].slice(0, 64)
  const quotedTokens = tokens
    .flatMap((token) => token.split(/[^\p{L}\p{N}_]+/u).filter(Boolean))
    .map((token) => `"${token.replaceAll('"', '""')}"`)
  const match = [...new Set(quotedTokens)].join(' OR ')
  const filter = `k.project_id=? AND (?=1 OR k.lifecycle='active')${request.taskId ? ' AND k.task_id=?' : ''}${request.artifactKinds.length ? ` AND EXISTS (SELECT 1 FROM memory_knowledge_selectors a WHERE a.observation_id=k.observation_id AND a.artifact_kind IN (${request.artifactKinds.map(() => '?').join(',')}))` : ''}`
  const filterParams: Array<string | number> = [
    request.projectId,
    request.includeHistorical ? 1 : 0,
    ...(request.taskId ? [request.taskId] : []),
    ...request.artifactKinds,
  ]
  const matches = ['k.pinned=1']
  const matchParams: Array<string | number> = []
  if (request.taskId) {
    matches.push('k.task_id=?')
    matchParams.push(request.taskId)
  }
  if (request.selectors.length) {
    matches.push(
      `EXISTS (SELECT 1 FROM memory_knowledge_selectors s WHERE s.observation_id=k.observation_id AND s.selector_key IN (${request.selectors.map(() => '?').join(',')}))`,
    )
    matchParams.push(...request.selectors.map(knowledgeSelectorKey))
  }
  const ftsMatches = match ? [...matches, 'lexical.rowid IS NOT NULL'] : matches
  const likeMatches = tokens.length
    ? [
        ...matches,
        ...tokens.map(() => "lower(k.search_text) LIKE ? ESCAPE '\\'"),
      ]
    : matches
  const escapeLike = (token: string) =>
    `%${token.replace(/[\\%_]/g, (char) => `\\${char}`)}%`
  const select = (predicates: string[]) =>
    `SELECT k.state_json FROM memory_knowledge k WHERE ${filter} AND (${predicates.join(' OR ')}) ORDER BY k.pinned DESC, k.source_sequence DESC, k.observation_id LIMIT ?`
  const observations: SqlQuery = match
    ? {
        sql: `WITH lexical AS MATERIALIZED (SELECT rowid,bm25(memory_knowledge_fts) AS score FROM memory_knowledge_fts WHERE memory_knowledge_fts MATCH ?)
      SELECT k.state_json FROM memory_knowledge k LEFT JOIN lexical ON lexical.rowid=k.rowid
      WHERE ${filter} AND (${ftsMatches.join(' OR ')})
      ORDER BY k.pinned DESC,COALESCE(lexical.score,0),k.source_sequence DESC,k.observation_id LIMIT ?`,
        params: [match, ...filterParams, ...matchParams, maxCandidates + 1],
      }
    : {
        sql: select(ftsMatches),
        params: [...filterParams, ...matchParams, maxCandidates + 1],
      }
  const fallback: SqlQuery = {
    sql: select(likeMatches),
    params: [
      ...filterParams,
      ...matchParams,
      ...tokens.map(escapeLike),
      maxCandidates + 1,
    ],
  }
  const tasks: SqlQuery = {
    sql: `SELECT state_json FROM memory_knowledge_tasks WHERE project_id=?${request.taskId ? ' AND task_id=?' : ''}${tokens.length ? ` AND (${tokens.map(() => "lower(search_text) LIKE ? ESCAPE '\\'").join(' OR ')})` : ''} ORDER BY task_id LIMIT ?`,
    params: [
      request.projectId,
      ...(request.taskId ? [request.taskId] : []),
      ...tokens.map(escapeLike),
      maxCandidates + 1,
    ],
  }
  const coverage: SqlQuery = {
    sql: `SELECT event_json FROM memory_knowledge_coverage WHERE project_id=?${request.taskId ? ' AND task_id=?' : ''} ORDER BY task_id,dimension`,
    params: [request.projectId, ...(request.taskId ? [request.taskId] : [])],
  }
  const corpus: SqlQuery = {
    sql: `SELECT k.observation_id,k.kind,substr(json_extract(k.state_json,'$.observation.summary'),1,512) AS summary,substr(json_extract(k.state_json,'$.observation.detail'),1,512) AS detail,json_extract(k.state_json,'$.observation.provenance.metadata.claimId') AS claim_id FROM memory_knowledge k WHERE k.project_id=? AND k.lifecycle='active' ORDER BY k.updated_sequence,k.observation_id`,
    params: [request.projectId],
  }
  return {
    observations,
    fallback,
    tasks,
    coverage,
    corpus,
    includeCorpus,
    maxCandidates,
    producer: KNOWLEDGE_PRODUCER_VERSION,
  }
}

export function readKnowledgeQuery(
  database: Database,
  plan: ReturnType<typeof knowledgeQueryPlan>,
): KnowledgeQueryRows {
  return database
    .transaction(() => {
      const metadata = database
        .query(
          "SELECT key,value FROM memory_knowledge_metadata UNION ALL SELECT 'canonicalTail',CAST(COALESCE(max(sequence),0) AS TEXT) FROM memory_events",
        )
        .all() as KnowledgeQueryRows['metadata']
      let observations: KnowledgeQueryRows['observations']
      let lexicalFallback = false
      try {
        observations = database
          .query(plan.observations.sql)
          .all(
            ...plan.observations.params,
          ) as KnowledgeQueryRows['observations']
      } catch {
        lexicalFallback = true
        observations = database
          .query(plan.fallback.sql)
          .all(...plan.fallback.params) as KnowledgeQueryRows['observations']
      }
      const tasks = database
        .query(plan.tasks.sql)
        .all(...plan.tasks.params) as KnowledgeQueryRows['tasks']
      const coverage = database
        .query(plan.coverage.sql)
        .all(...plan.coverage.params) as KnowledgeQueryRows['coverage']
      const corpus = plan.includeCorpus
        ? (database
            .query(plan.corpus.sql)
            .all(...plan.corpus.params) as KnowledgeQueryRows['corpus'])
        : []
      return {
        observations: observations.slice(0, plan.maxCandidates),
        tasks: tasks.slice(0, plan.maxCandidates),
        coverage,
        corpus,
        metadata,
        candidateCapReached:
          observations.length > plan.maxCandidates ||
          tasks.length > plan.maxCandidates,
        lexicalFallback,
      }
    })
    .deferred()
}

const workerSource = `
const {parentPort,workerData}=require('node:worker_threads');
const {lstatSync}=require('node:fs');
const {Database}=require('bun:sqlite');
let db;
const check=()=>{const s=lstatSync(workerData.path);if(!s.isFile()||s.dev!==workerData.dev||s.ino!==workerData.ino)throw new Error('SQLite identity changed')};
try {
  check();db=new Database(workerData.path,{readonly:true,strict:true});check();
  const p=workerData.plan;
  const result=db.transaction(()=>{
    const all=q=>db.query(q.sql).all(...q.params);
    const metadata=db.query("SELECT key,value FROM memory_knowledge_metadata UNION ALL SELECT 'canonicalTail',CAST(COALESCE(max(sequence),0) AS TEXT) FROM memory_events").all();
    let observations,lexicalFallback=false;
    try{observations=all(p.observations)}catch{lexicalFallback=true;observations=all(p.fallback)}
    const tasks=all(p.tasks),coverage=all(p.coverage),corpus=p.includeCorpus?all(p.corpus):[];
    return {observations:observations.slice(0,p.maxCandidates),tasks:tasks.slice(0,p.maxCandidates),coverage,corpus,metadata,candidateCapReached:observations.length>p.maxCandidates||tasks.length>p.maxCandidates,lexicalFallback};
  }).deferred();check();parentPort.postMessage({ok:true,result});
}catch{parentPort.postMessage({ok:false})}finally{db?.close();parentPort.close()}
`

/** Candidate selection/FTS run on a consistent read-only snapshot outside the TUI. */
export function scanKnowledgeQuery(
  path: string,
  plan: ReturnType<typeof knowledgeQueryPlan>,
  timeoutMs = 30_000,
): Promise<KnowledgeQueryRows> {
  const identity = lstatSync(path)
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerSource, {
      eval: true,
      workerData: { path, plan, dev: identity.dev, ino: identity.ino },
    })
    let settled = false
    const finish = (action: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      void worker.terminate().catch(() => {})
      action()
    }
    const fail = () =>
      finish(() => reject(new Error('Knowledge projection query failed')))
    const timer = setTimeout(fail, timeoutMs)
    worker.once('error', fail)
    worker.once('exit', fail)
    worker.once('message', (message) => {
      if (!message.ok) fail()
      else finish(() => resolve(message.result))
    })
  })
}

import type { ProgramOrigin } from './immutable-replay-program'
import { sha, traceLimit, payloadLimit } from './immutable-replay-program'

export type EventKind = 'request' | 'reply' | 'terminal'
export type RawProgramEvent = { seq: number; kind: EventKind; payload: string }
type Row = {
  run_id: string
  agent_id: string
  user_input_id: string
  owner_pid: number
  basis_sha256: string
  runtime_sha256: string
  claimed: number
  event_count: number
  tail_sha256: string
}
type Statement = {
  all(...args: unknown[]): unknown[]
  get(...args: unknown[]): unknown
  run(...args: unknown[]): { changes: number }
}
type Sqlite = {
  run(...args: [string, ...unknown[]]): { changes: number }
  query(sql: string): Statement
  close(): void
}
const genesis = (origin: ProgramOrigin, runtime: string) =>
  sha(JSON.stringify([origin, runtime]))
const extend = (hash: string, row: RawProgramEvent) =>
  sha(JSON.stringify([hash, row.seq, row.kind, row.payload]))
const fromRow = (row: Row): ProgramOrigin => ({
  runId: row.run_id,
  agentId: row.agent_id,
  userInputId: row.user_input_id,
  ownerPid: row.owner_pid,
  basis: row.basis_sha256,
})
const ownsPid = (pid: number) => {
  if (!Number.isSafeInteger(pid) || pid < 1) return false
  try {
    process.kill(pid, 0)
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH'
  }
  return false
}
/** This mode owns its bounded tape and claim together. It never reads generic journals. */
export function openProgramStore(path: string) {
  // Deliberately lazy: importing the ordinary SDK in Node must remain supported.
  // @ts-ignore -- Node-only TypeScript consumers lack declarations for Bun runtime modules.
  const { Database } = require('bun:sqlite') as {
    Database: new (path: string) => Sqlite
  }
  const db = new Database(path)
  try {
    db.run('PRAGMA busy_timeout=5000;')
    db.run('PRAGMA journal_mode=WAL;')
    db.run('PRAGMA synchronous=FULL;')
    db.run(`CREATE TABLE IF NOT EXISTS program_runs (
      run_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, user_input_id TEXT NOT NULL, owner_pid INTEGER NOT NULL,
      basis_sha256 TEXT NOT NULL, runtime_sha256 TEXT NOT NULL, claimed INTEGER NOT NULL CHECK(claimed IN (0,1)),
      event_count INTEGER NOT NULL, tail_sha256 TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS program_events (
      run_id TEXT NOT NULL, seq INTEGER NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('request','reply','terminal')),
      payload TEXT NOT NULL, PRIMARY KEY(run_id,seq)
    ) STRICT;`)
  } catch (error) {
    db.close()
    throw error
  }
  const transact = <T>(fn: () => T): T => {
    db.run('BEGIN IMMEDIATE;')
    try {
      const result = fn()
      db.run('COMMIT;')
      return result
    } catch (error) {
      try {
        db.run('ROLLBACK;')
      } catch {
        /* preserve the original refusal */
      }
      throw error
    }
  }
  const select = db.query('SELECT * FROM program_runs WHERE run_id = ?')
  return {
    begin(origin: ProgramOrigin, runtime: string) {
      transact(() => {
        db.run(
          'INSERT INTO program_runs VALUES (?,?,?,?,?,?,0,0,?)',
          origin.runId,
          origin.agentId,
          origin.userInputId,
          origin.ownerPid,
          origin.basis,
          runtime,
          genesis(origin, runtime),
        )
      })
    },
    claim<T>(
      runId: string,
      basis: string,
      runtime: string,
      verify: (rows: RawProgramEvent[], origin: ProgramOrigin) => T,
    ) {
      return transact(() => {
        const run = select.get(runId) as Row | null
        if (!run || run.claimed !== 0)
          throw new Error('The original program is missing or already claimed')
        if (run.basis_sha256 !== basis || run.runtime_sha256 !== runtime)
          throw new Error(
            'The immutable program, input, route or runtime changed',
          )
        const origin = fromRow(run)
        if (!ownsPid(origin.ownerPid))
          throw new Error('The original program owner may still be live')
        if (
          !Number.isSafeInteger(run.event_count) ||
          run.event_count < 2 ||
          run.event_count > traceLimit
        )
          throw new Error('The program has no bounded retained prefix')
        const count = db
          .query(
            'SELECT COUNT(*) AS count, MAX(LENGTH(CAST(payload AS BLOB))) AS largest FROM (SELECT payload FROM program_events WHERE run_id = ? LIMIT ?)',
          )
          .get(runId, traceLimit + 1) as { count: number; largest: number }
        if (count.count !== run.event_count || count.largest > payloadLimit)
          throw new Error(
            'The durable program stream is incomplete or exceeds its bound',
          )
        const rows = db
          .query(
            'SELECT seq,kind,payload FROM program_events WHERE run_id = ? ORDER BY seq',
          )
          .all(runId) as RawProgramEvent[]
        if (
          rows.some((row, i) => row.seq !== i) ||
          rows.reduce(extend, genesis(origin, runtime)) !== run.tail_sha256
        )
          throw new Error('The durable program tail seal changed')
        const verified = verify(rows, origin)
        if (
          db.run(
            'UPDATE program_runs SET claimed = 1 WHERE run_id = ? AND claimed = 0',
            runId,
          ).changes !== 1
        )
          throw new Error('The program was already claimed')
        return {
          origin,
          verified,
          eventCount: rows.length,
          tail: run.tail_sha256,
        }
      })
    },
    append(
      origin: ProgramOrigin,
      claimed: boolean,
      seq: number,
      tail: string,
      kind: EventKind,
      value: unknown,
    ) {
      const payload = JSON.stringify(value)
      if (
        !payload ||
        Buffer.byteLength(payload) > payloadLimit ||
        seq >= traceLimit
      )
        throw new Error('Program event exceeds its journal bound')
      return transact(() => {
        const run = select.get(origin.runId) as Row | null
        if (
          !run ||
          run.owner_pid !== origin.ownerPid ||
          run.claimed !== Number(claimed) ||
          run.event_count !== seq ||
          run.tail_sha256 !== tail
        )
          throw new Error('Program journal ownership changed')
        const next = extend(tail, { seq, kind, payload })
        db.run(
          'INSERT INTO program_events VALUES (?,?,?,?)',
          origin.runId,
          seq,
          kind,
          payload,
        )
        db.run(
          'UPDATE program_runs SET event_count = ?, tail_sha256 = ? WHERE run_id = ?',
          seq + 1,
          next,
          origin.runId,
        )
        return next
      })
    },
    close: () => db.close(),
  }
}
export const initialProgramSeal = genesis

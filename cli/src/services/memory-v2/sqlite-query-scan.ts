import { lstatSync } from 'node:fs'
import { Worker } from 'node:worker_threads'

// Shared admission contract for disk workers and in-memory repositories.
export const queryAdmissionSQL = `WITH forgotten AS MATERIALIZED (
         SELECT removed.value AS observation_id, max(events.sequence) AS forgotten_sequence
           FROM memory_events events, json_each(events.payload_json, '$.observationIds') removed
          WHERE ?3 = 0 AND events.event_type = 'claim.forgotten'
            AND json_extract(events.metadata_json, '$.projectId') = ?1
          GROUP BY removed.value
       )
       SELECT sequence,
            length(CAST(payload_json AS BLOB)) AS payload_bytes,
            length(CAST(metadata_json AS BLOB)) AS metadata_bytes
       FROM memory_events
      WHERE json_extract(metadata_json, '$.projectId') = ?1
        AND NOT (
          event_type IN ('observation.recorded', 'evidence.attached', 'evidence.verified',
                         'evidence.invalidated', 'observation.reused', 'observation.ignored',
                         'observation.reinforced', 'claim.pinned')
          AND EXISTS (
            SELECT 1 FROM forgotten
             WHERE forgotten.observation_id = CASE WHEN event_type = 'observation.recorded'
               THEN json_extract(payload_json, '$.observation.observationId')
               ELSE json_extract(payload_json, '$.observationId') END
               AND forgotten.forgotten_sequence > memory_events.sequence
          )
        )
      ORDER BY sequence DESC
      LIMIT ?2`

const workerSource = `
const { parentPort, workerData } = require('node:worker_threads');
const { lstatSync } = require('node:fs');
const { Database } = require('bun:sqlite');
let database;
const checkIdentity = () => {
  const current = lstatSync(workerData.databasePath);
  if (!current.isFile() || current.dev !== workerData.dev || current.ino !== workerData.ino)
    throw new Error('SQLite file identity changed');
};
try {
  checkIdentity();
  database = new Database(workerData.databasePath, { readonly: true, strict: true });
  checkIdentity();
  const result = database.transaction(() => {
    const { projectId, includeHistorical, maxEvents, maxBytes } = workerData;
    const admission = database.query(workerData.admissionSQL).all(projectId, maxEvents + 1, includeHistorical ? 1 : 0);
    const sequences = [];
    let bytes = 0, payloadBudgetReached = false;
    for (const row of admission.slice(0, maxEvents)) {
      const rowBytes = row.payload_bytes + row.metadata_bytes;
      if (bytes + rowBytes > maxBytes) { payloadBudgetReached = true; break; }
      sequences.push(row.sequence);
      bytes += rowBytes;
    }
    const rows = sequences.length ? database.query(
      'SELECT sequence, event_id, idempotency_key, event_type, occurred_at, payload_json, metadata_json, task_id, session_id, artifact_id FROM memory_events WHERE sequence IN (' + sequences.map(() => '?').join(',') + ') ORDER BY sequence DESC'
    ).all(...sequences) : [];
    return { rows, eventCapReached: admission.length > maxEvents, payloadBudgetReached };
  }).deferred();
  checkIdentity();
  parentPort.postMessage({ ok: true, result });
} catch {
  parentPort.postMessage({ ok: false });
} finally {
  database?.close();
  parentPort.close();
}
`

/** Bound and scan one consistent read-only snapshot outside the TUI thread. */
export function scanSQLiteQuery<Row>(params: {
  databasePath: string
  projectId: string
  includeHistorical: boolean
  maxEvents: number
  maxBytes: number
}, timeoutMs = 30_000): Promise<{
  rows: Row[]
  eventCapReached: boolean
  payloadBudgetReached: boolean
}> {
  const identity = lstatSync(params.databasePath)
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerSource, {
      eval: true,
      workerData: { ...params, dev: identity.dev, ino: identity.ino, admissionSQL: queryAdmissionSQL },
    })
    let settled = false
    const finish = (action: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      void worker.terminate().catch(() => {})
      action()
    }
    const fail = () => finish(() => reject(new Error('SQLite query worker failed')))
    const timer = setTimeout(fail, timeoutMs)
    worker.once('error', fail)
    worker.once('exit', fail)
    worker.once('message', result => {
      if (!result.ok) fail()
      else finish(() => resolve(result.result))
    })
  })
}

import { Worker } from 'node:worker_threads'

// Eval source works in the compiled CLI without requiring an on-disk worker.
// The worker opens read-only and returns no database contents or paths.
export const sqliteIntegrityWorkerSource = `
const { parentPort, workerData } = require('node:worker_threads');
const { Database } = require('bun:sqlite');
let database;
try {
  database = new Database(workerData, { readonly: true, strict: true });
  const result = database.query('PRAGMA quick_check(1)').get();
  parentPort.postMessage({ ok: true, valid: result?.quick_check === 'ok' });
} catch {
  parentPort.postMessage({ ok: false });
} finally {
  database?.close();
  parentPort.close();
}
`

export function checkSQLiteIntegrity(
  databasePath: string,
  timeoutMs = 30_000,
): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(sqliteIntegrityWorkerSource, {
      eval: true,
      workerData: databasePath,
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
      finish(() => reject(new Error('SQLite integrity worker failed')))
    const timer = setTimeout(fail, timeoutMs)
    worker.once('error', fail)
    worker.once('exit', fail)
    worker.once('message', (result: { ok: boolean; valid?: boolean }) => {
      if (!result.ok) fail()
      else finish(() => resolve(result.valid === true))
    })
  })
}

/** Standalone Node host: a pending handshake must hold its owned child alive. */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import type { Readable } from 'node:stream'

import { registerAttachedJob } from '../../tools/attached-job-lifetime'

const mode = process.argv[2] ?? 'natural'
const record = (event: string, detail: unknown = null) => {
  fs.writeSync(1, `${JSON.stringify({ event, detail, at: Date.now() })}\n`)
}

async function main(): Promise<void> {
  const child = spawn(process.execPath, ['-e', `
    const fs = require('node:fs');
    const net = require('node:net');
    process.on('SIGTERM', () => process.exit(0));
    const control = new net.Socket({ fd: 4, readable: true, writable: true });
    control.on('data', () => {});
    setTimeout(() => fs.writeSync(3, ${JSON.stringify(mode === 'reject' ? 'ERROR\n' : 'READY\n')}), ${mode === 'signal' ? 1500 : 350});
    setInterval(() => {}, 1000);
  `], { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] })
  // Drain the second socket too: ChildProcess close waits for all stdio EOFs.
  ;(child.stdio[4] as Readable).resume()

  const closed = new Promise<void>(resolve => child.once('close', () => {
    record('REAPED', { code: child.exitCode, signal: child.signalCode })
    resolve()
  }))
  let ready = false
  const started = new Promise<void>((resolve, reject) => {
    let input = ''
    const handshake = child.stdio[3] as Readable
    handshake.on('data', chunk => {
      input += String(chunk)
      if (!input.includes('\n')) return
      if (input.startsWith('READY\n')) { ready = true; resolve() }
      else reject(new Error('handshake refused'))
    })
    child.once('error', reject)
    child.once('exit', () => {
      if (!ready) reject(new Error('child stopped before startup'))
    })
  })
  // A named handle lets this compile against the pre-fix interface too. The
  // optional started property is the only input the production fix adds.
  const handle = {
    jobId: 'attached-startup-regression', child, started,
    stop: async () => {
      record('STOP')
      child.kill('SIGTERM')
      await closed
    },
  }
  registerAttachedJob(handle)
  record('PENDING', { pid: child.pid, mode })
  // Deliberately no ref'd keeper timer: the actual child and fd3/fd4 handles
  // must hold the loop until the adapter startup promise settles.
  try {
    await started
    record('READY')
  } catch (error) {
    record('START_ERROR', error instanceof Error ? error.message : String(error))
    process.exitCode = 2
  }
}

void main().catch(error => { record('HOST_ERROR', String(error)); process.exitCode = 3 })

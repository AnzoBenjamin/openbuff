import { EventEmitter } from 'node:events'

import { afterEach, describe, expect, test } from 'bun:test'

import {
  __resetAttachedJobsForTest,
  attachedJobIds,
  registerAttachedJob,
  stopAttachedJobs,
} from '../tools/attached-job-lifetime'

import type { ChildProcess } from 'node:child_process'
import type { AttachedJobProcess } from '../tools/attached-job-lifetime'

function processFixture() {
  const events = new EventEmitter()
  const exits: number[] = []
  const proc = Object.assign(events, {
    exit: (code: number) => {
      exits.push(code)
    },
  }) as unknown as AttachedJobProcess
  return { events, exits, proc }
}

function childFixture() {
  const child = Object.assign(new EventEmitter(), {
    pid: 2_000_000_000,
    exitCode: null,
    signalCode: null,
    stdio: [],
    unref: () => {},
    kill: () => true,
  }) as unknown as ChildProcess
  return child
}

afterEach(() => __resetAttachedJobsForTest())

describe('attached-job shutdown containment', () => {
  test('a synchronous stop failure does not prevent the other owned jobs from stopping', async () => {
    const { proc } = processFixture()
    const stopped: string[] = []
    registerAttachedJob(
      {
        jobId: 'broken',
        child: childFixture(),
        stop: () => {
          stopped.push('broken')
          throw new Error('fixture stop failed synchronously')
        },
      },
      proc,
    )
    registerAttachedJob(
      {
        jobId: 'healthy',
        child: childFixture(),
        stop: async () => {
          stopped.push('healthy')
        },
      },
      proc,
    )
    await expect(stopAttachedJobs()).resolves.toBeUndefined()
    expect(stopped).toEqual(['broken', 'healthy'])
  })

  test('closing the last job during cooperative shutdown removes only the SDK listeners', async () => {
    const { proc, events, exits } = processFixture()
    let finish!: () => void
    const stopping = new Promise<void>((resolve) => {
      finish = resolve
    })
    const hostHandler = () => {}
    events.on('SIGTERM', hostHandler)
    const child = childFixture()
    registerAttachedJob({ jobId: 'closing', child, stop: () => stopping }, proc)
    events.emit('SIGTERM')
    child.emit('close', 0, null)
    expect(attachedJobIds()).toEqual([])
    finish()
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(exits).toEqual([])
    expect(events.listeners('SIGTERM')).toEqual([hostHandler])
    for (const signal of ['SIGINT', 'SIGHUP', 'exit', 'beforeExit'])
      expect(events.listenerCount(signal)).toBe(0)
  })
})

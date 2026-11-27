import { expect, test } from 'bun:test'
import {
  createProjectTreeRequests,
  transitionProject,
} from '../project-transition'

test('failed project preparation restores the original context before reporting failure', async () => {
  let root = '/old'
  const prepared: string[] = []
  const result = await transitionProject({
    previousRoot: root,
    targetRoot: '/new',
    switchContext: async (next) => {
      root = next
    },
    prepare: async () => {
      throw new Error('registry failed')
    },
    recover: async () => {
      prepared.push(root)
    },
  })
  expect(result.status).toBe('failed')
  expect(root).toBe('/old')
  expect(prepared).toEqual(['/old'])
})
test('failed rollback is returned as a distinct recoverable selection error', async () => {
  const result = await transitionProject({
    previousRoot: '/old',
    targetRoot: '/new',
    switchContext: async (root) => {
      if (root === '/old') throw new Error('old folder disappeared')
    },
    prepare: async () => {
      throw new Error('new context failed')
    },
    recover: async () => {},
  })
  expect(result.status).toBe('failed')
  if (result.status === 'failed')
    expect((result.recoveryError as Error).message).toBe(
      'old folder disappeared',
    )
})
test('late file-tree success is rejected after project change and same-root reload', () => {
  const requests = createProjectTreeRequests()
  const old = requests.begin('/old')
  requests.invalidate()
  const next = requests.begin('/new')
  expect(requests.accepts(old, '/new')).toBe(false)
  expect(requests.accepts(next, '/old')).toBe(false)
  expect(requests.accepts(next, '/new')).toBe(true)
  const latest = requests.begin('/new')
  expect(requests.accepts(next, '/new')).toBe(false)
  expect(requests.accepts(latest, '/new')).toBe(true)
})

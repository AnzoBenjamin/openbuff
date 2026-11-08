import { expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { withEvaluationEnvironment } from '../evaluation-environment'

test('trusted evaluation applies explicit removals to the captured environment', async () => {
  const inherited = Object.freeze({ PROJECT_VALUE: 'captured', REMOVE_ME: 'inherited' })
  const supplied = Object.freeze({ PROJECT_VALUE: 'override', REMOVE_ME: undefined })
  const observed = await withEvaluationEnvironment('trusted_task', supplied, async env => env, inherited)

  expect(observed).toEqual({ PROJECT_VALUE: 'override' })
  expect(inherited.REMOVE_ME).toBe('inherited')
  expect(supplied.REMOVE_ME).toBeUndefined()
})

test('key-free evaluation removes undefined overrides and cleans up its isolated home', async () => {
  let ownedHome = ''
  await withEvaluationEnvironment('key_free_environment', {
    PROJECT_VALUE: 'explicit', PATH: undefined, OPENAI_API_KEY: undefined,
  }, async env => {
    ownedHome = env.HOME!
    expect(existsSync(ownedHome)).toBe(true)
    expect(env.PROJECT_VALUE).toBe('explicit')
    expect(env).not.toHaveProperty('PATH')
    expect(env).not.toHaveProperty('OPENAI_API_KEY')
    expect(env).not.toHaveProperty('CUSTOM_PROVIDER_KEY')
    expect(Object.values(env).every(value => typeof value === 'string')).toBe(true)
  }, { OPENAI_API_KEY: 'host-sentinel', CUSTOM_PROVIDER_KEY: 'configured-sentinel' })

  expect(ownedHome).not.toBe('')
  expect(existsSync(ownedHome)).toBe(false)
})

test('key-free evaluation refuses a defined supplied credential before invoking the task', async () => {
  let invoked = false
  await expect(withEvaluationEnvironment('key_free_environment', { OPENAI_API_KEY: 'supplied-sentinel' }, async () => {
    invoked = true
  })).rejects.toThrow('explicitly supplied credentials')
  expect(invoked).toBe(false)
})

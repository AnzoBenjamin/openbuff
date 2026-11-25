import { expect, test } from 'bun:test'
import { repositoryIntelligenceCacheKey } from '../repository-intelligence-native'

test('native store identity depends on the source store, independently of executable upgrades', () => {
  expect(repositoryIntelligenceCacheKey('/tmp/project/store')).toBe(
    repositoryIntelligenceCacheKey('/tmp/project/./store'),
  )
  expect(repositoryIntelligenceCacheKey('/tmp/project/store')).not.toBe(
    repositoryIntelligenceCacheKey('/tmp/other/store'),
  )
  expect(repositoryIntelligenceCacheKey('/tmp/project/store')).toMatch(
    /^[a-f0-9]{24}$/,
  )
  expect(
    repositoryIntelligenceCacheKey('/tmp/worktree-a/store', '/tmp/repo/.git'),
  ).toBe(
    repositoryIntelligenceCacheKey('/tmp/worktree-b/store', '/tmp/repo/.git'),
  )
})

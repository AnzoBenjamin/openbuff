import { describe, test, expect } from 'bun:test'

import {
  buildHarnessApprovalPrompt,
  isSensitiveFile,
  isEnvTemplateFile,
} from '../../utils/create-run-config'

describe('buildHarnessApprovalPrompt', () => {
  test('uses high-risk header and preserves Allow once label', () => {
    const prompt = buildHarnessApprovalPrompt({
      action: 'workspace-delete',
      target: 'git clean -fd',
      reason: 'Deletes untracked files.',
      risk: 'high',
    })

    expect(prompt.header).toBe('High-risk action')
    expect(prompt.question).toContain('Allow workspace-delete: git clean -fd?')
    expect(prompt.question).toContain(
      'This may destroy data, deploy, or run eval code.',
    )
    expect(prompt.options[0]?.label).toBe('Allow once')
    expect(prompt.options[0]?.description).toContain('High impact')
    expect(prompt.options[1]?.label).toBe('Deny')
    expect(prompt.options[1]?.description).toBe(
      'Block this command and continue without running it.',
    )
    expect(prompt.multiSelect).toBe(false)
  })

  test('uses routine Confirm action header and single-use framing', () => {
    const prompt = buildHarnessApprovalPrompt({
      action: 'dependency-install',
      target: 'bun add zod',
      reason: 'Installs a package.',
      risk: 'routine',
    })

    expect(prompt.header).toBe('Confirm action')
    expect(prompt.question).toBe('Allow dependency-install?\nbun add zod')
    expect(prompt.options[0]?.label).toBe('Allow once')
    expect(prompt.options[0]?.description).toContain(
      'Routine classified action; single-use for this exact target.',
    )
  })

  test('truncates long targets in the displayed question only', () => {
    const longTarget = `git restore ${'a'.repeat(250)}`
    const prompt = buildHarnessApprovalPrompt({
      action: 'workspace-delete',
      target: longTarget,
      reason: 'Restores worktree files.',
      risk: 'high',
    })

    expect(prompt.question.includes(longTarget)).toBe(false)
    expect(prompt.question).toContain('…')
    expect(prompt.question.length).toBeLessThan(
      `This may destroy data, deploy, or run eval code.\nAllow workspace-delete: ${longTarget}?`
        .length,
    )
  })
})

describe('isSensitiveFile', () => {
  test.each([
    // Env files (blocked)
    ['.env', true],
    ['.env.local', true],
    ['config/.env.production', true],

    // Env templates (allowed)
    ['.env.example', false],
    ['.env.sample', false],
    ['.env.template', false],

    // Sensitive extensions
    ['private.pem', true],
    ['server.key', true],
    ['cert.p12', true],
    ['app.keystore', true],
    ['server.crt', true],

    // Sensitive basenames
    ['.htpasswd', true],
    ['.netrc', true],
    ['credentials', true],
    ['Credentials', true],
    ['.npmrc', true],
    ['.NPMRC', true],
    ['.yarnrc.yml', true],
    ['auth.json', true],
    ['terraform.tfvars', true],

    // SSH keys (prefix pattern)
    ['id_rsa', true],
    ['id_ed25519', true],
    ['id_rsa_github', true],
    ['id_rsa.pub', false], // public keys allowed

    // Credentials suffix pattern
    ['aws_credentials', true],
    ['db_credentials', true],

    // Substring patterns
    ['kubeconfig', true],
    ['my-kubeconfig.yaml', true],
    ['terraform.tfstate', true],
    ['prod.tfstate.backup', true],

    // Non-sensitive (should NOT be blocked)
    ['package.json', false],
    ['README.md', false],
    ['src/index.ts', false],
    ['.envrc', false],
    ['credentials.ts', false],
    ['terraform.tf', false],
    ['kube-config.ts', false],
  ])('%s → %s', (file, expected) => {
    expect(isSensitiveFile(file)).toBe(expected)
  })
})

describe('isEnvTemplateFile', () => {
  test.each([
    ['.env.example', true],
    ['.env.sample', true],
    ['.env.template', true],
    ['config/.env.example', true],
    ['.env', false],
    ['.env.local', false],
    ['package.json', false],
  ])('%s → %s', (file, expected) => {
    expect(isEnvTemplateFile(file)).toBe(expected)
  })
})

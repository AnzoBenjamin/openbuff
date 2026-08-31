import { describe, expect, test } from 'bun:test'

import {
  isAgentSessionArtifactPath,
  isMandatorySensitiveReadPath,
} from '../sensitive-paths'

describe('isMandatorySensitiveReadPath', () => {
  test('does not treat public certs, docs, examples, or yarnrc as sensitive', () => {
    for (const path of [
      'certs/server.crt',
      'certs/ca.cer',
      'docs/kubeconfig-guide.md',
      'scripts/setup-kubeconfig.sh',
      'terraform.tfstate.example',
      'about-tfstate.md',
      '.yarnrc',
      '.yarnrc.yml',
    ]) {
      expect(isMandatorySensitiveReadPath(path)).toBe(false)
    }
  })

  test('still blocks real secrets and credential artifacts', () => {
    for (const path of [
      '.env',
      '.env.local',
      'id_rsa',
      'id_ed25519',
      'secret.pem',
      'kubeconfig',
      'cluster.kubeconfig',
      'terraform.tfstate',
      'terraform.tfstate.backup',
      '.npmrc',
      'credentials',
      '.pypirc',
    ]) {
      expect(isMandatorySensitiveReadPath(path)).toBe(true)
    }
  })

  test('blocks openbuff/cloud-CLI credential files, case-normalized', () => {
    for (const path of [
      'credentials.json',
      'credentials.yaml',
      'credentials.yml',
      // The openbuff global config directory location.
      '/home/user/.config/openbuff/credentials.json',
      // Basename matching is case-normalized.
      'Credentials.JSON',
      'CREDENTIALS.YML',
    ]) {
      expect(isMandatorySensitiveReadPath(path)).toBe(true)
    }
  })

  test('blocks path-aware credential carriers under their owning tool directory', () => {
    for (const path of [
      // kubeconfig, docker registry auth, gh CLI OAuth token store, AWS config.
      '/home/user/.kube/config',
      '/home/user/.docker/config.json',
      '/home/user/.config/gh/hosts.yml',
      '/home/user/.aws/config',
      // The bare `credentials` half of the `.aws` pair.
      '/home/user/.aws/credentials',
    ]) {
      expect(isMandatorySensitiveReadPath(path)).toBe(true)
    }
  })

  test('keeps generic config and inventory files readable', () => {
    // These basenames are far too generic to blanket-block: the carriers above
    // are matched on their owning parent directory precisely so ordinary
    // repository files stay readable.
    for (const path of [
      'src/config',
      'src/config.json',
      // No `gh` ancestor, so this is an ansible inventory, not a token store.
      'inventory/hosts.yml',
    ]) {
      expect(isMandatorySensitiveReadPath(path)).toBe(false)
    }
  })

  test('blocks credentials-bearing basenames with a structured-data extension', () => {
    for (const path of [
      'application_default_credentials.json',
      '/home/user/.config/gcloud/application_default_credentials.json',
      'gcloud_credentials.json',
      'service_credentials.yaml',
      'service_credentials.yml',
    ]) {
      expect(isMandatorySensitiveReadPath(path)).toBe(true)
    }
  })

  test('keeps credential documentation readable', () => {
    // Deliberately narrow basenames instead of a `credentials.*` pattern.
    for (const path of [
      'credentials.md',
      'docs/credentials-guide.md',
      'docs/credentials.txt',
      // A `credentials`-bearing doc, not a structured credential store.
      'docs/application_default_credentials.md',
    ]) {
      expect(isMandatorySensitiveReadPath(path)).toBe(false)
    }
  })

  test('allows env template files', () => {
    expect(isMandatorySensitiveReadPath('.env.example')).toBe(false)
    expect(isMandatorySensitiveReadPath('.env.sample')).toBe(false)
  })
})

describe('agent session artifact paths', () => {
  test('recognizes canonical plan and audit artifacts', () => {
    for (const path of [
      '.agents/sessions/readiness/SPEC.md',
      '.agents/sessions/readiness/PLAN.md',
      '.agents/sessions/readiness/STATUS.md',
      '.agents/sessions/readiness/LESSONS.md',
      '.agents/sessions/readiness/STATE.json',
      '.agents/sessions/readiness/AUDIT-REPORT.md',
      '.agents/sessions/readiness/findings/services.md',
    ]) {
      expect(isAgentSessionArtifactPath(path)).toBe(true)
    }
  })

  test('permits traversal directories but not unrelated .agents files', () => {
    expect(isAgentSessionArtifactPath('.agents/sessions')).toBe(true)
    expect(isAgentSessionArtifactPath('.agents/sessions/readiness')).toBe(true)
    expect(
      isAgentSessionArtifactPath('.agents/sessions/readiness/findings'),
    ).toBe(true)
    expect(isAgentSessionArtifactPath('.agents/mcp.json')).toBe(false)
    expect(isAgentSessionArtifactPath('.agents/agents/private.ts')).toBe(false)
    expect(
      isAgentSessionArtifactPath('.agents/sessions/readiness/secrets.txt'),
    ).toBe(false)
  })
})

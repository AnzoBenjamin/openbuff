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

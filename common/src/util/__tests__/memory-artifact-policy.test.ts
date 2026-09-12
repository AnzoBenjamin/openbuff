import { describe, expect, test } from 'bun:test'

import {
  classifyMemoryArtifactPath,
  isMemoryArtifactPersistenceAllowed,
  normalizeMemoryArtifactPath,
} from '../memory-artifact-policy'

const provenance = {
  generator: 'protobuf',
  config: 'proto/buf.gen.yaml',
  sourceInputs: ['proto/service.proto'],
  toolVersion: '1.2.3',
}

describe('memory artifact policy', () => {
  test.each([
    ['src/index.ts', 'source'],
    ['src/index.test.ts', 'test'],
    ['tests/integration.ts', 'test'],
    ['docs/architecture.md', 'documentation'],
    ['tsconfig.json', 'configuration'],
    ['data/fixtures.csv', 'data'],
    ['assets/logo.png', 'binary'],
    ['node_modules/zod/index.js', 'dependency'],
  ] as const)('classifies %s as %s', (path, kind) => {
    expect(classifyMemoryArtifactPath(path).kind).toBe(kind)
  })

  test('normalizes project paths and rejects traversal and absolute paths', () => {
    expect(normalizeMemoryArtifactPath('./src\\index.ts')).toBe('src/index.ts')
    expect(normalizeMemoryArtifactPath('../secret')).toBeUndefined()
    expect(normalizeMemoryArtifactPath('/home/user/secret')).toBeUndefined()
    expect(normalizeMemoryArtifactPath('C:\\Users\\user\\secret')).toBeUndefined()
  })

  test('requires complete bounded provenance for tracked-like generated spellings', () => {
    for (const generatedPath of [
      'generated/client.ts',
      'gen/client.ts',
      'src/client.generated.ts',
      'src/client.gen.ts',
      'src/client_generated.ts',
      'src/service_pb2.py',
      'src/schema.d.ts',
    ]) {
      expect(classifyMemoryArtifactPath(generatedPath)).toMatchObject({
        kind: 'generated',
        generated: 'tracked-like',
        allowed: false,
        reason: 'generated-provenance-required',
      })
      expect(classifyMemoryArtifactPath(generatedPath, provenance).allowed).toBe(true)
    }

    const invalidProvenance = [
      { ...provenance, generator: '' },
      { ...provenance, generator: 'g'.repeat(129) },
      { ...provenance, config: '../outside.yaml' },
      { ...provenance, sourceInputs: [] },
      { ...provenance, sourceInputs: Array.from({ length: 101 }, (_, index) => `src/${index}.ts`) },
      { ...provenance, sourceInputs: ['../outside.ts'] },
      { ...provenance, toolVersion: '' },
      { ...provenance, toolVersion: 'v'.repeat(129) },
    ]
    for (const invalid of invalidProvenance) {
      expect(classifyMemoryArtifactPath('generated/client.ts', invalid).allowed).toBe(false)
    }
    expect(isMemoryArtifactPersistenceAllowed('src/client.ts')).toBe(true)
  })

  test.each([
    '.openbuff/memory/export.json',
    '.openbuff/backups/memory.json',
    'node_modules/pkg/index.js',
    'vendor/pkg/source.go',
    '.cache/results.json',
    'logs/agent.log',
    'tmp/clone/src.ts',
    'dist/index.js',
    'build/output.js',
    '.env',
    'config/password.json',
    '.ssh/id_rsa',
    '.ssh/id_ed25519',
    'certs/server.pem',
    'certs/server.key',
    'certs/server.crt',
    'certs/server.cer',
    'certs/server.cert',
    'certs/server.der',
    'certs/server.p12',
    'certs/server.pfx',
    'keys/server.ppk',
    'assets/archive.zip',
  ])('excludes unsafe durable capture path %s even with valid generated provenance', (path) => {
    expect(classifyMemoryArtifactPath(path).allowed).toBe(false)
    expect(classifyMemoryArtifactPath(path, provenance).allowed).toBe(false)
  })
})

import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/** A sink owns only its selected root. Callers decide when that root is removed. */
export interface EvaluationArtifactSink {
  root: string
  writeJson: (filename: string, value: unknown) => string
}

export function artifactId(value: string): string {
  const slug = value.replace(/[^a-zA-Z0-9-]/g, '_').slice(0, 60) || 'id'
  return slug === value
    ? slug
    : `${slug}-${createHash('sha256').update(value).digest('hex').slice(0, 12)}`
}

export function createArtifactSink(root: string): EvaluationArtifactSink {
  fs.mkdirSync(root, { recursive: true })
  const realRoot = fs.realpathSync(root)
  return {
    root: realRoot,
    writeJson(filename, value) {
      if (
        filename !== path.basename(filename) ||
        !filename ||
        filename === '.' ||
        filename === '..' ||
        Buffer.byteLength(filename) > 240
      ) {
        throw new Error('Artifact name must be a single bounded filename')
      }
      const destination = path.join(realRoot, filename)
      const temporary = path.join(realRoot, `.writing-${randomUUID()}`)
      try {
        fs.writeFileSync(temporary, JSON.stringify(value, null, 2), {
          flag: 'wx',
        })
        // Exclusive publication: simultaneous fixtures never overwrite one another.
        fs.linkSync(temporary, destination)
      } finally {
        fs.rmSync(temporary, { force: true })
      }
      return destination
    },
  }
}

export function createRunArtifactSink(
  parent: string,
  now = new Date(),
): EvaluationArtifactSink {
  fs.mkdirSync(parent, { recursive: true })
  const prefix = `${now.toISOString().replace(/[^a-zA-Z0-9-]/g, '-')}-`
  return createArtifactSink(fs.mkdtempSync(path.join(parent, prefix)))
}

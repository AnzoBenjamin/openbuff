import fs from 'node:fs'
import matter from 'gray-matter'
import z from 'zod/v4'

import { toolNames } from '@codebuff/common/tools/constants'
import type { AgentDefinition } from '@codebuff/common/templates/initial-agents-dir/types/agent-definition'

export const MAX_MARKDOWN_AGENT_BYTES = 64 * 1024
const nativeTools = new Set<string>(toolNames)
const metadataSchema = z
  .object({
    name: z
      .string()
      .regex(/^[a-z0-9-]+$/)
      .min(1)
      .max(128),
    description: z.string().trim().min(1).max(4096),
    tools: z.union([z.array(z.string()), z.string()]).optional(),
    model: z.string().min(1).max(1024).optional(),
    max_steps: z
      .union([z.literal(-1), z.number().int().positive().max(100000)])
      .optional(),
  })
  .strict()

/** Declarative only: no imports, includes, eval, custom frontmatter engine or handleSteps. */
export function loadMarkdownAgent(filePath: string): AgentDefinition | null {
  const fd = fs.openSync(
    filePath,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  )
  let content: string
  try {
    const before = fs.fstatSync(fd)
    if (!before.isFile())
      throw new Error('Markdown agent must be a regular file')
    const bytes = Buffer.alloc(
      Math.min(before.size, MAX_MARKDOWN_AGENT_BYTES + 1),
    )
    let count = 0
    while (count < bytes.length) {
      const read = fs.readSync(fd, bytes, count, bytes.length - count, count)
      if (!read) break
      count += read
    }
    // Ordinary Markdown documentation is not an agent candidate. A declared
    // non-YAML engine must refuse instead of entering gray-matter's JS engine.
    const prefix = bytes.subarray(0, count).toString('utf8')
    if (!prefix.startsWith('---')) return null
    if (!/^---\r?\n/.test(prefix))
      throw new Error(
        'Markdown agents require plain YAML frontmatter; custom engines are not allowed',
      )
    if (before.size > MAX_MARKDOWN_AGENT_BYTES)
      throw new Error('Markdown agent exceeds the 64 KiB byte limit')
    const after = fs.fstatSync(fd)
    if (
      count !== before.size ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      throw new Error('Markdown agent changed during capture')
    content = new TextDecoder('utf-8', { fatal: true }).decode(
      bytes.subarray(0, count),
    )
  } finally {
    fs.closeSync(fd)
  }
  const parsed = matter(content)
  if (
    !Object.hasOwn(parsed.data, 'name') &&
    !Object.hasOwn(parsed.data, 'description')
  )
    return null
  if ('timeout' in parsed.data)
    throw new Error(
      'Markdown timeout enforcement is not implemented; use the host run timeout instead. The declaration was not loaded.',
    )
  const metadata = metadataSchema.parse(parsed.data)
  const tools =
    metadata.tools === undefined
      ? []
      : typeof metadata.tools === 'string'
        ? metadata.tools.split(',').map((tool) => tool.trim())
        : metadata.tools
  if (tools.some((tool) => !nativeTools.has(tool)))
    throw new Error(
      'Markdown tools must name supported native Openbuff tools; wildcards, aliases and unknown tools are refused',
    )
  if (!parsed.content.trim())
    throw new Error('Markdown agent instructions must not be empty')
  return {
    id: metadata.name,
    displayName: metadata.name,
    spawnerPrompt: metadata.description,
    ...(metadata.model ? { model: metadata.model } : {}),
    ...(metadata.max_steps !== undefined
      ? { maxSteps: metadata.max_steps }
      : {}),
    toolNames: [...new Set(tools)],
    instructionsPrompt: parsed.content,
  }
}

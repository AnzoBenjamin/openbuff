import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { once } from 'node:events'
import { finished } from 'node:stream/promises'

import type { Readable } from 'node:stream'

/** Disk-backed full output, created only when the inline output overflows. */
export class TerminalOutputSpool {
  private readonly dir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'openbuff-command-output-'),
  )
  private readonly streams = {
    stdout: fs.createWriteStream(path.join(this.dir, 'stdout'), {
      flags: 'wx',
      mode: 0o600,
    }),
    stderr: fs.createWriteStream(path.join(this.dir, 'stderr'), {
      flags: 'wx',
      mode: 0o600,
    }),
  }
  private readonly completions = Object.values(this.streams).map((stream) =>
    finished(stream).then(
      () => undefined,
      (error: unknown) => error,
    ),
  )
  private error: unknown

  constructor(stdout: string, stderr: string) {
    for (const stream of Object.values(this.streams)) {
      stream.on('error', (error) => {
        this.error = error
      })
    }
    this.streams.stdout.write(stdout)
    this.streams.stderr.write(stderr)
  }

  append(name: 'stdout' | 'stderr', text: string, source: Readable): void {
    if (this.error) return
    const stream = this.streams[name]
    if (!stream.write(text)) {
      source.pause()
      const resume = () => {
        stream.off('drain', resume)
        stream.off('error', resume)
        source.resume()
      }
      stream.once('drain', resume)
      stream.once('error', resume)
    }
  }

  async finish(metadata: Record<string, unknown>): Promise<{
    fullLogPath?: string
    logBytes?: number
    logPersisted?: false
    logError?: string
  }> {
    let output: fs.WriteStream | undefined
    let completion: Promise<unknown> | undefined
    try {
      for (const stream of Object.values(this.streams)) stream.end()
      const errors = await Promise.all(this.completions)
      if (this.error || errors.some((error) => error !== undefined))
        throw this.error ?? errors.find((error) => error !== undefined)
      const fullLogPath = path.join(this.dir, 'output.json')
      output = fs.createWriteStream(fullLogPath, { flags: 'wx', mode: 0o600 })
      completion = finished(output).then(
        () => undefined,
        (error: unknown) => error,
      )
      const write = async (text: string) => {
        if (output!.destroyed)
          throw (
            output!.errored ?? new Error('Log stream closed before completion')
          )
        if (!output!.write(text)) await once(output!, 'drain')
      }
      await write(JSON.stringify(metadata).slice(0, -1))
      for (const name of ['stdout', 'stderr'] as const) {
        await write(`,${JSON.stringify(name)}:"`)
        // Encoding on the read stream preserves characters across byte chunks.
        for await (const chunk of fs.createReadStream(
          path.join(this.dir, name),
          { encoding: 'utf8' },
        )) {
          await write(JSON.stringify(chunk).slice(1, -1))
        }
        await write('"')
      }
      output.end('}')
      const error = await completion
      if (error !== undefined) throw error
      const logBytes = (await fs.promises.stat(fullLogPath)).size
      await Promise.all(
        ['stdout', 'stderr'].map((name) =>
          fs.promises.unlink(path.join(this.dir, name)),
        ),
      )
      return { fullLogPath, logBytes }
    } catch (error) {
      for (const stream of Object.values(this.streams)) stream.destroy()
      output?.destroy()
      await Promise.all([...this.completions, completion])
      await fs.promises
        .rm(this.dir, { recursive: true, force: true })
        .catch(() => {})
      return {
        logPersisted: false,
        logError: `Full command output could not be saved: ${error instanceof Error ? error.message : String(error)}. Only the bounded inline output remains.`,
      }
    }
  }

  async discard(): Promise<void> {
    for (const stream of Object.values(this.streams)) stream.destroy()
    await Promise.all(this.completions)
    await fs.promises
      .rm(this.dir, { recursive: true, force: true })
      .catch(() => {})
  }
}

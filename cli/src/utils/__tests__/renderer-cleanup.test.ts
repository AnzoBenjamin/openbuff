import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'

const cleanupModule = new URL('../renderer-cleanup.ts', import.meta.url)
  .pathname

for (const mode of ['signal', 'error', 'normal'] as const) {
  test(`${mode} exit waits for native output to drain and destroys once`, () => {
    const child = spawnSync(
      process.execPath,
      [
        '-e',
        `
      import { installProcessCleanupHandlers, cleanupRenderer } from ${JSON.stringify(cleanupModule)}
      let resolveClosed
      let destroys = 0
      const closed = new Promise(resolve => resolveClosed = resolve)
      const renderer = {
        isDestroyed: false,
        closed,
        destroy() {
          this.isDestroyed = true
          destroys++
          setTimeout(() => {
            console.log('native output drained', destroys)
            resolveClosed()
          }, 30)
        },
      }
      installProcessCleanupHandlers(renderer)
      if (${JSON.stringify(mode)} === 'signal') {
        process.emit('SIGTERM')
        process.emit('SIGTERM')
      } else if (${JSON.stringify(mode)} === 'error') {
        process.emit('uncaughtException', new Error('fixture failure'))
      } else {
        await Promise.all([cleanupRenderer(), cleanupRenderer()])
        console.log('normal exit')
        process.exit(0)
      }
    `,
      ],
      { encoding: 'utf8', timeout: 5000 },
    )
    expect(child.error).toBeUndefined()
    expect(child.status).toBe(mode === 'error' ? 1 : 0)
    expect(child.stdout).toContain('native output drained 1')
    if (mode === 'error') expect(child.stderr).toContain('fixture failure')
    if (mode === 'normal')
      expect(child.stdout.indexOf('normal exit')).toBeGreaterThan(
        child.stdout.indexOf('native output drained'),
      )
  })
}

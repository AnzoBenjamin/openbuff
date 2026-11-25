import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { setProjectRoot } from '../../project-files'
import {
  getActivePlanSessionSlug,
  listPlanSessions,
  listPlanSessionsAsync,
  readBoundedArtifact,
  readBoundedArtifactSync,
  readPlanArtifactPage,
  readPlanArtifacts,
  readPlanSessionState,
  planCatalogWarning,
} from '../plan-artifacts'
import { formatPlanListReport, planListActiveState } from '../command-registry'

let root: string, outside: string, session: string
const secret = 'OUTSIDE-ARTIFACT-CANARY-never-disclose'
beforeEach(() => {
  root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'plan-artifact-boundary-')),
  )
  outside = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'plan-artifact-outside-')),
  )
  session = path.join(root, '.agents', 'sessions', 'safe')
  fs.mkdirSync(session, { recursive: true })
  fs.writeFileSync(
    path.join(session, 'PLAN.md'),
    '# Safe plan\n- [ ] A safe task\n',
  )
  fs.writeFileSync(path.join(outside, 'PLAN.md'), secret)
  fs.writeFileSync(path.join(outside, 'credentials.json'), secret)
  setProjectRoot(root)
})
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
  fs.rmSync(outside, { recursive: true, force: true })
})

describe('physical plan artifact boundaries', () => {
  for (const name of ['PLAN.md', 'credentials.json']) {
    test(`prefix/page/resume refuse an artifact symlink to outside ${name}`, async () => {
      const target = path.join(session, 'PLAN.md')
      fs.unlinkSync(target)
      fs.symlinkSync(path.join(outside, name), target)
      expect(() => readBoundedArtifactSync(target)).toThrow()
      await expect(readBoundedArtifact(target)).rejects.toThrow()
      expect(readPlanArtifacts('safe')).toBeNull()
      const page = await readPlanArtifactPage('safe', 'PLAN.md').catch(
        (error) => String(error),
      )
      expect(page).not.toContain(secret)
      expect(page).toMatch(/refus|unavailable|unsafe|contain|symlink/i)
    })
  }
  for (const component of ['session', 'sessions-root', 'agents-root']) {
    test(`prefix/page/resume reject a symlinked ${component}`, async () => {
      const replaced =
        component === 'session'
          ? session
          : component === 'sessions-root'
            ? path.dirname(session)
            : path.dirname(path.dirname(session))
      const destination =
        component === 'session'
          ? outside
          : component === 'sessions-root'
            ? path.join(outside, 'sessions')
            : path.join(outside, 'agents')
      if (component !== 'session') {
        const leaf =
          component === 'sessions-root'
            ? path.join(destination, 'safe')
            : path.join(destination, 'sessions', 'safe')
        fs.mkdirSync(leaf, { recursive: true })
        fs.writeFileSync(path.join(leaf, 'PLAN.md'), secret)
      }
      fs.renameSync(replaced, `${replaced}-original`)
      fs.symlinkSync(destination, replaced, 'dir')
      expect(readPlanArtifacts('safe')).toBeNull()
      expect(() =>
        readBoundedArtifactSync(path.join(session, 'PLAN.md')),
      ).toThrow()
      const page = await readPlanArtifactPage('safe', 'PLAN.md').catch(
        (error) => String(error),
      )
      expect(page).not.toContain(secret)
    })
  }

  test('open-time parent replacement never reads bytes through the replacement path', () => {
    const open = fs.openSync
    let swapped = false
    const spy = spyOn(fs, 'openSync').mockImplementation(((
      file: fs.PathLike,
      flags: fs.OpenMode,
      mode?: fs.Mode,
    ) => {
      if (!swapped && String(file).endsWith('/PLAN.md')) {
        swapped = true
        fs.renameSync(session, `${session}-original`)
        fs.symlinkSync(outside, session, 'dir')
      }
      return open(file, flags, mode)
    }) as typeof fs.openSync)
    try {
      let text = ''
      try {
        text = readBoundedArtifactSync(path.join(session, 'PLAN.md')).text
      } catch {
        /* refusal is safe */
      }
      expect(swapped).toBe(true)
      expect(text).not.toContain(secret)
      if (text) expect(text).toContain('Safe plan')
    } finally {
      spy.mockRestore()
    }
  })

  test('async open-time parent replacement does not disclose outside bytes', async () => {
    const open = fs.promises.open
    let swapped = false
    const spy = spyOn(fs.promises, 'open').mockImplementation((async (
      ...args: Parameters<typeof fs.promises.open>
    ) => {
      if (!swapped && String(args[0]).endsWith('/PLAN.md')) {
        swapped = true
        fs.renameSync(session, `${session}-original`)
        fs.symlinkSync(outside, session, 'dir')
      }
      return open(...args)
    }) as typeof fs.promises.open)
    try {
      const page = await readPlanArtifactPage('safe', 'PLAN.md').catch(
        (error) => String(error),
      )
      expect(swapped).toBe(true)
      expect(page).not.toContain(secret)
    } finally {
      spy.mockRestore()
    }
  })

  test('non-artifact absolute paths and special files are not plan captures', () => {
    expect(() =>
      readBoundedArtifactSync(path.join(outside, 'PLAN.md')),
    ).toThrow()
    expect(() => readBoundedArtifactSync('/dev/null')).toThrow()
  })

  test('state and active-pointer readers never reopen unverified symlinks', () => {
    fs.writeFileSync(
      path.join(outside, 'STATE.json'),
      JSON.stringify({
        status: 'completed',
        currentTask: secret,
        updatedAt: '2024-01-01T00:00:00Z',
      }),
    )
    fs.symlinkSync(
      path.join(outside, 'STATE.json'),
      path.join(session, 'STATE.json'),
    )
    fs.writeFileSync(path.join(outside, 'ACTIVE_SESSION'), 'outside-selected')
    fs.symlinkSync(
      path.join(outside, 'ACTIVE_SESSION'),
      path.join(root, '.agents', 'ACTIVE_SESSION'),
    )
    expect(readPlanSessionState('safe')).toBeNull()
    expect(getActivePlanSessionSlug()).toBeNull()
  })

  test('hard-linked aliases cannot disclose an outside file under a plan basename', () => {
    const target = path.join(session, 'PLAN.md')
    fs.unlinkSync(target)
    fs.linkSync(path.join(outside, 'PLAN.md'), target)
    expect(() => readBoundedArtifactSync(target)).toThrow()
    expect(readPlanArtifacts('safe')).toBeNull()
  })

  test('a path replacement after the descriptor is opened keeps the original capture', () => {
    const open = fs.openSync
    let changed = false
    const spy = spyOn(fs, 'openSync').mockImplementation(((
      file: fs.PathLike,
      flags: fs.OpenMode,
      mode?: fs.Mode,
    ) => {
      const fd = open(file, flags, mode)
      if (!changed && String(file).endsWith('/PLAN.md')) {
        changed = true
        fs.renameSync(
          path.join(session, 'PLAN.md'),
          path.join(session, 'PLAN.original'),
        )
        fs.symlinkSync(
          path.join(outside, 'PLAN.md'),
          path.join(session, 'PLAN.md'),
        )
      }
      return fd
    }) as typeof fs.openSync)
    try {
      let captured = ''
      try {
        captured = readBoundedArtifactSync(path.join(session, 'PLAN.md')).text
      } catch {
        /* conservative refusal */
      }
      expect(changed).toBe(true)
      expect(captured).not.toContain(secret)
      if (captured) expect(captured).toContain('Safe plan')
    } finally {
      spy.mockRestore()
    }
  })

  test('sync and async catalogs reject hardlinked non-PLAN artifacts with partial coverage', async () => {
    const bad = path.join(root, '.agents', 'sessions', 'hardlinked')
    fs.mkdirSync(bad)
    fs.linkSync(path.join(outside, 'PLAN.md'), path.join(bad, 'SPEC.md'))
    const asyncRows = await listPlanSessionsAsync()
    const syncRows = listPlanSessions()
    for (const rows of [asyncRows, syncRows]) {
      expect(rows.map((row) => row.slug)).toContain('safe')
      expect(rows.map((row) => row.slug)).not.toContain('hardlinked')
      expect(rows.partial).toBe(true)
      expect(rows.skipped).toBe(1)
    }
  })

  test('one unreadable catalog row retains valid sessions and discloses partial coverage', async () => {
    const failed = path.join(root, '.agents', 'sessions', 'unreadable')
    fs.mkdirSync(failed)
    fs.writeFileSync(path.join(failed, 'PLAN.md'), 'not readable')
    const open = fs.openSync,
      openAsync = fs.promises.open
    const denied = () =>
      Object.assign(new Error('Injected owned row EACCES'), { code: 'EACCES' })
    const sync = spyOn(fs, 'openSync').mockImplementation(((
      file: fs.PathLike,
      flags: fs.OpenMode,
      mode?: fs.Mode,
    ) => {
      const rendered = String(file)
      if (rendered.endsWith('/unreadable') || rendered.includes('/unreadable/'))
        throw denied()
      return open(file, flags, mode)
    }) as typeof fs.openSync)
    const async = spyOn(fs.promises, 'open').mockImplementation((async (
      ...args: Parameters<typeof fs.promises.open>
    ) => {
      if (String(args[0]).includes('/unreadable/')) throw denied()
      return openAsync(...args)
    }) as typeof fs.promises.open)
    try {
      const rows = await listPlanSessionsAsync()
      expect(rows.map((row) => row.slug)).toContain('safe')
      expect(rows.map((row) => row.slug)).not.toContain('unreadable')
      expect((rows as typeof rows & { partial?: boolean }).partial).toBe(true)
      expect(planCatalogWarning(rows)).toContain('skipped 1')
      expect(formatPlanListReport(rows, planListActiveState(rows))).toContain(
        'Plan sessions partial',
      )
      const syncRows = listPlanSessions()
      expect(syncRows.map((row) => row.slug)).toContain('safe')
      expect(
        (syncRows as typeof syncRows & { partial?: boolean }).partial,
      ).toBe(true)
    } finally {
      sync.mockRestore()
      async.mockRestore()
    }
  })
})

#!/usr/bin/env bun
/**
 * Offline append-only provenance policy over the actual event commit range.
 * This checks immutability and dedicated introductions, not human approval or
 * upstream authenticity. The existing offline guard reconciles all manifests
 * and the lockfile; the upstream source review remains a separate reviewed diff.
 */
import { spawnSync } from 'node:child_process'
import { isDeepStrictEqual } from 'node:util'
import {
  canonicalTarball,
  DEPRECATION_EXCEPTIONS,
  isAllowedLicense,
  parseLockIntegrities,
  PROVENANCE_RECORD_PATH,
  REGISTRY_ORIGIN,
} from './dependency-provenance-guard'
import type { ProvenanceRecord } from './dependency-provenance-guard'

const ZERO_SHA = /^0{40}$|^0{64}$/
const COMMIT_SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/

type Finding = { commit: string; message: string }
type Range = { base: string | null; head: string; mode: string }
export type ProvenanceChangeEvent = {
  eventName: 'pull_request' | 'push'
  head: string
  base?: string
  before?: string
  defaultBase?: string
  /** Explicit empty-history bootstrap, never a guessed commit parent. */
  initialHistory?: boolean
}

function git(root: string, args: string[]): string {
  const result = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  })
  if (result.status !== 0)
    throw new Error(
      `git ${args[0]} failed: ${result.stderr.trim() || result.error?.message}`,
    )
  // NUL-delimited path names may themselves consist of whitespace.
  return args.includes('-z') ? result.stdout : result.stdout.trim()
}

function commit(root: string, sha: string | undefined): string {
  if (!sha || !COMMIT_SHA.test(sha) || ZERO_SHA.test(sha))
    throw new Error('A nonzero full commit SHA is required.')
  return git(root, ['rev-parse', '--verify', `${sha}^{commit}`])
}

export function selectProvenanceRange(
  root: string,
  event: ProvenanceChangeEvent,
): Range {
  const head = commit(root, event.head)
  if (event.eventName === 'pull_request') {
    if (event.initialHistory)
      throw new Error(
        'Empty-history mode is only valid for a zero-before push.',
      )
    return { base: commit(root, event.base), head, mode: 'pull_request' }
  }
  if (!event.before || !COMMIT_SHA.test(event.before))
    throw new Error(
      'Push events must supply the exact before SHA, including zero on branch creation.',
    )
  if (!ZERO_SHA.test(event.before)) {
    if (event.initialHistory)
      throw new Error('Empty-history mode requires a zero-before push.')
    return { base: commit(root, event.before), head, mode: 'push' }
  }
  if (event.initialHistory) return { base: null, head, mode: 'initial_history' }
  const defaultBase = commit(root, event.defaultBase)
  let base: string
  try {
    base = git(root, ['merge-base', defaultBase, head])
  } catch {
    throw new Error(
      'The new branch has no merge-base with the explicitly fetched default branch.',
    )
  }
  return { base, head, mode: 'new_branch' }
}

function readRecord(root: string, sha: string): ProvenanceRecord | null {
  const present = git(root, [
    'ls-tree',
    '--name-only',
    sha,
    '--',
    PROVENANCE_RECORD_PATH,
  ])
  if (!present) return null
  const value: unknown = JSON.parse(
    git(root, ['show', `${sha}:${PROVENANCE_RECORD_PATH}`]),
  )
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${sha}: provenance must be an object.`)
  const item = value as Record<string, unknown>
  if (
    typeof item.source !== 'string' ||
    typeof item.verifiedAt !== 'string' ||
    !item.packages ||
    typeof item.packages !== 'object' ||
    Array.isArray(item.packages)
  )
    throw new Error(
      `${sha}: provenance source, verifiedAt and packages are required.`,
    )
  return value as ProvenanceRecord
}

function appendOnly(
  before: ProvenanceRecord | null,
  after: ProvenanceRecord | null,
): string[] {
  if (!after) return before ? ['The provenance record was deleted.'] : []
  const findings: string[] = []
  if (after.source !== REGISTRY_ORIGIN)
    findings.push(
      'The provenance source must remain the canonical public registry.',
    )
  const time = new Date(after.verifiedAt)
  if (
    !Number.isFinite(time.getTime()) ||
    time.toISOString() !== after.verifiedAt
  )
    findings.push('verifiedAt must be a canonical ISO UTC timestamp.')
  if (before) {
    const identity = (record: ProvenanceRecord) =>
      Object.fromEntries(
        Object.entries(record).filter(
          ([key]) => key !== 'packages' && key !== 'verifiedAt',
        ),
      )
    if (!isDeepStrictEqual(identity(before), identity(after)))
      findings.push(
        'Provenance source/schema identity fields were changed, added or removed.',
      )
    for (const [spec, entry] of Object.entries(before.packages)) {
      if (!Object.hasOwn(after.packages, spec))
        findings.push(`${spec}: an existing release was deleted.`)
      else if (!isDeepStrictEqual(entry, after.packages[spec]))
        findings.push(`${spec}: an existing release identity was rewritten.`)
    }
  } else if (
    Object.keys(after).some(
      (key) => !['source', 'verifiedAt', 'packages'].includes(key),
    )
  ) {
    findings.push(
      'An initial record must use the existing source/verifiedAt/packages schema.',
    )
  }
  return findings
}

function validateAddedRelease(
  spec: string,
  value: unknown,
  lock: Map<string, string>,
): string[] {
  const separator = spec.lastIndexOf('@')
  const name = spec.slice(0, separator)
  const version = spec.slice(separator + 1)
  if (
    separator <= 0 ||
    !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(name) ||
    !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9.-]+)?$/.test(version)
  )
    return [`${spec}: invalid package release identity.`]
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return [`${spec}: the new entry must be an object.`]
  const entry = value as Record<string, unknown>
  const findings: string[] = []
  if (
    !isDeepStrictEqual(Object.keys(entry).sort(), [
      'deprecated',
      'integrity',
      'license',
      'tarball',
    ])
  )
    findings.push(
      `${spec}: the new entry must use the existing release schema.`,
    )
  if (entry.tarball !== canonicalTarball(name, version))
    findings.push(`${spec}: tarball URL is not canonical.`)
  if (
    typeof entry.license !== 'string' ||
    !isAllowedLicense(entry.license, spec)
  )
    findings.push(`${spec}: license is not allowed by the existing policy.`)
  if (
    typeof entry.deprecated !== 'boolean' ||
    (entry.deprecated && !DEPRECATION_EXCEPTIONS.has(spec))
  )
    findings.push(`${spec}: deprecation status is missing or unreviewed.`)
  const integrity = typeof entry.integrity === 'string' ? entry.integrity : ''
  const bytes = integrity.startsWith('sha512-')
    ? Buffer.from(integrity.slice(7), 'base64')
    : Buffer.alloc(0)
  if (bytes.length !== 64 || `sha512-${bytes.toString('base64')}` !== integrity)
    findings.push(`${spec}: integrity must be canonical SHA-512 SRI.`)
  if (lock.get(spec) !== integrity)
    findings.push(
      `${spec}: integrity does not reconcile with the head lockfile.`,
    )
  return findings
}

export function checkProvenanceChanges(
  root: string,
  event: ProvenanceChangeEvent,
) {
  const range = selectProvenanceRange(root, event)
  const revisions = git(root, [
    'rev-list',
    '--reverse',
    '--topo-order',
    range.base ? `${range.base}..${range.head}` : range.head,
    '--',
  ])
    .split('\n')
    .filter(Boolean)
  const cache = new Map<string, ProvenanceRecord | null>()
  const recordAt = (sha: string) => {
    if (!cache.has(sha)) cache.set(sha, readRecord(root, sha))
    return cache.get(sha)!
  }
  const findings: Finding[] = []
  const checkedCommits: Array<{
    commit: string
    parents: string[]
    added: string[]
    inheritedMerge: boolean
  }> = []
  let lock: Map<string, string> | undefined
  const addFindings = (sha: string, messages: string[]) =>
    findings.push(...messages.map((message) => ({ commit: sha, message })))
  if (range.base)
    addFindings(
      range.head,
      appendOnly(recordAt(range.base), recordAt(range.head)),
    )
  for (const sha of revisions) {
    const parents = git(root, ['show', '-s', '--format=%P', sha])
      .split(' ')
      .filter(Boolean)
    const changedPaths = parents.length
      ? parents.map((parent) =>
          git(root, ['diff', '--name-only', '-z', parent, sha, '--'])
            .split('\0')
            .filter(Boolean),
        )
      : [
          git(root, [
            'diff-tree',
            '--root',
            '-r',
            '--no-commit-id',
            '--name-only',
            '-z',
            sha,
            '--',
          ])
            .split('\0')
            .filter(Boolean),
        ]
    if (!changedPaths.some((paths) => paths.includes(PROVENANCE_RECORD_PATH)))
      continue
    const after = recordAt(sha)
    const before = parents.length ? parents.map(recordAt) : [null]
    for (const parent of before) addFindings(sha, appendOnly(parent, after))
    const inherited = new Set(
      before.flatMap((parent) => Object.keys(parent?.packages ?? {})),
    )
    const added = Object.keys(after?.packages ?? {}).filter(
      (spec) => !inherited.has(spec),
    )
    const inheritedMerge =
      parents.length > 1 &&
      added.length === 0 &&
      before.some((parent) => parent?.verifiedAt === after?.verifiedAt)
    if (
      !inheritedMerge &&
      changedPaths.some((paths) =>
        paths.some((path) => path !== PROVENANCE_RECORD_PATH),
      )
    ) {
      addFindings(sha, [
        'Provenance introductions/updates require a dedicated record-only commit; source or other files changed in the same commit.',
      ])
    }
    if (added.length) {
      lock ??= parseLockIntegrities(
        git(root, ['show', `${range.head}:bun.lock`]),
      )
      for (const spec of added)
        addFindings(
          sha,
          validateAddedRelease(spec, after!.packages[spec], lock),
        )
    }
    checkedCommits.push({ commit: sha, parents, added, inheritedMerge })
  }
  return { ...range, checkedCommits, findings }
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2)
    const argument = (name: string) => {
      const at = args.indexOf(name)
      return at < 0 ? undefined : args[at + 1]
    }
    const eventName = argument('--event')
    if (eventName !== 'pull_request' && eventName !== 'push')
      throw new Error('Only pull_request and push event ranges are supported.')
    const report = checkProvenanceChanges(process.cwd(), {
      eventName,
      head: argument('--head') ?? '',
      base: argument('--base'),
      before: argument('--before'),
      defaultBase: argument('--default-base'),
      initialHistory: args.includes('--initial-history'),
    })
    console.log(JSON.stringify(report, null, 2))
    // Keep the actual record diffs reviewable in CI, including merge inheritance.
    for (const item of report.checkedCommits) {
      if (item.parents.length) {
        for (const parent of item.parents)
          console.log(
            git(process.cwd(), [
              'diff',
              '--no-ext-diff',
              parent,
              item.commit,
              '--',
              PROVENANCE_RECORD_PATH,
            ]),
          )
      } else
        console.log(
          git(process.cwd(), [
            'show',
            '--format=fuller',
            '--no-ext-diff',
            item.commit,
            '--',
            PROVENANCE_RECORD_PATH,
          ]),
        )
    }
    process.exitCode = report.findings.length ? 1 : 0
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}

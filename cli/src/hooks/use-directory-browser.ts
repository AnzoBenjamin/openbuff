import { realpathSync, statSync } from 'fs'
import os from 'os'
import path from 'path'
import { useCallback, useEffect, useState } from 'react'
import {
  readDirectoryListing,
  hasGitDirectoryAsync,
  type DirectoryEntry,
} from '../utils/directory-browser'

export interface UseDirectoryBrowserOptions {
  initialPath?: string
  dependencies?: {
    list: typeof readDirectoryListing
    git: typeof hasGitDirectoryAsync
    canonical: (value: string) => string
    isDirectory: (value: string) => boolean
  }
}
const DEFAULT_DEPENDENCIES = {
  list: readDirectoryListing,
  git: hasGitDirectoryAsync,
  canonical: realpathSync,
  isDirectory: (value: string) => statSync(value).isDirectory(),
}
export interface UseDirectoryBrowserReturn {
  currentPath: string
  setCurrentPath: (value: string) => void
  directories: DirectoryEntry[]
  isGitRepo: boolean
  loadState: 'loading' | 'ready' | 'partial' | 'error'
  error: string | undefined
  retry: () => void
  clearError: () => void
  expandPath: (value: string) => string
  tryNavigateToPath: (value: string) => boolean
  navigateToDirectory: (entry: DirectoryEntry) => void
}

export function useDirectoryBrowser({
  initialPath,
  dependencies = DEFAULT_DEPENDENCIES,
}: UseDirectoryBrowserOptions = {}): UseDirectoryBrowserReturn {
  const [currentPath, updateCurrentPath] = useState(initialPath ?? os.homedir())
  const [listing, setListing] = useState<{
    path: string
    entries: DirectoryEntry[]
    state: 'loading' | 'ready' | 'partial' | 'error'
    error?: string
  }>({ path: currentPath, entries: [], state: 'loading' })
  const [navigationError, setNavigationError] = useState<string>()
  const [isGitRepo, setIsGitRepo] = useState(false)
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    setListing({ path: currentPath, entries: [], state: 'loading' })
    setIsGitRepo(false)
    void dependencies
      .list(currentPath, {
        signal: controller.signal,
        onEntries: (entries) => {
          if (!controller.signal.aborted)
            setListing({ path: currentPath, entries, state: 'partial' })
        },
      })
      .then((result) => {
        if (!controller.signal.aborted)
          setListing({
            path: currentPath,
            entries: result.entries,
            state: result.state,
            error: result.omitted
              ? `${result.omitted} entries could not be read`
              : undefined,
          })
      })
      .catch((error) => {
        if (!controller.signal.aborted)
          setListing({
            path: currentPath,
            entries: [],
            state: 'error',
            error: error instanceof Error ? error.message : String(error),
          })
      })
    void dependencies
      .git(currentPath)
      .then((value) => {
        if (!controller.signal.aborted) setIsGitRepo(value)
      })
      .catch(() => {})
    return () => controller.abort()
  }, [currentPath, revision, dependencies])
  const expandPath = useCallback(
    (value: string) =>
      value === '~' || value.startsWith('~/') || value.startsWith('~\\')
        ? path.join(os.homedir(), value.slice(1))
        : value,
    [],
  )
  const setCurrentPath = useCallback(
    (value: string) => {
      try {
        const candidate = path.resolve(currentPath, expandPath(value.trim()))
        if (!dependencies.isDirectory(candidate))
          throw new Error('This path is not a directory.')
        updateCurrentPath(dependencies.canonical(candidate))
        setNavigationError(undefined)
      } catch (error) {
        setNavigationError(
          `Could not open ${value}: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    },
    [currentPath, dependencies, expandPath],
  )
  const tryNavigateToPath = useCallback(
    (value: string) => {
      try {
        const candidate = path.resolve(currentPath, expandPath(value.trim()))
        if (!dependencies.isDirectory(candidate))
          throw new Error('This path is not a directory.')
        updateCurrentPath(dependencies.canonical(candidate))
        setNavigationError(undefined)
        return true
      } catch (error) {
        setNavigationError(
          `Could not open ${value}: ${error instanceof Error ? error.message : String(error)}`,
        )
        return false
      }
    },
    [currentPath, dependencies, expandPath],
  )
  const currentListing =
    listing.path === currentPath
      ? listing
      : { entries: [], state: 'loading' as const, error: undefined }
  return {
    currentPath,
    setCurrentPath,
    directories: currentListing.entries,
    isGitRepo,
    loadState: currentListing.state,
    error: navigationError ?? currentListing.error,
    retry: () => {
      setNavigationError(undefined)
      setRevision((value) => value + 1)
    },
    clearError: () => setNavigationError(undefined),
    expandPath,
    tryNavigateToPath,
    navigateToDirectory: (entry) => {
      setCurrentPath(entry.path)
    },
  }
}

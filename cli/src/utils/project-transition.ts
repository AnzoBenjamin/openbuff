/** Keep project preparation transactional; a failure restores the old context. */
export async function transitionProject(options: {
  previousRoot: string
  targetRoot: string
  switchContext: (root: string) => Promise<void>
  prepare: () => Promise<void>
  recover: () => Promise<void>
}): Promise<
  | { status: 'opened' }
  | { status: 'failed'; error: unknown; recoveryError?: unknown }
> {
  try {
    await options.switchContext(options.targetRoot)
    await options.prepare()
    return { status: 'opened' }
  } catch (error) {
    try {
      await options.switchContext(options.previousRoot)
      await options.recover()
      return { status: 'failed', error }
    } catch (recoveryError) {
      return { status: 'failed', error, recoveryError }
    }
  }
}

export function createProjectTreeRequests() {
  let generation = 0
  return {
    begin: (root: string) => ({ root, generation: ++generation }),
    invalidate: () => {
      generation++
    },
    accepts: (
      request: { root: string; generation: number },
      currentRoot: string,
    ) => request.generation === generation && request.root === currentRoot,
  }
}

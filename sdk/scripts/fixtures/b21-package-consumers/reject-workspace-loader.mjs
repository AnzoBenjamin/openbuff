import { realpathSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const isWithin = (parent, candidate) => {
  const relative = path.relative(parent, candidate)
  return (
    relative === '' ||
    (relative !== '..' &&
      !relative.startsWith('..' + path.sep) &&
      !path.isAbsolute(relative))
  )
}

export async function resolve(specifier, context, nextResolve) {
  if (
    /^@(codebuff|openbuff)\//.test(specifier) &&
    !['@openbuff/sdk', '@openbuff/sdk/package.json'].includes(specifier)
  ) {
    throw new Error('Workspace package import is forbidden: ' + specifier)
  }
  const result = await nextResolve(specifier, context)
  const workspace = process.env.B21_WORKSPACE_ROOT
  if (workspace && result.url.startsWith('file:')) {
    const realResolved = realpathSync(fileURLToPath(result.url))
    const realWorkspace = realpathSync(workspace)
    const allowedHosts = [
      ...(process.env.B21_ALLOWED_HOST_ROOT
        ? [process.env.B21_ALLOWED_HOST_ROOT]
        : []),
      ...(process.env.B21_ALLOWED_HOST_ROOTS ?? '')
        .split(path.delimiter)
        .filter(Boolean),
    ].map((allowedHost) => realpathSync(allowedHost))
    if (allowedHosts.some((allowedHost) => !isWithin(realWorkspace, allowedHost))) {
      throw new Error('Allowed hosts must remain inside the checkout')
    }
    if (
      isWithin(realWorkspace, realResolved) &&
      !allowedHosts.some((allowedHost) => isWithin(allowedHost, realResolved))
    ) {
      throw new Error('Checkout import is forbidden: ' + result.url)
    }
  }
  return result
}

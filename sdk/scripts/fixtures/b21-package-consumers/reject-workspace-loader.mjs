import { fileURLToPath } from 'node:url'

export async function resolve(specifier, context, nextResolve) {
  if (/^@(codebuff|openbuff)\//.test(specifier) &&
      !['@openbuff/sdk', '@openbuff/sdk/package.json'].includes(specifier)) {
    throw new Error('Workspace package import is forbidden: ' + specifier)
  }
  const result = await nextResolve(specifier, context)
  const workspace = process.env.B21_WORKSPACE_ROOT
  if (workspace && result.url.startsWith('file:') &&
      fileURLToPath(result.url).startsWith(workspace + '/')) {
    throw new Error('Checkout import is forbidden: ' + result.url)
  }
  return result
}

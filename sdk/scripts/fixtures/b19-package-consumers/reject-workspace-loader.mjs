import { fileURLToPath } from 'node:url'

// A linked third-party dependency may resolve its own installed dependencies.
// The SDK itself must resolve from its extracted tarball, never workspace src.
export async function resolve(specifier, context, nextResolve) {
  if (/^@(codebuff|openbuff)\//.test(specifier) && !['@openbuff/sdk', '@openbuff/sdk/package.json'].includes(specifier)) {
    throw new Error('Workspace package import is forbidden: ' + specifier)
  }
  const result = await nextResolve(specifier, context)
  if (result.url.startsWith('file:')) {
    const file = fileURLToPath(result.url), workspace = process.env.B19_WORKSPACE_ROOT
    if (workspace && file.startsWith(workspace + '/') && !file.startsWith(workspace + '/node_modules/') && !file.startsWith(workspace + '/sdk/node_modules/')) {
      throw new Error('Workspace source import is forbidden: ' + file)
    }
  }
  return result
}

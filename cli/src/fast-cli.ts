import { createRequire } from 'node:module'

import { getCliEnv } from './utils/env'

const require = createRequire(import.meta.url)

function getCliVersion(): string {
  const compiledVersion = getCliEnv().CODEBUFF_CLI_VERSION
  if (compiledVersion) return compiledVersion

  try {
    const packageJson = require('../package.json') as { version?: string }
    return packageJson.version ?? 'dev'
  } catch {
    return 'dev'
  }
}

function isHelpDisplayed(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'commander.helpDisplayed'
  )
}

/** Handle lightweight version/help requests before loading the TUI and SDK. */
export async function runFastCliPath(argv: string[]): Promise<boolean> {
  const userArgs = argv.slice(2)
  if (
    userArgs.length === 1 &&
    (userArgs[0] === '--version' || userArgs[0] === '-v')
  ) {
    console.log(getCliVersion())
    return true
  }

  if (userArgs.includes('--help') || userArgs.includes('-h')) {
    const { parseCliArgs } = await import('./cli-args')
    try {
      parseCliArgs(argv, { version: getCliVersion(), exitOverride: true })
    } catch (error) {
      if (isHelpDisplayed(error)) return true
      throw error
    }
    return true
  }

  return false
}

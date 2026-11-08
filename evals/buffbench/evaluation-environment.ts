import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export type EvaluationExecutionScope = 'trusted_task' | 'key_free_environment'

/** Environment isolation only. This grants no OS filesystem/network confinement. */
export async function withEvaluationEnvironment<T>(
  scope: EvaluationExecutionScope,
  supplied: Readonly<Record<string, string | undefined>> | undefined,
  operation: (env: Record<string, string>) => Promise<T>,
  capturedInheritance: Readonly<Record<string, string | undefined>> = {
    ...process.env,
  },
): Promise<T> {
  if (scope === 'trusted_task') {
    return operation(
      Object.fromEntries(
        Object.entries({ ...capturedInheritance, ...supplied }).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      ),
    )
  }
  if (
    Object.entries(supplied ?? {}).some(([name, value]) =>
      value !== undefined &&
      /(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|SECRET|PASSWORD|CREDENTIALS)$/i.test(name),
    )
  ) {
    throw new Error(
      'Key-free evaluation refuses explicitly supplied credentials',
    )
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'buffbench-key-free-'))
  const home = path.join(root, 'home')
  fs.mkdirSync(home)
  try {
    const environment = {
      PATH: '/usr/local/bin:/usr/bin:/bin',
      ...supplied,
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: path.join(home, '.config'),
      XDG_CACHE_HOME: path.join(home, '.cache'),
      XDG_DATA_HOME: path.join(home, '.local', 'share'),
      TMPDIR: root,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'),
    }
    return await operation(
      Object.fromEntries(
        Object.entries(environment).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      ),
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

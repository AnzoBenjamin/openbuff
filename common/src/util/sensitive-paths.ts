import path from 'node:path'

const SENSITIVE_EXTENSIONS = new Set([
  '.pem',
  '.key',
  '.p12',
  '.pfx',
  '.jks',
  '.keystore',
])
const SENSITIVE_BASENAMES = new Set([
  '.htpasswd',
  '.netrc',
  'credentials',
  // openbuff/cloud-CLI credential files: the openbuff global config directory
  // stores OAuth access/refresh tokens and the default API key in
  // `<configDir>/credentials.json` (see `sdk/src/credentials.ts`). Listed as
  // exact basenames rather than a `credentials.*` pattern so a repository doc
  // named `credentials.md` stays readable. `isMandatorySensitiveReadPath` is
  // basename-driven and case-normalized, so entries must be lowercase.
  'credentials.json',
  'credentials.yaml',
  'credentials.yml',
  '.npmrc',
  'auth.json',
  '.pypirc',
  'terraform.tfvars',
  '.terraformrc',
])
const ENV_TEMPLATE_SUFFIXES = ['.env.example', '.env.sample', '.env.template']
const AGENT_SESSION_ARTIFACT_BASENAMES = new Set([
  'spec.md',
  'plan.md',
  'status.md',
  'lessons.md',
  'state.json',
  'audit-report.md',
])

function toPortablePath(value: string): string {
  return value.split(path.sep).join('/').replace(/^\.\//, '')
}

export function isEnvTemplatePath(filePath: string): boolean {
  const basename = path.posix.basename(toPortablePath(filePath).toLowerCase())
  return ENV_TEMPLATE_SUFFIXES.some((suffix) => basename.endsWith(suffix))
}

// Basename suffixes that make a `credentials`-bearing name a machine-readable
// credential store rather than documentation. `credentials.md` /
// `credentials.txt` deliberately stay readable.
const CREDENTIAL_BASENAME_SUFFIXES = ['.json', '.yaml', '.yml']
// gcloud application default credentials. Subsumed by the general rule below,
// but pinned explicitly because it is the single most common cloud credential
// carrier an allowlisted home-directory root would expose.
const APPLICATION_DEFAULT_CREDENTIALS_PATTERN =
  /^application_default_credentials\.json$/

/**
 * True for a basename that carries `credentials` AND a structured-data
 * extension (`application_default_credentials.json`, `gcloud_credentials.json`,
 * `credentials.yml`, ...). Deliberately narrower than `credentials.*` so
 * repository docs named `credentials.md` / `credentials.txt` stay readable.
 */
function isCredentialBasename(basename: string): boolean {
  return (
    APPLICATION_DEFAULT_CREDENTIALS_PATTERN.test(basename) ||
    (basename.includes('credentials') &&
      CREDENTIAL_BASENAME_SUFFIXES.some((suffix) => basename.endsWith(suffix)))
  )
}

/**
 * Path-aware credential carriers: files whose BASENAME is far too generic to
 * blanket-block (`config`, `config.json`, `hosts.yml`), but which are
 * unambiguous credential stores when they sit under the owning tool's
 * directory.
 *
 * WHY this is path-aware instead of another `SENSITIVE_BASENAMES` entry:
 * blocking every `config` or `config.json` would make most repositories
 * unreadable, and blocking every `hosts.yml` would break ansible inventories
 * and docs. Composed into `isMandatorySensitiveReadPath` rather than exported
 * as a second predicate so callers keep having exactly ONE refusal check to
 * remember.
 *
 * Expects the already-portable, lowercased path form produced by
 * `toPortablePath` + `toLowerCase`.
 */
function isCredentialDirectoryPath(portablePath: string): boolean {
  const segments = portablePath.split('/').filter(Boolean)
  const basename = segments.at(-1)
  const parent = segments.at(-2)
  if (!basename || !parent) return false

  // GitHub CLI OAuth token store, e.g. `~/.config/gh/hosts.yml`. Any `gh`
  // ancestor qualifies so a nested layout is covered too.
  if (
    (basename === 'hosts.yml' || basename === 'hosts.yaml') &&
    segments.slice(0, -1).includes('gh')
  ) {
    return true
  }
  // kubeconfig: `~/.kube/config` only, directly under `.kube`.
  if (basename === 'config' && parent === '.kube') return true
  // Docker registry auth (base64 registry credentials): `~/.docker/config.json`.
  if (basename === 'config.json' && parent === '.docker') return true
  // AWS shared credentials. `~/.aws/credentials` already matches the bare
  // `credentials` basename in SENSITIVE_BASENAMES; it is listed here too so the
  // pair stays visible in one place and neither half can be dropped silently.
  if (
    (basename === 'config' || basename === 'credentials') &&
    parent === '.aws'
  ) {
    return true
  }

  return false
}

/** Mandatory, case-normalized sensitive-file policy shared by discovery and reads. */
export function isMandatorySensitiveReadPath(filePath: string): boolean {
  const portable = toPortablePath(filePath).toLowerCase()
  const basename = path.posix.basename(portable)
  const extension = path.posix.extname(portable)
  const envFile =
    (basename === '.env' || basename.startsWith('.env.')) &&
    !isEnvTemplatePath(portable)
  return (
    envFile ||
    SENSITIVE_EXTENSIONS.has(extension) ||
    SENSITIVE_BASENAMES.has(basename) ||
    (/^id_(rsa|ed25519|dsa|ecdsa)/.test(basename) &&
      !basename.endsWith('.pub')) ||
    basename.endsWith('_credentials') ||
    isCredentialBasename(basename) ||
    // Path-aware credential carriers (`.kube/config`, `.docker/config.json`,
    // `gh/hosts.yml`, `.aws/config`), matched on their parent directory because
    // their basenames are far too generic to blanket-block.
    isCredentialDirectoryPath(portable) ||
    // kubeconfig: exact credential filenames, not docs/scripts that mention the word
    basename === 'kubeconfig' ||
    basename.endsWith('.kubeconfig') ||
    // real terraform state artifacts only
    basename.endsWith('.tfstate') ||
    basename.endsWith('.tfstate.backup')
  )
}

/**
 * Runtime-owned plan/audit artifacts remain readable even when a repository
 * intentionally gitignores `.agents/`. Mandatory sensitive-file policy and
 * an explicit host fileFilter still take precedence over this exception.
 */
export function isAgentSessionArtifactPath(filePath: string): boolean {
  const portable = toPortablePath(filePath).toLowerCase().replace(/\/+$/, '')
  const segments = portable.split('/').filter(Boolean)
  if (segments[0] !== '.agents' || segments[1] !== 'sessions') return false

  // Permit traversal to the sessions root and a concrete session directory;
  // every child is still checked independently before it is exposed.
  if (segments.length === 2 || segments.length === 3) return true
  if (segments.length < 4) return false

  const remainder = segments.slice(3)
  if (
    remainder.length === 1 &&
    AGENT_SESSION_ARTIFACT_BASENAMES.has(remainder[0])
  ) {
    return true
  }
  if (remainder[0] !== 'findings') return false
  if (remainder.length === 1) return true
  return remainder.length === 2 && remainder[1].endsWith('.md')
}

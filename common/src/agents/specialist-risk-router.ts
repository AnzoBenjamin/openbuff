export type SpecialistReviewerAgent =
  | 'product-reviewer'
  | 'performance-specialist'
  | 'reliability-reviewer'
  | 'migration-reviewer'
  | 'accessibility-reviewer'
  | 'ux-visual-reviewer'
  | 'compatibility-reviewer'
  | 'dependency-reviewer'
  | 'evaluator'

const RELIABILITY_CODE_STEMS = new Set([
  'queue',
  'queues',
  'worker',
  'workers',
  'job',
  'jobs',
  'cache',
  'session',
  'sessions',
  'state',
  'process',
  'async',
  'concurrency',
  'retry',
  'retries',
  'scheduler',
  'pool',
  'lock',
  'locks',
  'timeout',
  'abort',
  'circuit',
])

const RELIABILITY_CODE_EXTENSION =
  /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|py|go|rs|java|kt|kts|rb|php|cs|swift|c|cc|cpp|h|hpp)$/

export function selectSpecialistReviewers(params: {
  files: string[]
  requirements?: string
}): SpecialistReviewerAgent[] {
  const files = params.files.map((file) =>
    file.replace(/\\/g, '/').toLowerCase(),
  )
  const requirements = (params.requirements ?? '').toLowerCase()
  const joined = `${files.join('\n')}\n${requirements}`
  const selected = new Set<SpecialistReviewerAgent>()

  if (
    files.some((file) =>
      /(?:^|\/)(?:package\.json|bun\.lockb?|pnpm-lock\.yaml|yarn\.lock|package-lock\.json|pyproject\.toml|uv\.lock|poetry\.lock|cargo\.toml|cargo\.lock|go\.mod|go\.sum|gemfile(?:\.lock)?|composer\.(?:json|lock)|pom\.xml|build\.gradle(?:\.kts)?|package\.swift)$/.test(
        file,
      ),
    ) ||
    /\b(?:dependency|dependencies|lockfile|package manager|supply chain|license|vulnerabilit)/.test(
      requirements,
    )
  ) selected.add('dependency-reviewer')
  if (
    /(?:^|\/)(?:migrations?|schema|database|db)(?:\/|\.)|\.sql$|\b(?:migrations?|backfill|schema change|database compatibility|rollback)\b/.test(
      joined,
    )
  )
    selected.add('migration-reviewer')
  if (
    /\b(?:public api|backward compat|breaking change|deprecat\w*|serialization|persisted format|config contract|environment variable|cli flag)\b/.test(requirements) ||
    files.some((file) => /(?:^|\/)(?:index|exports?|public-api)\.[^.]+$|(?:^|\/)(?:routes?|config|schemas?|types)\//.test(file))
  ) selected.add('compatibility-reviewer')
  const isAgentsSessionArtifact = (file: string) =>
    /(?:^|\/)\.agents\/sessions(?:\/|$)/.test(file)

  const isReliabilityCodePath = (file: string) => {
    if (isAgentsSessionArtifact(file)) return false
    // Directory-style concurrency/runtime surfaces (unchanged)...
    if (
      /(?:^|\/)(?:queues?|workers?|jobs?|cache|sessions?|state|process|async|concurrency)\//.test(
        file,
      )
    ) {
      return true
    }
    // ...plus exact filename-stem matches on code files only: compound stems
    // (retry-policy.ts) and data/doc extensions (state.json) never match.
    const base = file.slice(file.lastIndexOf('/') + 1)
    const dot = base.lastIndexOf('.')
    if (dot <= 0) {
      // No extension (or dotfile like .gitignore): the whole basename is the stem.
      return RELIABILITY_CODE_STEMS.has(base)
    }
    if (!RELIABILITY_CODE_EXTENSION.test(base)) return false
    return RELIABILITY_CODE_STEMS.has(base.slice(0, dot))
  }

  if (
    /\b(?:race|concurr\w*|retry|retries|cancel|abort|idempoten\w*|deadlock|state machine|resource leak|partial failure)\b/.test(
      requirements,
    ) ||
    files.some(isReliabilityCodePath)
  ) {
    selected.add('reliability-reviewer')
  }
  if (
    /\b(?:performance|latency|throughput|benchmark|profil\w*|allocation|hot path|load test|complexity)\b/.test(requirements) ||
    files.some((file) => /(?:bench|perf|load-test|profil)/.test(file))
  ) selected.add('performance-specialist')
  const hasUiFiles = files.some((file) =>
    /(?:^|\/)(?:components?|pages?|views?|screens?|widgets?|layouts?|features?|ui|app)(?:\/|\.)|\.(?:tsx|jsx|vue|svelte|css|scss|html|astro|less|sass|styl)$/.test(
      file,
    ),
  )
  if (hasUiFiles && /\b(?:accessibility|a11y|keyboard|focus|screen reader|aria|contrast|reduced motion)\b/.test(requirements))
    selected.add('accessibility-reviewer')
  if (hasUiFiles && /\b(?:visual|layout|responsive|design system|spacing|hierarchy|screenshot|viewport|interaction)\b/.test(requirements))
    selected.add('ux-visual-reviewer')
  if (/\b(?:user-facing|acceptance criteria|product behavior|user flow|end-to-end|ux|onboarding)\b/.test(requirements))
    selected.add('product-reviewer')
  if (/\b(?:independent evaluat|score against|requirement coverage)\b/.test(requirements))
    selected.add('evaluator')

  const stableOrder: SpecialistReviewerAgent[] = [
    'dependency-reviewer',
    'migration-reviewer',
    'compatibility-reviewer',
    'reliability-reviewer',
    'performance-specialist',
    'accessibility-reviewer',
    'ux-visual-reviewer',
    'product-reviewer',
    'evaluator',
  ]
  return stableOrder.filter((agent) => selected.has(agent))
}

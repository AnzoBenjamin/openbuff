# Openbuff Evals

This directory contains Openbuff's evaluation harnesses. The primary one is
**BuffBench**, a commit-reconstruction benchmark under `evals/buffbench/`.
Several smaller, deterministic sibling evals live alongside it (retention and
fidelity scenarios, and an editor A/B comparison).

## Contents

- [`buffbench/`](#buffbench) — LLM-judged commit-reconstruction benchmark
- [`compaction-retention/`](#sibling-evals) — deterministic context-pruner retention scenarios
- [`compaction-fidelity/`](#sibling-evals) — deterministic within-session compaction fidelity scenarios
- [`memory-retention/`](#sibling-evals) — deterministic cross-session task-memory scenarios
- [`multieditor-vs-default/`](#sibling-evals) — editor A/B comparison harness

Shared package scripts live in [`evals/package.json`](./package.json).

---

## BuffBench

BuffBench measures AI coding-agent performance by having agents **reconstruct
real git commits** from open-source repositories, then scoring each
reconstruction with LLM judges against the ground-truth diff.

Each task checks out a repository at a commit's parent, hands the agent a
natural-language prompt, lets it edit the repo with its tools, and captures the
resulting git diff. LLM judges compare that diff to the actual commit and score
it. Multiple agents can run on the same tasks in parallel for direct
comparison.

BuffBench has its own detailed README with API-level usage and configuration
notes: see [`buffbench/README.md`](./buffbench/README.md). The sections below
summarize the contract and how to run it.

### Architecture

```
task sets (eval-*.json)
        │
        ▼
run-buffbench.ts  ──►  agent-runner.ts  ──►  runners/  (per agent / tool)
  (orchestrator)         (executes agents        codebuff | claude | codex | opencode
                          in test repos)
        │                     │
        │                     ▼
        │                  judge.ts   (LLM judges score each diff)
        ▼
trace-analyzer.ts (per-task)  +  meta-analyzer.ts (across all tasks)
        │
        ▼
logs/<run>/FINAL_RESULTS.json
```

Key modules (all under `evals/buffbench/`):

| File | Role |
| --- | --- |
| `run-buffbench.ts` | Orchestrator. Exports `runBuffBench(options)`; loads task sets, runs agents per task with bounded concurrency, invokes judging + analysis, writes logs. |
| `agent-runner.ts` | Runs a coding agent against a prepared test repo, captures its trace, diff, cost, and optional final-check outputs. |
| `setup-test-repo.ts` | Clones/prepares the target repo (supports `file://` local clones) and checks out the task's parent commit. |
| `judge.ts` | LLM judging. Builds the judge prompt and returns a validated `JudgingResult`. |
| `judge-calibration.ts` | Evaluates judge consistency against a gold set. |
| `trace-analyzer.ts` | Per-task analysis comparing how agents approached the same problem. |
| `meta-analyzer.ts` | Cross-task aggregate analysis of consistent strengths/weaknesses. |
| `lessons-extractor.ts` | Extracts lessons from runs; feeds `proposals.ts`. |
| `proposals.ts` | Parses/applies agent-config change proposals (dry-run + apply). |
| `compare-runs.ts` | Pure before/after delta report between two runs. |
| `gen-evals.ts`, `gen-repo-eval.ts`, `eval-task-generator.ts`, `pick-commits.ts` | Task-set generation from real commits. |
| `types.ts` | `EvalDataV2`, `EvalCommitV2`, `FileDiff`, `EvalRun`, `AgentEvalResults`, and related types. |
| `runners/` | Per-agent adapters: `codebuff.ts`, `claude.ts`, `codex.ts`, `opencode.ts`, common `runner.ts` interface, `index.ts` re-exports. |

### Directory structure

```
evals/buffbench/
├── run-buffbench.ts          # Orchestrator: runBuffBench(options)
├── main.ts                   # Entry: base2 on eval-codebuff.json
├── main-openbuff.ts          # Entry: eval-openbuff-v2.json (OPENBUFF_REPO_PATH override)
├── main-single-eval.ts       # Entry: single task by id
├── main-hard-tasks.ts        # Entry: the *2.json "hard" task sets
├── main-nightly.ts           # Entry: nightly run + stdout summary
│
├── agent-runner.ts           # Executes agents in test repos
├── setup-test-repo.ts        # Clone / checkout parent commit
├── judge.ts                  # LLM judging
├── judge-calibration.ts      # Judge gold-set calibration
├── trace-analyzer.ts         # Per-task trace analysis
├── meta-analyzer.ts          # Cross-task meta analysis
├── lessons-extractor.ts      # Extract lessons from runs
├── proposals.ts              # Apply agent-config proposals
├── compare-runs.ts           # Before/after run delta
│
├── gen-evals.ts              # Generate tasks from specific commits
├── gen-repo-eval.ts          # End-to-end eval creation from a repo
├── eval-task-generator.ts    # Task prompt generation
├── pick-commits.ts           # LLM-screened commit selection
│
├── types.ts                  # Type definitions
├── retrieval-flow-metrics.ts # Retrieval-flow signal computation
│
├── runners/
│   ├── runner.ts             # Common Runner interface
│   ├── codebuff.ts           # Codebuff agent runner
│   ├── claude.ts             # external:claude (Claude Code CLI)
│   ├── codex.ts              # external:codex (OpenAI Codex CLI)
│   ├── opencode.ts           # external:opencode (OpenCode CLI)
│   └── index.ts
│
├── __tests__/                # Signal / unit tests (run-buffbench, judge, ...)
│
├── eval-openbuff-v2.json     # openbuff-authored post-fork tasks
├── eval-codebuff.json        # inherited upstream Codebuff tasks (repoUrl → AnzoBenjamin/openbuff)
├── eval-manifold.json        # Manifold tasks
├── eval-plane.json           # Plane tasks
├── eval-saleor.json          # Saleor tasks
├── eval-idioms-v1.json       # Python/Rust/Go idiom seed tasks
├── *2.json / *-hard.json     # "hard" task-set variants
│
└── logs/                     # Per-run output dirs (see below)
```

### How to run

BuffBench is invoked through thin `main-*.ts` entrypoints that call
`runBuffBench(...)` with a fixed configuration. Run them with `bun`.

Some entrypoints are wired as package scripts in `evals/package.json`
(run from the `evals/` directory), and all can be run directly by path:

```bash
# Package scripts (from evals/)
bun run main                  # buffbench/main.ts — base2 on eval-codebuff.json
bun run main-openbuff         # buffbench/main-openbuff.ts — eval-openbuff-v2.json
bun run run-buffbench         # alias of main (buffbench/main.ts)
bun run run-buffbench-nightly # buffbench/main-nightly.ts — nightly run + summary

# Direct by path (entrypoints without a dedicated script)
bun run evals/buffbench/main-single-eval.ts   # single task by id
bun run evals/buffbench/main-hard-tasks.ts    # the *2.json hard task sets
```

Each entrypoint hard-codes its agents, task set(s), and concurrency; edit the
file (or the exported `runBuffBench` call) to change what runs. Some accept a
few process flags — for example `main.ts`, `main-openbuff.ts`,
`main-single-eval.ts`, `main-hard-tasks.ts`, and `main-nightly.ts` all honor
`--save-traces`, and `main-openbuff.ts` also honors `--task-concurrency=N` plus
the `OPENBUFF_REPO_PATH` env override. When in doubt, read the entrypoint file
rather than guessing flags.

`runBuffBench` itself takes:

```typescript
runBuffBench({
  evalDataPaths: string[],        // one or more eval-*.json task sets
  agents: string[],               // e.g. ['base2', 'external:claude']
  taskConcurrency?: number,       // default 1
  taskIds?: string[],             // restrict to specific task ids
  extractLessons?: boolean,       // default false
  disableAnalysis?: boolean,      // default false (skips meta-analysis)
  saveTraces?: boolean,           // default false
  client?: OpenbuffClient,
})
```

External CLI agents (`external:claude`, `external:codex`, `external:opencode`)
require the corresponding CLI installed and API key set; see
[`buffbench/README.md`](./buffbench/README.md) for prerequisites.

### Task-set format

Task sets are JSON files matching `EvalDataV2` (see `buffbench/types.ts`):

```typescript
interface EvalDataV2 {
  repoUrl: string                 // source repo (http(s):// or file://)
  testRepoName?: string
  generationDate: string
  initCommand?: string            // trusted setup command run from repo root
  binInstalls?: BinInstall[]      // binaries to install in an isolated dir
  env?: Record<string, string>
  finalCheckCommands?: FinalCheckCommand[]  // validation (tests/lints/typecheck)
  cacheRecallEval?: CacheRecallEvalConfig
  evalCommits: EvalCommitV2[]
}

interface EvalCommitV2 {
  id: string                      // unique task id (used by taskIds / --task filters)
  sha: string                     // target commit
  parentSha: string               // starting state (checked out for the agent)
  spec: string                    // expected observable outcome
  prompt: string                  // natural-language instruction given to the agent
  supplementalFiles: string[]     // extra context files
  fileDiffs: FileDiff[]           // ground-truth changes
}

interface FileDiff {
  path: string
  status: 'modified' | 'added' | 'deleted' | 'renamed'
  oldPath?: string
  diff: string                    // unified diff
}
```

`finalCheckCommands` entries may be plain strings (run sequentially) or
`FinalCheckSpec` objects with `id` / `dependsOn` / `timeoutMs` for
dependency-aware scheduling. See `types.ts` for the full shape.

#### Generating new task sets

```bash
# From specific commits of a repo
bun run evals/buffbench/gen-evals.ts <repo-url> <sha> [<sha> ...]

# End-to-end: clone, LLM-select commits, generate tasks
bun run evals/buffbench/gen-repo-eval.ts <repo-url>
```

`gen-repo-eval.ts` uses `pick-commits.ts` to screen commits with an LLM, then
`eval-task-generator.ts` / `gen-evals.ts` to produce `EvalCommitV2` entries.

### Judging

Judging is implemented in `judge.ts` (`judgeCommitResult`). It builds a single
prompt containing the user prompt, the task spec, context files, the
ground-truth diff, and the agent's actual diff, then runs judges in parallel.

As currently wired, `judgeCommitResult` runs **two** judges in parallel:

- `judge-gpt` → `openai/gpt-5.4`
- `judge-gemini` → `google/gemini-3.1-pro-preview`

A third `judge-claude` agent (`anthropic/claude-sonnet-4.6`) is defined in the
judge registry but is **not** invoked by `judgeCommitResult`. The judge model
ids are pinned in [`constants.ts`](./constants.ts) (`JUDGE_MODEL_CONFIG`) and
can be overridden per judge via `BUFFBENCH_JUDGE_MODEL_<NORMALIZED_ID>`
environment variables (e.g. `BUFFBENCH_JUDGE_MODEL_JUDGE_GPT`).

Each judge returns a schema-validated `JudgingResult`:

```typescript
interface JudgingResult {
  analysis: string
  strengths: string[]
  weaknesses: string[]
  completionScore: number   // 0-10
  codeQualityScore: number  // 0-10
  overallScore: number      // 0-10
  scoringStatus?: 'scored' | 'all_judges_failed' | 'partial_judge_failure'
  // idiomScore / nonIdiomaticPatternsDetected are optional (idiom evals only)
}
```

Scoring behavior:

- Scores are **averaged** across the judges that returned valid structured
  output; the returned narrative (`analysis`/`strengths`/`weaknesses`) is taken
  from the **median** judge by overall score.
- If all judges fail, the result is synthetic all-zeros tagged
  `scoringStatus: 'all_judges_failed'` (excluded from measured averages, not
  treated as a true 0/10). Partial failures are tagged
  `'partial_judge_failure'`.
- When a task defines `finalCheckCommands`, deterministic signals
  (compile/test/lint pass/fail) can **clamp** the judge's scores so a broken
  build cannot score highly (`deterministic-signals.ts`).

### Results / output

Each run writes to a timestamped directory:
`evals/buffbench/logs/YYYY-MM-DDTHH-MM_<agents>/`. It contains per-task trace
files, per-task `*-ANALYSIS-*.json` files, and a top-level
`FINAL_RESULTS.json`.

`FINAL_RESULTS.json` is the object returned by `runBuffBench`:

```jsonc
{
  "metadata": {
    "timestamp": "...",
    "evalDataPaths": ["..."],
    "agentsTested": ["base2"],
    "commitsEvaluated": 10,
    "totalCommitsInEval": 62,
    "evalFiles": [{ "path": "...", "repoUrl": "...", "taskCount": 62 }],
    "totalDuration": 123456,
    "logsDirectory": "...",
    "files": ["...", "FINAL_RESULTS.json"]
  },
  "metaAnalysis": { /* MetaAnalysisResult, or omitted if disableAnalysis */ },
  "agents": {
    "base2": {
      "agentId": "base2",
      "runs": [ /* EvalRun[] */ ],
      "averageScore": 7.5,
      "averageScoreExcludingFailures": 7.1,
      "averageCost": 0.0234,
      "averageDuration": 45000
    }
  }
}
```

Note: agent results are namespaced under the `agents` key (so an agent id like
`metadata` cannot collide with reserved top-level keys). Per-run details live in
`AgentEvalResults.runs` (`EvalRun[]`), each carrying the agent `diff`, its
`judging` result, `cost`, `durationMs`, and optional `finalCheckOutputs`. See
`types.ts` for the authoritative shapes.

### Example task sets

- **`eval-openbuff-v2.json`** — openbuff-authored post-fork commits. Its
  `repoUrl` is a `file://` path to a local openbuff worktree; run via
  `main-openbuff.ts` and set `OPENBUFF_REPO_PATH` for portability.
- **`eval-codebuff.json`** — inherited upstream Codebuff commits, `repoUrl`
  repointed to `AnzoBenjamin/openbuff` so the runner can clone it.
- **`eval-manifold.json`**, **`eval-plane.json`**, **`eval-saleor.json`** —
  third-party project task sets.
- **`eval-idioms-v1.json`** — a small Python/Rust/Go idiom-compliance seed set
  (fixture tasks, not generated from real commits).
- **`*2.json` / `*-hard.json`** — harder task-set variants (see
  `main-hard-tasks.ts`).

The `eval-codebuff.json` and `eval-openbuff-v2.json` sets intentionally coexist
so regressions can be measured against both inherited upstream history and
openbuff-authored history. See [`buffbench/README.md`](./buffbench/README.md)
for the full rationale.

---

## Sibling evals

Besides BuffBench, `evals/` contains smaller, mostly **deterministic (no-LLM)**
evals. These run as `bun test` scenarios (picked up from any `*.test.ts` under
`evals/`), except `multieditor-vs-default/`, which is a scriptable comparison
harness.

### `compaction-retention/`

Deterministic scenario measuring context-pruner retention quality: whether the
pinned `<knowledge_memory>` block still carries the evidence a run needs, and
how that scales with the model context window. Drives `agents/context-pruner.ts`
directly with a mock agent state. Run:

```bash
bun --cwd=evals test compaction-retention
```

See [`compaction-retention/README.md`](./compaction-retention/README.md).

### `compaction-fidelity/`

Deterministic scenario scoring within-session compaction fidelity — how much
task-relevant information survives a compaction — by pushing a long transcript
with planted facts through the real eviction / archive-recall / extraction-
verifier pipeline modules. Scenario lives in
[`compaction-fidelity/scenario.test.ts`](./compaction-fidelity/scenario.test.ts).

### `memory-retention/`

Deterministic scenarios proving cross-session task memory behaves honestly
across the session boundary, driving the SDK store APIs and the agent-runtime
context compiler directly. Run:

```bash
bun --cwd=evals run test:memory-retention
```

See [`memory-retention/README.md`](./memory-retention/README.md).

### `multieditor-vs-default/`

Editor A/B comparison harness (`main.ts` + `run-comparison.ts`) that scores
default vs multieditor runs over a task suite (`sample-suite.json`), using the
schemas in `types.ts`. See the files in
[`multieditor-vs-default/`](./multieditor-vs-default/).

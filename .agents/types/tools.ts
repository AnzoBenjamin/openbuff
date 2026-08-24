/**
 * Union type of all available tool names
 */
export type ToolName =
  | 'add_message'
  | 'ask_user'
  | 'check_background_agent'
  | 'check_job'
  | 'code_search'
  | 'end_turn'
  | 'edit_transaction'
  | 'edit_3d_asset'
  | 'find_files'
  | 'find_files_matching_content'
  | 'git_status'
  | 'git_branch'
  | 'get_task'
  | 'get_change_review_bundle'
  | 'inspect_workspace'
  | 'inspect_environment'
  | 'inspect_3d_asset'
  | 'get_affected_tests'
  | 'get_build_targets'
  | 'inspect_codebase_structure'
  | 'inspect_feature_completeness'
  | 'evaluate_audit_coverage'
  | 'glob'
  | 'kill_job'
  | 'list_directory'
  | 'list_jobs'
  | 'lookup_agent_info'
  | 'query_index'
  | 'read_docs'
  | 'read_files'
  | 'read_image'
  | 'render_3d_preview'
  | 'read_logs'
  | 'read_outline'
  | 'read_subtree'
  | 'replace_range'
  | 'rewrite_symbol'
  | 'render_ui'
  | 'run_file_change_hooks'
  | 'run_targeted_validation'
  | 'run_terminal_command'
  | 'set_messages'
  | 'set_output'
  | 'skill'
  | 'spawn_agents'
  | 'str_replace'
  | 'suggest_followups'
  | 'task_completed'
  | 'think_deeply'
  | 'update_plan_status'
  | 'web_search'
  | 'write_file'
  | 'write_audit_findings'
  | 'write_todos'

/**
 * Map of tool names to their parameter types
 */
export interface ToolParamsMap {
  add_message: AddMessageParams
  ask_user: AskUserParams
  check_background_agent: CheckBackgroundAgentParams
  check_job: CheckJobParams
  code_search: CodeSearchParams
  end_turn: EndTurnParams
  edit_transaction: EditTransactionParams
  edit_3d_asset: Edit3dAssetParams
  find_files: FindFilesParams
  find_files_matching_content: FindFilesMatchingContentParams
  git_status: GitStatusParams
  git_branch: GitBranchParams
  get_task: GetTaskParams
  get_change_review_bundle: GetChangeReviewBundleParams
  inspect_workspace: InspectWorkspaceParams
  inspect_environment: InspectEnvironmentParams
  inspect_3d_asset: Inspect3dAssetParams
  get_affected_tests: GetAffectedTestsParams
  get_build_targets: GetBuildTargetsParams
  inspect_codebase_structure: InspectCodebaseStructureParams
  inspect_feature_completeness: InspectFeatureCompletenessParams
  evaluate_audit_coverage: EvaluateAuditCoverageParams
  glob: GlobParams
  kill_job: KillJobParams
  list_directory: ListDirectoryParams
  list_jobs: ListJobsParams
  lookup_agent_info: LookupAgentInfoParams
  query_index: QueryIndexParams
  read_docs: ReadDocsParams
  read_files: ReadFilesParams
  read_image: ReadImageParams
  render_3d_preview: Render3dPreviewParams
  read_logs: ReadLogsParams
  read_outline: ReadOutlineParams
  read_subtree: ReadSubtreeParams
  replace_range: ReplaceRangeParams
  rewrite_symbol: RewriteSymbolParams
  render_ui: RenderUiParams
  run_file_change_hooks: RunFileChangeHooksParams
  run_targeted_validation: RunTargetedValidationParams
  run_terminal_command: RunTerminalCommandParams
  set_messages: SetMessagesParams
  set_output: SetOutputParams
  skill: SkillParams
  spawn_agents: SpawnAgentsParams
  str_replace: StrReplaceParams
  suggest_followups: SuggestFollowupsParams
  task_completed: TaskCompletedParams
  think_deeply: ThinkDeeplyParams
  update_plan_status: UpdatePlanStatusParams
  web_search: WebSearchParams
  write_file: WriteFileParams
  write_audit_findings: WriteAuditFindingsParams
  write_todos: WriteTodosParams
}

/**
 * Add a new message to the conversation history. To be used for complex requests that can't be solved in a single step, as you may forget what happened!
 */
export interface AddMessageParams {
  role: 'user' | 'assistant'
  content: string
}

/**
 * Ask the user a list of multiple choice questions. Each question must have at least 2 options. The agent execution will pause until the user submits their answers.
 */
export interface AskUserParams {
  /** List of multiple choice questions to ask the user */
  questions: {
    /** The question to ask the user */
    question: string
    /** Optional short display label. Values longer than 18 Unicode code points are truncated instead of rejecting the question. */
    header?: string
    /** Array of answer options with label and optional description. */
    options: {
      /** The display text for this option */
      label: string
      /** Explanation shown when option is focused */
      description?: string
    }[]
    /** If true, allows selecting multiple options (checkbox). If false, single selection only (radio). */
    multiSelect?: boolean
    /** Validation rules for "Other" text input */
    validation?: {
      /** Maximum length for "Other" text input */
      maxLength?: number
      /** Minimum length for "Other" text input */
      minLength?: number
      /** Regex pattern for "Other" text input */
      pattern?: string
      /** Custom error message when pattern fails */
      patternError?: string
    }
  }[]
}

/**
 * Join/wait on a background agent turn started by spawn_agents({ background: true }): returns the sequenced agent_chunk events produced since the cursor plus the unified job state. Use it to observe a long-running background agent without blocking the turn.
 */
export interface CheckBackgroundAgentParams {
  /** The jobId returned by spawn_agents({ background: true }) for the background agent turn. */
  jobId: string
  /** Optional sequence cursor from a prior response. Polling is idempotent for an explicit cursor; nextCursor can be supplied on the next call. */
  cursor?: number
  /** Optional substring to wait for in the new streamed chunks before returning (follow mode). Returns early as soon as it appears in any chunk payload. Useful for waiting until a background agent emits a specific milestone (e.g. a tool_result or a text marker). */
  wait_for?: string
  /** Max seconds to wait for new chunks / the wait_for pattern. 0 (default) returns immediately with whatever new chunks exist (poll mode); >0 blocks up to this long (follow mode). */
  timeout_seconds?: number
  /** When true, explicitly cancel the running background agent before returning its final status. Defaults to false. */
  cancel?: boolean
}

/**
 * Join/wait on a background job started by run_terminal_command: returns the sequenced output events produced since the last check plus the unified job state and exit code. Use it to observe a long-running process without blocking the turn. To watch an arbitrary log file, start a `tail -f <file>` BACKGROUND job and check_job it with a wait_for pattern.
 */
export interface CheckJobParams {
  /** The jobId returned by run_terminal_command with process_type: BACKGROUND. */
  jobId: string
  /** Optional substring to wait for in the new output before returning (follow mode). Returns early as soon as it appears (e.g. "Listening on" / "compiled successfully"). */
  wait_for?: string
  /** Max seconds to wait for new output / the wait_for pattern. 0 (default) returns immediately with whatever new output exists (poll mode); >0 blocks up to this long (follow mode). */
  timeout_seconds?: number
  /** Follow mode only: SIGTERM the job on follow-timeout. Poll mode never kills. Default false. */
  kill_on_timeout?: boolean
}

/**
 * Search for string patterns in the project's files. This tool uses ripgrep (rg), a fast line-oriented search tool. Use this tool only when read_files is not sufficient to find the files you need.
 */
export interface CodeSearchParams {
  /** The pattern to search for. */
  pattern: string
  /** Optional safe ripgrep flags as one string or argv tokens (e.g., "-i -g *.ts -A 2" or ["-i", "-g", "*.ts", "-A", "2"]). Allowed: -i/--ignore-case, -S/--smart-case, -s/--case-sensitive, -w/--word-regexp, -F/--fixed-strings, -U/--multiline, --multiline-dotall, -g/--glob, -t/--type, -T/--type-not, plus context -A/-B/-C (and long forms). JSON quotes delimit the string; do not embed another quote pair around the entire expression. Line numbers are automatic; -n/--line-number are ignored. Output-shape flags such as -c/--count, --count-matches, -l, -v/--invert-match, -r/--replace, --exec, and -z/--null are rejected. */
  flags?: string | string[]
  /** Optional working directory or single file to search within, relative to the project root or absolute. Absolute paths may be outside the project. A directory becomes ripgrep's cwd and scopes the search under that path (plus existing blessed hidden dirs when no paths are given); a file scopes the search to that file only (process cwd = project root when the file is under the project, else the file's parent). Defaults to searching the entire project root. */
  cwd?: string
  /** Optional list of file and/or directory paths to search (relative to the project root, or absolute). When non-empty, ripgrep searches only these targets instead of the whole cwd tree (and does not auto-expand hidden dirs). Can be combined with a file cwd. */
  paths?: string[]
  /** Maximum number of results to return per file. Defaults to 15. There is also a global limit of 250 results across all files. */
  maxResults?: number
}

/**
 * End your turn, regardless of any new tool results that might be coming. This will allow the user to type another prompt.
 */
export interface EndTurnParams {}

/**
 * Parameters for edit_transaction tool
 */
export interface EditTransactionParams {
  edits: (
    | {
        /** Optional stable edit identifier echoed in diagnostics. */
        id?: string
        /** The file to edit. */
        path: string
        type: 'str_replace'
        replacements: {
          oldString: string
          newString: string
          allowMultiple?: boolean
          occurrenceIndex?: number
          /** Optional authenticated cap.v3 readCapability copied verbatim from the matching fresh read_files editAnchor. */
          basedOnRead?: string
          /** For deletion replacements only (newString is empty): treat a missing oldString as an already-applied no-op. Use only for explicit idempotent cleanup retries, never for ordinary edits. When every requested change resolves to such a no-op - every replacement of a standalone str_replace call, or every edit of an edit_transaction - the call succeeds with zero file changes and the skip messages rather than failing. When combined with occurrenceIndex, a partially-applied cleanup also skips: fewer remaining exact occurrences than the requested index means that occurrence is treated as already applied. Only valid when newString is empty; both the input and provider schemas reject any other combination. */
          skipIfMissing?: boolean
        }[]
      }
    | {
        /** Optional stable edit identifier echoed in diagnostics. */
        id?: string
        /** The file to edit. */
        path: string
        /** A structured edit dispatched by operation kind. */
        type: 'structured'
        /** Structured edit operation to apply to this file. */
        operation:
          | {
              /** Deterministic text insertion. */
              kind: 'insert_text'
              /** 1-indexed insertion position. */
              position: {
                /** 1-indexed target line. */
                line: number
                /** 1-indexed target column. */
                column: number
              }
              text: string
            }
          | {
              /** Language-aware import insertion. */
              kind: 'insert_import'
              /** Complete language-native import statement to add, e.g. "import { foo } from 'bar'", "from app import value", or "use crate::value". */
              importStatement: string
            }
          | {
              /** Language-aware import removal. */
              kind: 'remove_import'
              /** Complete language-native import statement to remove. Required unless moduleSpecifier is provided. */
              importStatement?: string
              /** Module specifier to remove imports from, e.g. "react" or "./helper". */
              moduleSpecifier?: string
            }
      }
    | {
        /** Optional stable edit identifier echoed in diagnostics. */
        id?: string
        /** The file to edit. */
        path: string
        type: 'create'
        /** Exact bytes to write to the new file. */
        content: string
      }
    | {
        /** Optional stable edit identifier echoed in diagnostics. */
        id?: string
        /** The file to edit. */
        path: string
        type: 'delete'
      }
    | {
        /** Optional stable edit identifier echoed in diagnostics. */
        id?: string
        /** The file to edit. */
        path: string
        type: 'move'
        /** New project-relative path. The destination must be absent. */
        destinationPath: string
      }
    | {
        /** Optional stable edit identifier echoed in diagnostics. */
        id?: string
        /** The file to edit. */
        path: string
        type: 'replace_range'
        readCapability: string
        startLine?: number
        endLine?: number
        occurrence?: {
          match: string
          occurrence?: number
        }
        newContent: string
      }
    | {
        /** Optional stable edit identifier echoed in diagnostics. */
        id?: string
        /** The file to edit. */
        path: string
        type: 'rewrite_symbol'
        symbol: string
        content: string
        occurrence?: number
        /** Optional cap.v3 copied from the matching read_files symbol slice. It authorizes exactly the symbol and its contiguous preceding comment block. */
        readCapability?: string
      }
    | {
        /** Optional stable edit identifier echoed in diagnostics. */
        id?: string
        /** The file to edit. */
        path: string
        type: 'patch'
        diff: string
      }
    | {
        /** Optional stable edit identifier echoed in diagnostics. */
        id?: string
        /** The file to edit. */
        path: string
        type: 'write_file'
        content: string
        /** Optional whole-file-covering cap.v3 from a fresh complete whole-file read. Only a full-file capability with a hash matching current content may authorize overwrite; partial ranges never authorize write_file. */
        basedOnRead?: string
      }
  )[]
}

/**
 * Parameters for edit_3d_asset tool
 */
export interface Edit3dAssetParams {
  /** Project-relative .blend path. */
  path: string
  /** Exact source hash returned by inspect_3d_asset. */
  source_hash: string
  operations: (
    | {
        type: 'rename_object'
        object: string
        new_name: string
      }
    | {
        type: 'set_object_transform'
        object: string
        location?: any[]
        rotation_degrees?: any[]
        scale?: any[]
      }
    | {
        type: 'set_render_resolution'
        width: number
        height: number
        percentage?: number
      }
    | {
        type: 'set_frame_range'
        start: number
        end: number
      }
  )[]
}

/**
 * Find several files related to a brief natural language description of the files or the name of a function or class you are looking for.
 */
export interface FindFilesParams {
  /** A brief natural language description of the files or the name of a function or class you are looking for. It's also helpful to mention a directory or two to look within. */
  prompt: string
}

/**
 * List unique file paths whose content matches a pattern, with optional symbol grouping. Built on top of ripgrep (rg).
 */
export interface FindFilesMatchingContentParams {
  /** Regex pattern (ripgrep syntax) to match file content against. */
  pattern: string
  /** Optional safe ripgrep flags as one string or argv tokens. Allowed: -i/--ignore-case, -S/--smart-case, -s/--case-sensitive, -w/--word-regexp, -F/--fixed-strings, -U/--multiline, --multiline-dotall, -g/--glob, -t/--type, -T/--type-not. Examples: "-g *.ts -g *.tsx" or ["-g", "*.ts", "-g", "*.tsx"]. Do not quote the entire expression inside the JSON string. Output-shape flags such as -c/--count, --count-matches, -l, -v/--invert-match, context -A/-B/-C, -r/--replace, --exec, and -z/--null are rejected (this tool forces -l or --json itself). Redundant -n/--line-number inputs are ignored. */
  flags?: string | string[]
  /** Optional working directory or single file to search within, relative to the project root or absolute. Absolute paths may be outside the project. A directory becomes ripgrep's cwd and scopes the search under that path (plus existing blessed hidden dirs); a file scopes the search to that file only (process cwd = project root when the file is under the project, else the file's parent). Defaults to the project root. */
  cwd?: string
  /** Maximum number of unique files to return. Defaults to 100. */
  maxFiles?: number
  /** When true, also return the names of the top-level symbols (functions, classes, methods, exports, constants) that contain each match, plus the per-file match count. Symbol extraction is heuristic and works best for JS/TS/Python/Go/Rust source files; languages without a recognized declaration shape produce an empty symbols list. */
  groupBySymbol?: boolean
  /** Maximum seconds to let ripgrep run before returning partial results. Defaults to 15. */
  timeoutSeconds?: number
}

/**
 * Read-only git status and (optionally) diff for the current project.
 */
export interface GitStatusParams {
  /** When true, also return the unified diff of uncommitted changes. */
  include_diff?: boolean
  /** When true with include_diff, returns the staged diff instead of unstaged. */
  staged?: boolean
  /** Optional path to scope status/diff to (relative to project root). */
  path?: string
  /** Maximum characters of diff output to return. Defaults to 40,000. */
  max_chars?: number
}

/**
 * Create a new git branch, optionally switching to it. Refuses to branch when the working tree is dirty unless `allow_dirty` is true.
 */
export interface GitBranchParams {
  /** Name of the branch to create. Must start with an alphanumeric character and contain only [a-zA-Z0-9._/-]. */
  branch_name: string
  /** When true (default), create AND switch to the branch (`git checkout -b`). When false, only create the branch (`git branch`), leaving the current branch checked out. */
  switch?: boolean
  /** When true, skip the dirty-tree refusal check. Defaults to false — the tool refuses to branch when the working tree has uncommitted changes. */
  allow_dirty?: boolean
}

/**
 * Parameters for get_task tool
 */
export interface GetTaskParams {
  /** Optional plan session slug. Defaults to .agents/ACTIVE_SESSION. */
  session?: string
}

/**
 * Parameters for get_change_review_bundle tool
 */
export interface GetChangeReviewBundleParams {
  max_chars?: number
}

/**
 * Inspect the current repository/worktree identity and Git state without modifying it.
 */
export interface InspectWorkspaceParams {}

/**
 * Parameters for inspect_environment tool
 */
export interface InspectEnvironmentParams {}

/**
 * Parameters for inspect_3d_asset tool
 */
export interface Inspect3dAssetParams {
  /** Project-relative 3D asset path. */
  path: string
}

/**
 * Parameters for get_affected_tests tool
 */
export interface GetAffectedTestsParams {
  files: string[]
}

/**
 * Parameters for get_build_targets tool
 */
export interface GetBuildTargetsParams {
  files: string[]
}

/**
 * Parameters for inspect_codebase_structure tool
 */
export interface InspectCodebaseStructureParams {
  scope?: string[]
}

/**
 * Parameters for inspect_feature_completeness tool
 */
export interface InspectFeatureCompletenessParams {
  feature: string
  snapshot_id: string
  scope?: string[]
}

/**
 * Parameters for evaluate_audit_coverage tool
 */
export interface EvaluateAuditCoverageParams {
  snapshot_id: string
  structural_receipts: {
    schema_version: 1
    snapshot_id: string
    shard_id: string
    subsystem_ids: string[]
    files: string[]
    domains: (
      | 'security'
      | 'correctness'
      | 'state-mutation'
      | 'error-handling'
      | 'performance'
      | 'dependency-hygiene'
      | 'test-coverage'
      | 'api-contract'
    )[]
  }[]
  features: {
    schema_version: 1
    snapshot_id: string
    feature: string
    evidence_kind: 'heuristic' | 'verified'
    evidence: {
      entrypoints: string[]
      implementation: string[]
      consumers: string[]
      tests: string[]
      docs: string[]
      failure_states: string[]
    }
  }[]
  out_of_scope?: {
    id: string
    reason: string
  }[]
  scope?: string[]
}

/**
 * Search for files matching a glob pattern. Returns matching file paths sorted by modification time (newest first, then path for deterministic ties).
 */
export interface GlobParams {
  /** Glob pattern to match files against (e.g., *.js, src/glob/*.ts, glob/test/glob/*.go). */
  pattern: string
  /** Optional working directory or file path, relative to project root. If a directory, the glob pattern is matched against paths relative to this cwd, while returned files remain project-relative. If a file path, the pattern is matched against that file only (full path or basename). If not provided, searches from project root. */
  cwd?: string
}

/**
 * Cancel a background job started by run_terminal_command.
 */
export interface KillJobParams {
  /** The jobId returned by run_terminal_command with process_type: BACKGROUND. */
  jobId: string
  /** Signal to send. Defaults to SIGTERM; use SIGKILL only if graceful termination fails. */
  signal?: 'SIGTERM' | 'SIGKILL'
}

/**
 * List files and directories in the specified path. Returns separate arrays of file names and directory names.
 */
export interface ListDirectoryParams {
  /** Directory path to list, relative to the project root. */
  path: string
}

/**
 * List this run's background jobs (shell processes and background agents, running and settled) with statuses, bucketed pending process/log output relative to the last check_job consumer cursor (agents usually show pending: 'none'), and a gap flag.
 */
export interface ListJobsParams {}

/**
 * Retrieve information about an agent by ID
 */
export interface LookupAgentInfoParams {
  /** Agent ID (short local or full published format) */
  agentId: string
}

/**
 * Query the local codebase graph index to find relevant files ranked by symbol names, imports, headings, paths, doc concepts, and graph relationships. The index is built automatically on startup.
 */
export interface QueryIndexParams {
  /** Natural language query or keyword terms describing the files you are looking for. Optional for graph modes when from/to paths are provided. For example: "authentication", "database migrations", "editor mutation logic", "React components". */
  query?: string
  /** Maximum number of results to return. Defaults to 20. */
  limit?: number
  /** Optional list of file extensions to filter results (without dot). E.g. ["ts", "tsx"] for TypeScript only. */
  fileTypes?: string[]
  /** Optional normalized project-relative directory prefixes. Results outside every prefix are excluded before ranking/limiting. */
  pathPrefixes?: string[]
  /** search|explain|neighbors|path|commands|references — see tool description. */
  mode?: 'search' | 'neighbors' | 'path' | 'explain' | 'commands' | 'references'
  /** Optional source file path for neighbors, path, and references modes. */
  from?: string
  /** Optional target file path for path mode. Also used as the seed file for references mode when from is omitted or not indexed. */
  to?: string
}

/**
 * Fetch up-to-date documentation for libraries and frameworks using Context7 API.
 */
export interface ReadDocsParams {
  /** The library or framework name (e.g., "Next.js", "MongoDB", "React"). Use the official name as it appears in documentation if possible. Only public libraries available in Context7's database are supported, so small or private libraries may not be available. */
  libraryTitle: string
  /** Specific topic to focus on (e.g., "routing", "hooks", "authentication") */
  topic: string
  /** Optional maximum number of tokens to return. Defaults to 10000. Values less than 10000 are automatically increased to 10000. */
  max_tokens?: number
}

/**
 * Read multiple files from disk and return their contents. Use this tool to read as many files as would be helpful to answer the user's request.
 */
export interface ReadFilesParams {
  /** Whole-file paths to read. Complete results include editAnchor.readCapability for follow-up edits. */
  paths?: string[]
  /** 1-indexed inclusive line ranges. Sole `paths` entry infers missing path. */
  ranges?: {
    /** Project-relative file path. */
    path: string
    /** 1-indexed inclusive start line. Defaults to 1. */
    startLine?: number
    /** 1-indexed inclusive end line. Defaults to the last line. */
    endLine?: number
  }[]
  /** Contiguous line windows; each complete window mints a scoped cap.v3 editAnchor. */
  windows?: {
    /** File path to read in contiguous line windows, relative to the project root. */
    path: string
    /** Lines per window. Defaults to 400, capped at 5000. */
    windowSize?: number
    /** 1-indexed window number to return. Omit to get the window manifest (totalLines, windowSize, windowCount) plus the first window. */
    window?: number
  }[]
  /** Literal-anchored context blocks with a scoped cap.v3 editAnchor per block. */
  around?: {
    /** File path to read a content-anchored block from, relative to the project root. */
    path: string
    /** Exact literal string to anchor on. Robust to line-number drift. */
    match: string
    /** 1-indexed occurrence of `match` to anchor on. Defaults to 1. */
    occurrence?: number
    /** Lines of context to include on each side of the match, clamped at file boundaries. Defaults to 40, capped at 2000. */
    contextLines?: number
  }[]
  /** Nth top-level symbol by name (rewrite_symbol occurrence semantics); prefer batch `symbols` when possible. */
  symbol?: {
    /** File path to extract a symbol slice from, relative to the project root. */
    path: string
    /** Top-level symbol name (function, class, interface, method) to pull, as shown by read_outline. */
    name: string
    /** When multiple top-level symbols share this name, the 1-indexed one to return. Defaults to 1. Matches rewrite_symbol occurrence semantics. */
    occurrence?: number
  }[]
  /** Named symbol slices with editAnchors; prefer over full reads when names are known. */
  symbols?: {
    /** Project-relative file path. */
    path: string
    /** Symbol names to slice. */
    names: string[]
  }[]
}

/**
 * Read image files from disk and return them as model-visible image media.
 */
export interface ReadImageParams {
  /** List of image file paths to read. */
  paths: string[]
}

/**
 * Parameters for render_3d_preview tool
 */
export interface Render3dPreviewParams {
  /** Project-relative 3D asset path. */
  path: string
  views?: ('camera' | 'perspective' | 'front' | 'side' | 'top')[]
  mode?: 'material' | 'clay' | 'wireframe'
  width?: number
  height?: number
}

/**
 * Read the last N lines from a log/text file or background job log without starting a background tail process.
 */
export interface ReadLogsParams {
  /** Path to the log file, relative to the project root unless absolute. Required unless jobId is provided. */
  path?: string
  /** Background job id returned by run_terminal_command(process_type: BACKGROUND). When provided, reads the job log file directly. */
  jobId?: string
  /** Number of trailing lines to read. Defaults to 200. */
  lines?: number
  /** Maximum characters to return. Defaults to 20,000. */
  max_chars?: number
}

/**
 * Generate an outline of imports, exports, classes, methods, and function signatures in a source file without reading the entire implementation.
 */
export interface ReadOutlineParams {
  /** File path to generate the AST-like outline for, relative to the project root. */
  path: string
}

/**
 * Read one or more directory subtrees (as a blob including subdirectories, file names, and parsed variables within each source file) or return parsed variable names for files. If no paths are provided, returns the entire project tree.
 */
export interface ReadSubtreeParams {
  /** List of paths to directories or files. Relative to the project root. If omitted, the entire project tree is used. */
  paths?: string[]
  /** Maximum token budget for the subtree blob; the tree will be truncated to fit within this budget by first dropping file variables and then removing the most-nested files and directories. */
  maxTokens?: number
}

/**
 * Replace all of, a contained sub-range of, or the Nth literal occurrence inside content observed through one fresh cap.v3 read capability.
 */
export interface ReplaceRangeParams {
  /** The path to the file to edit. */
  path: string
  /** Copy the cap.v3 readCapability verbatim from the matching fresh read_files editAnchor. The token supplies the observed line bounds and content hash. */
  readCapability: string
  /** Optional 1-indexed target start within the capability-covered range. Omit with endLine to replace the complete observed range. */
  startLine?: number
  /** Optional 1-indexed target end within the capability-covered range. Omit with startLine to replace the complete observed range. */
  endLine?: number
  /** Optional occurrence targeting: replace the 1-indexed occurrence (default 1) of the exact literal match found inside the capability-authorized range. Mutually exclusive with startLine/endLine. */
  occurrence?: {
    match: string
    occurrence?: number
  }
  /** Complete replacement content for the selected line range. */
  newContent: string
}

/**
 * Replace a whole symbol's definition by name using the file's syntax tree, without copying its current text. Resolves the exact AST range and applies it through the safe str_replace path (atomic, anchored).
 */
export interface RewriteSymbolParams {
  /** File path containing the symbol, relative to the project root. */
  path: string
  /** Name of the function/class/method/type/interface to replace (as shown by read_outline). */
  symbol: string
  /** The complete new source for the symbol, replacing its entire current definition (e.g. the whole function including its signature and body). Provide REAL newlines/tabs in the string — literal backslash-n (\n) and backslash-t (\t) sequences are not interpreted and will be written verbatim into the file. This matches str_replace. */
  content: string
  /** When multiple top-level symbols share this name, the 1-indexed one to replace. */
  occurrence?: number
  /** Optional cap.v3 copied from the matching read_files symbol slice. Under strict read-before-edit this authorizes exactly the symbol and its contiguous preceding comment block. */
  readCapability?: string
}

/**
 * Render a small interactive UI widget in the Openbuff CLI. Currently supports a button that opens a link.
 */
export interface RenderUiParams {
  /** The UI widget to render. */
  widget: {
    /** Widget type. Currently, the only supported widget is button. */
    type: 'button'
    /** Short button label shown to the user. */
    text: string
    /** The http:// or https:// URL to open when the user clicks the button. */
    link: string
    /** Theme-aware color treatment. Use primary for the main action and secondary for lower-emphasis actions. */
    variant?: 'primary' | 'secondary'
  }
}

/**
 * Parameters for run_file_change_hooks tool
 */
export interface RunFileChangeHooksParams {
  /** List of file paths that were changed and should trigger file change hooks */
  files: string[]
}

/**
 * Parameters for run_targeted_validation tool
 */
export interface RunTargetedValidationParams {
  snapshot_id: string
  files: string[]
  artifact_kinds?: string[]
}

/**
 * Execute a CLI command from the **project root** (different from the user's cwd).
 */
export interface RunTerminalCommandParams {
  /** CLI command valid for user's OS. */
  command: string
  /** SYNC (default) for finite commands that exit: waits and returns output. BACKGROUND only for long-running or never-exiting processes (dev servers, watchers, log tails): starts a detached job and returns a jobId immediately so the turn is not blocked. Live job_update already drives the user UI; use check_job for agent-side readiness/exitCode/join, not solely for user progress. */
  process_type?: 'SYNC' | 'BACKGROUND'
  /** For BACKGROUND commands only: keep the job running if the owning request is cancelled. Defaults to false. */
  detach?: boolean
  /** The working directory to run the command in. Default is the project root. */
  cwd?: string
  /** Set to -1 for no timeout. Does not apply for BACKGROUND commands. Default 30 */
  timeout_seconds?: number
  /** Runtime-managed background job owner; agents must omit. */
  owner?: {
    clientSessionId: string
    rootRunId: string
    parentRunId: string
    parentAgentId: string
  }
}

/**
 * Atomically replace conversation history and, when supplied, commit a validated structured task-memory revision.
 */
export interface SetMessagesParams {
  messages: any
  taskMemory?: {
    schemaVersion: 1
    goal?: string
    requirements?: string[]
    decisions?: string[]
    filesInspected?: string[]
    editsMade?: string[]
    validationResults?: string[]
    reviewReceipts?: string[]
    blockers?: string[]
    nextActions?: string[]
    historicalSummary?: string
    evidence?: {
      id: string
      kind:
        | 'requirement'
        | 'decision'
        | 'read'
        | 'edit'
        | 'validation'
        | 'review'
        | 'blocker'
        | 'handoff'
        | 'note'
      summary: string
      source?: string
      path?: string
      freshnessHash?: string
      workspaceRevision?: number
      verifiedAt?: number
      supersedes?: string[]
      stale?: boolean
    }[]
    workspaceRevision?: number
    workspaceSnapshotId?: string
  }
  expectedTaskMemoryRevision?: number
}

/**
 * JSON object to set as the agent output. The shape of the parameters are specified dynamically further down in the conversation. This completely replaces any previous output. If the agent was spawned, this value will be passed back to its parent. If the agent has an outputSchema defined, the output will be validated against it.
 */
export interface SetOutputParams {
  data?: Record<string, any>
  [key: string]: any
}

/**
 * Load a skill by name to get its full instructions. Skills provide reusable behaviors and instructions.
 */
export interface SkillParams {
  /** The name of the skill to load */
  name: string
}

/**
 * Spawn up to 12 agents and send a prompt and/or parameters to each of them. These agents will run in parallel. Note that that means they will run independently. Split larger work into bounded waves. If you need to run agents sequentially, use spawn_agents with one agent at a time instead.
 */
export interface SpawnAgentsParams {
  agents: {
    /** Agent to spawn. Must be a name from the live "You can spawn the following agents" catalog (hyphenated ids; underscores accepted). */
    agent_type: string
    /** Prompt to send to the agent */
    prompt?: string
    /** If true, return jobId immediately and run as in-process coroutine; poll with check_background_agent. Defaults to false (blocking). Cannot outlive this CLI session. */
    background?: boolean
    /** Optional structured handoff; additive — non-consumers still get prompt/params. */
    handoff?:
      | {
          schemaVersion: 1
          taskId: string
          role:
            | 'orchestrator'
            | 'explorer'
            | 'thinker'
            | 'editor'
            | 'repair-editor'
            | 'test-writer'
            | 'doc-writer'
            | 'dependency-manager'
            | 'debugger'
            | 'validator'
            | 'reviewer'
            | 'security-reviewer'
            | 'committer'
            | 'synthesizer'
            | 'specialist'
            | 'general'
          objective: string
          requirements: {
            id: string
            text: string
            required: boolean
          }[]
          acceptanceCriteria: {
            id: string
            behavior: string
            verification: string
          }[]
          context:
            | {
                path: string
                symbols: string[]
                reason: string
                confidence: 'confirmed' | 'inferred' | 'unknown'
                freshnessHash?: string
                workspaceRevision?: number
              }[]
            | Record<string, any>
            | string
          currentBehavior?: string
          desiredBehavior?: string
          invariants?: string[]
          nonGoals: string[]
          risks?: string[]
          unknowns?: string[]
          findings: {
            id: string
            text: string
            files: string[]
            snapshotFingerprint: string
          }[]
          permissions: {
            readablePaths: string[]
            writablePaths: string[]
            allowedTools: string[]
          }
          workspaceRevision?: number
          workspaceSnapshotId?: string
          summary?: string
          artifacts?: string[]
          successCriteria?: string[]
          constraints?: string[]
        }
      | Record<string, any>
    /** Optional wall-clock deadline seconds; omit or -1 for none. Agent defaultTimeoutMs still applies when set. */
    timeout_seconds?: number
    /** Parameters object for the agent */
    params?: {
      /** Terminal command to run (basher, tmux-cli) */
      command?: string
      /** What information from the command output is desired (basher) */
      what_to_summarize?: string
      /** Timeout for command. Set to -1 for no timeout. Default 30 (basher) */
      timeout_seconds?: number
      /** Save full command output to a /tmp log and extract failure lines for long SYNC command output (basher) */
      save_full_log?: boolean
      /** grep -E failure extraction pattern used with save_full_log (basher) */
      failure_pattern?: string
      /** Maximum extracted failure lines to return with save_full_log (basher) */
      max_failure_lines?: number
      /** Array of code search queries (code-searcher) */
      searchQueries?: {
        /** The pattern to search for */
        pattern: string
        /** Optional ripgrep flags as one string or argv tokens (e.g. "-i -g *.ts" or ["-i", "-g", "*.ts"]). Do not quote the entire expression inside the JSON string. */
        flags?: string | string[]
        /** Optional working directory relative to project root */
        cwd?: string
        /** Max results per file. Default 15 */
        maxResults?: number
      }[]
      /** Relevant file paths to read (general-agent) */
      filePaths?: string[]
      /** Relevant directory paths to inventory (general-agent) */
      directoryPaths?: string[]
      /** Directories to search within (file-picker) */
      directories?: string[]
      /** Starting URL to navigate to (browser-use) */
      url?: string
      /** Exact task-owned paths eligible for staging (git-committer) */
      owned_paths?: string[]
      /** Optional branch to create or switch to (git-committer) */
      branch_name?: string
      /** Create and switch to branch_name when true (git-committer) */
      branch_switch?: boolean
      /** Allow branch create/switch on a dirty worktree (git-committer) */
      allow_dirty_branch?: boolean
      /** Push the resulting feature branch when authorized (git-committer) */
      push?: boolean
      /** Remote used for fetch/push (git-committer) */
      remote?: string
      /** Assigned gate snapshot fingerprint (reviewer specialists) */
      snapshot_id?: string
      /** Changed file paths to review (security-reviewer) */
      changed_files?: string[]
      /** Opaque snapshot token to echo (security-reviewer) */
      snapshot_fingerprint?: string
      /** Package manager selected from repository manifests (dependency-manager) */
      manager?: string
      /** Dependency operation: add, remove, sync, restore, or update (dependency-manager) */
      operation?: string
      /** Exact package specifications (dependency-manager) */
      packages?: string[]
      /** Optional workspace selector (dependency-manager) */
      workspace?: string
      /** GitHub repository URL to clone (librarian) */
      repoUrl?: string
      /** Retain the owned /tmp clone after completion (librarian) */
      retainClone?: boolean
      /** Optional search or path patterns */
      patterns?: string[]
      /** Exact files in scope (reviewer specialists) */
      files?: string[]
      /** Optional agent-specific prompts */
      prompts?: string[]
      [key: string]: any
    }
  }[]
}

/**
 * Parameters for str_replace tool
 */
export interface StrReplaceParams {
  /** The file to edit. */
  path: string
  atomic?: boolean
  replacements: {
    oldString: string
    newString: string
    allowMultiple?: boolean
    occurrenceIndex?: number
    /** Optional authenticated cap.v3 readCapability copied verbatim from the matching fresh read_files editAnchor. */
    basedOnRead?: string
    /** For deletion replacements only (newString is empty): treat a missing oldString as an already-applied no-op. Use only for explicit idempotent cleanup retries, never for ordinary edits. When every requested change resolves to such a no-op - every replacement of a standalone str_replace call, or every edit of an edit_transaction - the call succeeds with zero file changes and the skip messages rather than failing. When combined with occurrenceIndex, a partially-applied cleanup also skips: fewer remaining exact occurrences than the requested index means that occurrence is treated as already applied. Only valid when newString is empty; both the input and provider schemas reject any other combination. */
    skipIfMissing?: boolean
  }[]
}

/**
 * Suggest clickable followup prompts to the user. Each followup becomes a card the user can click to send that prompt.
 */
export interface SuggestFollowupsParams {
  /** List of suggested followup prompts the user can click to send */
  followups: {
    /** The full prompt text to send as a user message when clicked */
    prompt: string
    /** Short display label for the card (defaults to truncated prompt if not provided) */
    label?: string
  }[]
}

/**
 * Signal that the task is complete. Use this tool when:
- The user's request is completely fulfilled
- You need clarification from the user before continuing
- You are stuck or need help from the user to continue

This tool explicitly marks the end of your work on the current task.
 */
export interface TaskCompletedParams {}

/**
 * Deeply consider complex tasks by brainstorming approaches and tradeoffs step-by-step.
 */
export interface ThinkDeeplyParams {
  /** Detailed step-by-step analysis. Initially keep each step concise (max ~5-7 words per step). */
  thought: string
}

/**
 * Parameters for update_plan_status tool
 */
export interface UpdatePlanStatusParams {
  /** Artifact path. Must be `.agents/sessions/<slug>/PLAN.md`, `.agents/sessions/<slug>/STATUS.md`, or `.agents/sessions/<slug>/LESSONS.md`. Absolute paths and `..` traversal are rejected. Editing PLAN.md is permitted only for tri-state task toggles (not full overwrites). */
  path: string
  /** Targeted updates applied in order. Each entry rewrites at most one matching checklist line; unmatched updates fall through to `append`. */
  updates?: {
    /** Stable task ID at the start of a checklist line (for example `P2-T3`). Preferred over substring matching. */
    taskId?: string
    /** Substring of the existing task/checklist line to match (case-insensitive). The first matching `- [ ]`/`-[x]`/`-[~]`/`-[/]`/`-[!]` line in the artifact will be updated in place. */
    task?: string
    /** When provided, sets the checkbox state of the matched line (true -> `[x]`, false -> `[ ]`). Ignored when `status` is also provided. */
    completed?: boolean
    /** Explicit tri-state task status. When provided, overrides `completed`. Transitions a task to `in_progress` (`[~]`), `done` (`[x]`), `cancelled` (`[/]`), `blocked` (`[!]`), or back to `pending` (`[ ]`). */
    status?: 'pending' | 'in_progress' | 'done' | 'cancelled' | 'blocked'
    /** Optional short note to append to the matched line in parentheses. Preserves any existing trailing text on the line. */
    note?: string
  }[]
  /** Optional delimited entry appended at the end of the artifact (used when there is no matching task line for the change being recorded). */
  append?: {
    /** Short heading for an appended entry. Used to form a clearly delimited block (`## <heading> — <timestamp>`). */
    heading: string
    /** Markdown body for the appended entry. Written verbatim under the heading. */
    body: string
  }
  /** Optional session-level status transition. When provided, `.agents/sessions/<slug>/STATE.json` is created or updated to reflect the new lifecycle status. */
  sessionStatus?:
    | 'draft'
    | 'ready'
    | 'active'
    | 'executing'
    | 'validating'
    | 'reviewing'
    | 'blocked'
    | 'paused'
    | 'completed'
    | 'archived'
  /** Optional current-task pointer written as a `<!-- current-task: <task> -->` annotation in PLAN.md. Pass an empty string or omit to clear the pointer. Only takes effect when path targets PLAN.md. */
  currentTask?: string
  /** Optional STATE.json compare-and-swap revision. The update fails without writing when the current revision differs. */
  expectedRevision?: number
  /** Validation or review evidence associated with a stable task ID. Completing a PLAN task requires a passed validation checkpoint with receiptIds. */
  checkpoint?: {
    taskId: string
    phase: 'validation' | 'review'
    passed: boolean
    summary?: string
    receiptIds?: string[]
  }
}

/**
 * Search the web for current information, or fetch the content of a specific URL.
 */
export interface WebSearchParams {
  /** The search query to find relevant web content. Required unless url is provided. */
  query?: string
  /** A specific URL to fetch and read the full text content of. When provided, fetches this page directly instead of searching. Useful for reading documentation, GitHub READMEs, blog posts, or any public web page. */
  url?: string
  /** Search depth - 'standard' for quick results, 'deep' for more comprehensive search. Default is 'standard'. Ignored when url is provided. */
  depth?: 'standard' | 'deep'
  /** When fetching a URL, also extract and return links found on the page. Enables navigation by letting you see what pages are linked. Default: true. */
  include_links?: boolean
  /** Maximum number of links to extract when include_links is true. Default: 40. */
  max_links?: number
}

/**
 * Create or overwrite a file with the given content.
 */
export interface WriteFileParams {
  /** Path to the file relative to the **project root** */
  path: string
  /** What the change is intended to do in only one sentence. */
  instructions: string
  /** Complete file content to write to the file. */
  content: string
  /** Optional whole-file-covering cap.v3 from a fresh complete whole-file read (paths or full-file range). Only a capability that covers the entire current file (startLine=1 through the current line count) with a hash matching current content may authorize overwrite; partial range capabilities never authorize write_file. */
  basedOnRead?: string
}

/**
 * Parameters for write_audit_findings tool
 */
export interface WriteAuditFindingsParams {
  /** Existing durable audit session slug under .agents/sessions/. Accepts only a short identifier token: 1 to 100 characters of letters, digits, dot, underscore, or dash, and neither `.` nor `..` on its own. */
  sessionSlug: string
  /** Unique shard identifier used as the findings filename. Accepts only a short identifier token: 1 to 100 characters of letters, digits, dot, underscore, or dash, and neither `.` nor `..` on its own. */
  shardId: string
  /** Exact snapshotId returned by inspect_codebase_structure, such as its 64-character sha256 digest. Required for a directly composable structuralReceipt; omitted only for legacy callers. Accepts only a short identifier token: 1 to 100 characters of letters, digits, dot, underscore, or dash, and neither `.` nor `..` on its own. When snapshotId and coverage.domains are both present the call receives a structuralReceipt, so coverage.subsystemIds and coverage.files must each name at least one entry: evaluate_audit_coverage rejects a receipt whose subsystem_ids or files list is empty. */
  snapshotId?: string
  /** Each findings entry rejects control and Unicode format characters in title, risk, fix, and evidence — NUL, any other control character, and the U+2028/U+2029 line separators — while still accepting tabs and line breaks in that prose. findings[].path is a location rather than prose, so it must be a single-line value with none of those characters and no tabs or line breaks; it is trimmed, and the trimmed value is the one rendered into the finding heading. */
  findings: {
    severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW'
    domain:
      | 'security'
      | 'correctness'
      | 'state-mutation'
      | 'error-handling'
      | 'performance'
      | 'dependency-hygiene'
      | 'test-coverage'
      | 'api-contract'
      | 'api-abi'
    path: string
    line?: number
    title: string
    risk: string
    fix: string
    evidence: string
  }[]
  /** Every coverage list must name each entry at most once: a repeated file, subsystemId, featureId, or domain is rejected rather than counted twice. Entries are compared after trimming surrounding whitespace, and the trimmed value is what reaches the artifact and the receipt, so two spellings that differ only in whitespace are the same entry. Every coverage files, subsystemIds, and featureIds entry must be a single-line value: tabs, carriage returns, newlines, NUL, any other control or Unicode format character, and the U+2028/U+2029 line separators are rejected. Entries are trimmed, and the trimmed value is the one uniqueness is judged on. */
  coverage: {
    /** See the coverage description for the single-line hygiene rule, which applies to this list too. See the coverage description for the uniqueness rule, which applies to this list too. */
    subsystemIds: string[]
    /** See the coverage description for the single-line hygiene rule, which applies to this list too. See the coverage description for the uniqueness rule, which applies to this list too. */
    featureIds: string[]
    /** See the coverage description for the single-line hygiene rule, which applies to this list too. See the coverage description for the uniqueness rule, which applies to this list too. */
    files: string[]
    /** coverage.domains accepts canonical domain ids only, so use api-contract there: the legacy api-abi alias is accepted only in findings[].domain. When coverage.domains is present it must name at least one domain: an empty list is rejected rather than treated as an omitted field. See the coverage description for the uniqueness rule, which applies to this list too. */
    domains?: (
      | 'security'
      | 'correctness'
      | 'state-mutation'
      | 'error-handling'
      | 'performance'
      | 'dependency-hygiene'
      | 'test-coverage'
      | 'api-contract'
    )[]
  }
  /** Set noIssuesFound=true exactly when findings is empty and false whenever findings is non-empty; any other combination is rejected. */
  noIssuesFound?: boolean
}

/**
 * Write a todo list to track tasks for multi-step implementations. Use this frequently to maintain an updated step-by-step plan.
 */
export interface WriteTodosParams {
  /** List of todos with their completion status. Add ALL of the applicable tasks to the list, so you don't forget to do anything. Try to order the todos the same way you will complete them. Do not mark todos as completed if you have not completed them yet! */
  todos: {
    /** Description of the task */
    task: string
    /** Whether the task is completed */
    completed: boolean
  }[]
}

/**
 * Get parameters type for a specific tool
 */
export type GetToolParams<T extends ToolName> = ToolParamsMap[T]

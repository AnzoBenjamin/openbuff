/**
 * P2-T8d: the single source of truth for the supervised self-exec argv flag.
 *
 * A compiled `bun build --compile` binary cannot run `bun run child-entry.ts`
 * (the child entry lives inside the embedded `$bunfs` filesystem and does not
 * exist as a file next to the binary), so in self-exec mode the parent binary
 * re-executes ITSELF as the supervised child via this dedicated argv flag:
 *
 *   `<binary> --supervised-child /path/to/request.json`
 *
 * Both the supervisor (supervised-spawn.ts / process-supervisor.ts, which
 * builds the child cmd) and the CLI (cli/src/index.tsx, which detects the
 * flag at the very top of main() before any renderer work) import the flag
 * from this leaf module — one constant, no second spelling. The module is a
 * dependency-free leaf so the CLI can dynamically import it without
 * evaluating any supervision/bridge machinery.
 */
export const SUPERVISED_SELF_EXEC_FLAG = '--supervised-child'

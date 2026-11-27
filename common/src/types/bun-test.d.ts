declare module 'bun:test' {
  export const describe: (name: string, fn: () => void) => void
  // Mirror bun's real signature (bun-types test.d.ts): the third arg carries
  // per-test options, e.g. a timeout override for long-running load-sensitive
  // tests. bun-types is not in common's typecheck path so this shim must
  // declare it.
  export const it: (
    name: string,
    fn: () => void | Promise<void>,
    options?: number | { timeout?: number },
  ) => void
  export const expect: any
}

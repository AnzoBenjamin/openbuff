import { useEffect } from 'react'

/**
 * Emits `openbuff bootscreen ok` to stdout AFTER the React tree has mounted
 * and painted (useEffect runs post-commit). Gated behind --smoke-bootscreen so
 * only the CI smoke harness requests it, and on non-TTY stdout so real TTY
 * users never see it. This makes the smoke's boot-signal assertion
 * load-bearing: the marker only appears once a full UI mount has succeeded.
 */
export function SmokeBootscreenMarker() {
  useEffect(() => {
    if (process.stdout.isTTY) return
    console.log('openbuff bootscreen ok')
  }, [])
  return null
}

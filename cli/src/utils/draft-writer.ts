import type { InputValue } from '../types/store'

type InputWriter = (
  value: InputValue | ((previous: InputValue) => InputValue),
) => void

/** An awaited action may clear its own draft, but never a newer edit. */
export function createRevisionBoundInputWriter(
  write: InputWriter,
  revision: () => number,
): InputWriter {
  let ownedRevision = revision()
  return (value) => {
    if (revision() !== ownedRevision) return
    write(value)
    ownedRevision = revision()
  }
}

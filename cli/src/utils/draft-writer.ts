import type { InputValue } from '../types/store'

type InputWriter = (
  value: InputValue | ((previous: InputValue) => InputValue),
) => void

/** An awaited action may clear its own draft, but never a newer edit. */
export function createRevisionBoundInputWriter(
  write: InputWriter,
  revision: () => number,
): InputWriter & { isCurrent: () => boolean } {
  let ownedRevision = revision()
  const isCurrent = () => revision() === ownedRevision
  const writeIfCurrent: InputWriter = (value) => {
    if (!isCurrent()) return
    write(value)
    ownedRevision = revision()
  }
  return Object.assign(writeIfCurrent, { isCurrent })
}

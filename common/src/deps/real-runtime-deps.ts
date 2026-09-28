import type { IdGen } from '../types/contracts/agent-runtime'

export const realIdGen: IdGen = {
  uuid: () => crypto.randomUUID(),
  prefixedId: (prefix, separator = '-') =>
    `${prefix}${separator}${crypto.randomUUID()}`,
}

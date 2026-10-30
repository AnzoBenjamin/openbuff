import type { Clock, IdGen } from '../types/contracts/agent-runtime'

export const realIdGen: IdGen = {
  uuid: () => crypto.randomUUID(),
  prefixedId: (prefix, separator = '-') =>
    `${prefix}${separator}${crypto.randomUUID()}`,
}

export const realClock: Clock = {
  now: () => Date.now(),
}

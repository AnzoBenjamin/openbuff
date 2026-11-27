import z from 'zod/v4'

export const nativeWaitStatusFields = {
  executionWaitStatusSource: z
    .enum([
      'direct-target',
      'native-target-wait',
      'bwrap-target-exit',
      'bwrap-status-ambiguous',
      'not-observed',
    ])
    .optional(),
  nativeWrapperExitCode: z.number().int().min(0).max(255).optional(),
  nativeWrapperSignal: z.number().int().positive().max(64).optional(),
}

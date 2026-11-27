import z from 'zod/v4'

export const executionUsageSchema = z.object({
  cpuMicros: z.number().int().nonnegative(),
  maxRssKiB: z.number().int().nonnegative(),
  scope: z.string().min(1),
})

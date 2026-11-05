import { useMemo } from 'react'
import { AGENT_MODE_TO_ID, type AgentMode } from '../utils/constants'
import {
  displayModelId,
  resolveModelNameForAgent,
} from '../utils/openbuff-provider'

/** Local route identity refreshes when a configuration flow changes generation. */
export function useConfiguredModelName(
  agentMode: AgentMode,
  configurationGeneration: string,
  resolve = resolveModelNameForAgent,
) {
  return useMemo(() => {
    const agentId = AGENT_MODE_TO_ID[agentMode]
    return agentId ? (displayModelId(resolve(agentId)) ?? null) : null
  }, [agentMode, configurationGeneration, resolve])
}

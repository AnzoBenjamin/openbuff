import { loadProviderConfigSync } from '@openbuff/sdk'
import { getAttachTarget } from '../utils/codebuff-client'
import {
  COMMAND_APPROVAL_DESCRIPTIONS,
  COMMAND_APPROVAL_MODES,
  getCommandApprovalOverride,
  isCommandApprovalMode,
  resolveCommandApprovalMode,
  setCommandApprovalMode,
} from '../utils/command-approvals'

import type { HarnessApprovalMode } from '@openbuff/sdk'

export function handlePermissionsCommand(
  args: string,
  deps: {
    configuredMode?: () => HarnessApprovalMode | undefined
    attached?: () => boolean
  } = {},
): string {
  if ((deps.attached ?? (() => Boolean(getAttachTarget())))()) {
    return 'Command approvals are controlled by the attached server. Set --approval-mode on openbuff serve.'
  }
  const requested = args.trim().toLowerCase()
  if (requested && requested !== 'reset' && !isCommandApprovalMode(requested)) {
    return 'Usage: /permissions balanced | strict | allow-all | reset'
  }
  const configured = (
    deps.configuredMode ?? (() => loadProviderConfigSync().config.approvalMode)
  )()
  if (requested === 'reset') setCommandApprovalMode(undefined)
  else if (isCommandApprovalMode(requested)) setCommandApprovalMode(requested)
  const mode = resolveCommandApprovalMode(configured)
  const source = getCommandApprovalOverride() ? 'this session' : 'config'
  if (requested) {
    return `Command approvals: ${mode} (${source}). ${COMMAND_APPROVAL_DESCRIPTIONS[mode]}\nApplies to the next run; commands already awaiting approval keep their current policy.`
  }
  return [
    `Command approvals: ${mode} (${source})`,
    '',
    ...COMMAND_APPROVAL_MODES.map(
      (value) =>
        `/permissions ${value}\n  ${COMMAND_APPROVAL_DESCRIPTIONS[value]}`,
    ),
    '',
    '/permissions reset returns to openbuff.json. Changes apply to the next run.',
  ].join('\n')
}

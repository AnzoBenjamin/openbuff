import type { PendingAttachment } from '../store'
import type { AgentMode } from '../../utils/constants'
import type { ChatMessage } from '../chat'

export type PostUserMessageFn = (prev: ChatMessage[]) => ChatMessage[]

export type PromptAdmissionResult =
  | { status: 'accepted'; disposition: 'queued' }
  | {
      status: 'accepted'
      disposition: 'started'
      /** Execution settles independently after started admission. */
      completion: Promise<void>
    }
  | { status: 'rejected'; reason: string; retryable: boolean }
  | { status: 'not-started'; reason: string }

export type SendMessageFn = (params: {
  content: string
  agentMode: AgentMode
  postUserMessage?: PostUserMessageFn
  attachments?: PendingAttachment[]
  /** Compatibility projection fired exactly once for an accepted admission. */
  onAccepted?: () => void
}) => Promise<PromptAdmissionResult>

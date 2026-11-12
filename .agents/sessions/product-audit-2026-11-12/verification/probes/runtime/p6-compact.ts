import { useChatStore } from '/home/ben/Code/CLI/openbuff/cli/src/state/chat-store'
import { routeUserPrompt } from '/home/ben/Code/CLI/openbuff/cli/src/commands/router'
import { findCommand } from '/home/ben/Code/CLI/openbuff/cli/src/commands/command-registry'

async function probe(inputValue: string, isStreaming = false) {
  useChatStore.getState().reset()
  const sent: any[] = [], queued: any[] = []
  let messages: any[] = []
  let input: any = { text: inputValue, cursorPosition: inputValue.length, lastEditDueToNav: false }
  const params: any = {
    inputValue, agentMode: 'DEFAULT', isStreaming,
    isChainInProgressRef: { current: false }, streamMessageIdRef: { current: null },
    abortControllerRef: { current: null }, inputRef: { current: null },
    sendMessage: async (r: any) => { sent.push(r) },
    addToQueue: (content: string) => { queued.push(content) },
    setMessages: (v: any) => { messages = typeof v === 'function' ? v(messages) : v },
    setInputValue: (v: any) => { input = typeof v === 'function' ? v(input) : v },
    saveToHistory: () => {}, setInputFocused: () => {}, setCanProcessQueue: () => {},
    scrollToLatest: () => {}, clearMessages: () => {}, stopStreaming: () => {},
  }
  await routeUserPrompt(params)
  const sys = JSON.stringify(messages).match(/Command not found[^"\\]*(\\"[^\\]*\\")?[^"\\]*/)?.[0]
  console.log(JSON.stringify({ inputValue, isStreaming, sentToAgent: sent.map(s => s.content), queued, systemMessage: sys ?? null }))
}
console.log('findCommand(compact):', findCommand('compact')?.name ?? null)
await probe('/compact')
await probe('/compact keep the API notes')
await probe('/compact', true)
await probe('compact')
process.exit(0)

import { beforeEach, expect, test } from 'bun:test'
import { createRevisionBoundInputWriter } from '../draft-writer'
import { useChatStore } from '../../state/chat-store'

const draft = (text: string) => ({
  text,
  cursorPosition: text.length,
  lastEditDueToNav: false,
})
beforeEach(() => useChatStore.getState().reset())

test('a delayed command cannot replace text typed after its own synchronous clear', async () => {
  const store = useChatStore.getState()
  store.setInputValue(draft('/diagnostics'))
  const write = createRevisionBoundInputWriter(
    store.setInputValue,
    () => useChatStore.getState().inputRevision,
  )
  write(draft(''))
  let complete!: () => void
  const pending = new Promise<void>((resolve) => {
    complete = resolve
  }).then(() => write(draft('old completion')))
  store.setInputValue(draft('new 👩🏽‍💻 draft'))
  complete()
  await pending
  expect(useChatStore.getState().inputValue).toBe('new 👩🏽‍💻 draft')
})

test('navigation and chat reset also invalidate a delayed draft owner', () => {
  const store = useChatStore.getState()
  store.setInputValue(draft('same'))
  const write = createRevisionBoundInputWriter(
    store.setInputValue,
    () => useChatStore.getState().inputRevision,
  )
  store.setInputValue({
    text: 'same',
    cursorPosition: 1,
    lastEditDueToNav: true,
  })
  write(draft('wrong'))
  expect(useChatStore.getState().cursorPosition).toBe(1)
  const resetWrite = createRevisionBoundInputWriter(
    store.setInputValue,
    () => useChatStore.getState().inputRevision,
  )
  store.reset()
  resetWrite(draft('wrong project'))
  expect(useChatStore.getState().inputValue).toBe('')
})

test('an action can perform successive owned writes until someone else edits', () => {
  const store = useChatStore.getState()
  const write = createRevisionBoundInputWriter(
    store.setInputValue,
    () => useChatStore.getState().inputRevision,
  )
  write(draft('loading'))
  write(draft('done'))
  expect(useChatStore.getState().inputValue).toBe('done')
})

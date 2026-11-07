import { create } from 'zustand'
import type { OutputDocument, OutputLocation, OutputKind } from '../utils/output-document'

export interface ReaderView {
  revision: string
  location: OutputLocation
  horizontal: number
  wrap: boolean | null
  query: string
}

interface ReaderRequest {
  documentId?: string
  document?: OutputDocument
  findConversation?: boolean
  kindFilter?: readonly OutputKind[]
}
interface OutputReaderStore {
  request: ReaderRequest | null
  open: (request?: ReaderRequest) => void
  close: () => void
  views: Record<string, ReaderView>
  remember: (id: string, view: ReaderView) => void
}
// View state only; never serialized into a conversation or RunState.
export const useOutputReaderStore = create<OutputReaderStore>((set) => ({
  request: null,
  views: {},
  open: (request = {}) => set({ request }),
  close: () => set({ request: null }),
  remember: (id, view) => set((state) => {
    const views = { ...state.views, [id]: view }
    const ids = Object.keys(views)
    if (ids.length > 100) delete views[ids[0]]
    return { views }
  }),
}))

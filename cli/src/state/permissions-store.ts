import { create } from 'zustand'

interface PermissionsState {
  isOpen: boolean
  open: () => void
  close: () => void
}

export const usePermissionsStore = create<PermissionsState>()((set) => ({
  isOpen: false,
  open: () => set({ isOpen: true }),
  close: () => set({ isOpen: false }),
}))

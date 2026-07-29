import { create } from 'zustand'
import {
  bootstrapLibrary,
  createCampaign,
  listCampaigns,
  type Library,
  type NewCampaignInput,
} from '@/lib/google/campaignRepo'
import type { CampaignSummary } from '@/types/campaign'

interface LibraryState {
  library: Library | null
  campaigns: CampaignSummary[]
  status: 'idle' | 'loading' | 'ready' | 'error'
  errorMessage: string | null
  load: () => Promise<void>
  refreshCampaigns: () => Promise<void>
  createCampaign: (input: NewCampaignInput) => Promise<CampaignSummary>
}

export const useLibrary = create<LibraryState>((set, get) => ({
  library: null,
  campaigns: [],
  status: 'idle',
  errorMessage: null,

  load: async () => {
    set({ status: 'loading', errorMessage: null })
    try {
      const library = await bootstrapLibrary()
      const campaigns = await listCampaigns(library.campaignsFolderId)
      set({ library, campaigns, status: 'ready' })
    } catch (err) {
      set({ status: 'error', errorMessage: err instanceof Error ? err.message : String(err) })
    }
  },

  refreshCampaigns: async () => {
    const { library } = get()
    if (!library) return
    const campaigns = await listCampaigns(library.campaignsFolderId)
    set({ campaigns })
  },

  createCampaign: async (input) => {
    const { library } = get()
    if (!library) throw new Error('Library not loaded yet.')
    const handle = await createCampaign(library.campaignsFolderId, input)
    await get().refreshCampaigns()
    const created = get().campaigns.find((c) => c.folderId === handle.folderId)
    if (!created) throw new Error('Campaign created but could not be found in the listing.')
    return created
  },
}))

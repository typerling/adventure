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

// bootstrapLibrary's folder lookup is find-then-create with no locking, so two concurrent
// load() calls can each see "no folder yet" and both create one. That's not just a theoretical
// race: React StrictMode double-invokes effects in dev, so Dashboard's mount effect alone
// triggers it. Track the in-flight call so concurrent callers share one bootstrap instead of
// racing (module-level, not store state, since it must survive across renders unconditionally).
let inFlightLoad: Promise<void> | null = null

export const useLibrary = create<LibraryState>((set, get) => ({
  library: null,
  campaigns: [],
  status: 'idle',
  errorMessage: null,

  load: () => {
    if (inFlightLoad) return inFlightLoad
    // Dashboard remounts on every visit (React Router unmounts/remounts route components), but
    // there's no need to re-hit Drive every time — this store is a module-level singleton, so
    // "already loaded" survives across those remounts. refreshCampaigns() (called after creating
    // a campaign) or a full page reload are the paths back to genuinely fresh Drive data.
    if (get().status === 'ready') return Promise.resolve()
    inFlightLoad = (async () => {
      set({ status: 'loading', errorMessage: null })
      try {
        const library = await bootstrapLibrary()
        const campaigns = await listCampaigns(library.campaignsFolderId)
        set({ library, campaigns, status: 'ready' })
      } catch (err) {
        set({ status: 'error', errorMessage: err instanceof Error ? err.message : String(err) })
      } finally {
        inFlightLoad = null
      }
    })()
    return inFlightLoad
  },

  refreshCampaigns: async () => {
    const { library, campaigns: current } = get()
    if (!library) return
    const fetched = await listCampaigns(library.campaignsFolderId)
    // Drive's files.list query can lag a just-created folder by a second or two, so a
    // fetch right after creation may not include it yet. Keep any locally-known entries
    // Drive hasn't caught up to rather than letting a stale fetch make them disappear —
    // a plain full reload (useLibrary.load) always re-syncs to Drive as ground truth.
    const fetchedIds = new Set(fetched.map((c) => c.folderId))
    const notYetVisible = current.filter((c) => !fetchedIds.has(c.folderId))
    set({ campaigns: [...fetched, ...notYetVisible] })
  },

  createCampaign: async (input) => {
    // The library is normally loaded by Dashboard's mount effect, but nothing guarantees
    // Dashboard ever rendered first (a direct link to /new, a reload while on it, or the
    // browser restoring that exact route on relaunch all skip it) — load it here instead
    // of assuming some other page already did.
    if (!get().library) {
      await get().load()
    }
    const { library } = get()
    if (!library) {
      throw new Error(
        get().errorMessage ?? 'Could not load your Google Drive library. Check your connection and try again.',
      )
    }
    const handle = await createCampaign(library.campaignsFolderId, input)

    // Build the summary from what we already know rather than re-listing Drive: the
    // files.list query behind listCampaigns/refreshCampaigns can lag a newly-created
    // folder by a second or two (eventual consistency), which previously surfaced as
    // "campaign created but could not be found" even though it *was* saved.
    const created: CampaignSummary = {
      slug: input.name,
      folderId: handle.folderId,
      name: input.name,
      difficulty: input.difficulty,
      currentTurn: 0,
      updatedAt: new Date().toISOString(),
    }
    set((s) => ({ campaigns: [...s.campaigns, created] }))

    // Best-effort background reconciliation with Drive's actual listing — failures here
    // (including consistency lag) must never undo the optimistic entry above.
    void get()
      .refreshCampaigns()
      .catch(() => {})

    return created
  },
}))

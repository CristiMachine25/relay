import { create } from 'zustand'
import { useStore } from '@/store'
import type { UsageSnapshot } from '@shared/types'
import { nextView, offeredViews, parseLimitView, shownView, type LimitView } from '@/lib/limitView'
import { useGrid } from './store'

const KEY = 'switchyard.limitView'

function load(): LimitView {
  try {
    return parseLimitView(localStorage.getItem(KEY))
  } catch {
    return parseLimitView(null)
  }
}

interface LimitViewState {
  /** The saved choice; panes show `useLimitViews().view`, which falls back when it is not on offer. */
  view: LimitView
  setView(view: LimitView): void
  /** Step to the view after the one showing, among those on offer. */
  cycle(offered: LimitView[]): void
}

/** Which limit every terminal pane shows. One choice for the whole grid, remembered across restarts. */
export const useLimitView = create<LimitViewState>((set, get) => ({
  view: load(),
  setView: (view) => {
    set({ view })
    try {
      localStorage.setItem(KEY, view)
    } catch {
      /* kept for this run only */
    }
  },
  cycle: (offered) => get().setView(nextView(shownView(get().view, offered), offered))
}))

/** The view in effect and the views on offer, given the usage of the accounts a screen lists. */
export function useLimitViewFor(snaps: (UsageSnapshot | undefined)[]): { view: LimitView; views: LimitView[] } {
  const saved = useLimitView((s) => s.view)
  const views = offeredViews(snaps)
  return { view: shownView(saved, views), views }
}

/** The view in effect and the views on offer, given the accounts in the grid's panes. */
export function useLimitViews(): { view: LimitView; views: LimitView[] } {
  const panes = useGrid((s) => s.ws.panes)
  const usage = useStore((s) => s.usage)
  return useLimitViewFor(panes.map((p) => (p.accountId ? usage[p.accountId] : undefined)))
}

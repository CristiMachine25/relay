import type { UsageWindow } from '@shared/types'
import { isModelWindow, leftOf } from './quota'

/** The order every account shows its limits in: the short window, the longer ones, then windows that cap one model. */
export function sortWindows(windows: UsageWindow[]): UsageWindow[] {
  const rank = (w: UsageWindow) => (isModelWindow(w) ? 1 : 0)
  const minutes = (w: UsageWindow) => w.windowMinutes ?? Infinity
  return [...windows].sort((a, b) => rank(a) - rank(b) || minutes(a) - minutes(b))
}

/** At most `max` windows for a tight row: the general ones first, the rest filled by the model windows with the least left. */
export function windowsToShow(windows: UsageWindow[], max: number): UsageWindow[] {
  const sorted = sortWindows(windows)
  if (sorted.length <= max) return sorted
  const general = sorted.filter((w) => !isModelWindow(w))
  const models = sorted.filter(isModelWindow)
  const room = Math.max(0, max - general.length)
  const keep = new Set([...models].sort((a, b) => leftOf(b) - leftOf(a)).slice(models.length - room))
  return sorted.filter((w) => !isModelWindow(w) || keep.has(w)).slice(0, max)
}

/** What fraction of the weekly limit a model window gets, in words: "half of the weekly limit". Null when not a share. */
export function shareText(share: number | null | undefined): string | null {
  if (!share || share <= 0 || share >= 100) return null
  return share === 50 ? 'half of the weekly limit' : `${Math.round(share)}% of the weekly limit`
}

import type { UsageWindow } from '@shared/types'
import { isModelWindow, leftOf } from './quota'
import { formatClock, formatCountdown, formatDay } from './format'

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

const DAY_MS = 86_400_000
const weekday = new Intl.DateTimeFormat('en-US', { weekday: 'short' })

/**
 * The window that has stopped the account: a general one at its limit (a model window only when there is nothing else).
 * When several have run out, the one that comes back last, since that is when the account is usable again.
 */
export function spentWindow(windows: UsageWindow[]): UsageWindow | undefined {
  const general = windows.filter((w) => !isModelWindow(w))
  const back = (w: UsageWindow) => (w.resetsAt ? Date.parse(w.resetsAt) : Infinity)
  return (general.length ? general : windows).filter((w) => leftOf(w) <= 0.5).reduce<UsageWindow | undefined>((a, b) => (!a || back(b) > back(a) ? b : a), undefined)
}

/** The windows a list row shows: only the limit that stopped a spent account, else the usual few. */
export function windowsForList(windows: UsageWindow[], max: number): UsageWindow[] {
  const spent = spentWindow(windows)
  return spent ? [spent] : windowsToShow(windows, max)
}

/** A window that is not counting while `spent` is out: a shorter one, or a model window of the same length. */
export function idleBehind(w: UsageWindow, spent: UsageWindow | undefined): boolean {
  if (!spent || w.id === spent.id || leftOf(w) <= 0.5) return false
  const [mine, theirs] = [w.windowMinutes ?? Infinity, spent.windowMinutes ?? Infinity]
  return mine < theirs || (isModelWindow(w) && mine <= theirs)
}

/** When a spent limit is back: "back in 2h 15m", "back Sat 1:00 PM" past a day, "back Nov 19" past a week. Null when unknown. */
export function backText(iso: string | null | undefined, now: number): string | null {
  const t = iso ? Date.parse(iso) : NaN
  if (Number.isNaN(t)) return null
  const c = formatCountdown(iso, now)
  if (c === 'now') return 'reset due'
  if (t - now < DAY_MS) return `back in ${c}`
  if (t - now < 7 * DAY_MS) return `back ${weekday.format(t)} ${formatClock(iso!)}`
  return `back ${formatDay(t)}`
}

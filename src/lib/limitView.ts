import type { UsageSnapshot, UsageWindow } from '@shared/types'
import { bindingWindow, isModelWindow, leftOf } from './quota'
import { formatPct, resetText } from './format'
import { atLimit } from './grid'

/** Which limit the terminal panes show, named after the window it stands for. */
export type LimitView = 'five_hour' | 'seven_day' | 'seven_day_fable'

export const LIMIT_VIEWS: LimitView[] = ['five_hour', 'seven_day', 'seven_day_fable']

/** The view in words, for "No 5-hour limit" and "Click to show the weekly limit". */
export const VIEW_NAME: Record<LimitView, string> = {
  five_hour: '5-hour limit',
  seven_day: 'weekly limit',
  seven_day_fable: 'weekly Fable limit'
}

/** A saved choice, or 5 hours: the limit that changes while you work. */
export function parseLimitView(raw: string | null | undefined): LimitView {
  return LIMIT_VIEWS.find((v) => v === raw) ?? 'five_hour'
}

/**
 * The window a view shows for one account, or undefined when the account has no such limit.
 * Providers that name their windows differently (Codex primary/secondary, Copilot premium, Gemini per model)
 * show their shortest general window for 5 hours and their longest for the week.
 */
export function viewWindow(snap: UsageSnapshot | undefined, view: LimitView): UsageWindow | undefined {
  const windows = snap?.windows ?? []
  const exact = windows.find((w) => w.id === view)
  if (exact || view === 'seven_day_fable' || windows.some((w) => w.id === 'five_hour' || w.id === 'seven_day')) return exact
  const general = windows.filter((w) => !isModelWindow(w))
  if (!general.length) return undefined
  const sign = view === 'five_hour' ? 1 : -1
  // Among windows of the same length, the one with the least left.
  return general.reduce((a, b) => {
    const d = sign * ((b.windowMinutes ?? 0) - (a.windowMinutes ?? 0))
    return d < 0 || (d === 0 && leftOf(b) < leftOf(a)) ? b : a
  })
}

type Named = Pick<UsageWindow, 'id' | 'label' | 'windowMinutes'>

const DAY = 1440

/** How long a general window runs, as [tag, words]; undefined when its length says nothing familiar. */
function span(w: Named): [string, string] | undefined {
  if (w.id === 'five_hour') return ['5h', '5-hour limit']
  if (w.id === 'seven_day') return ['Week', 'weekly limit']
  if (w.id === 'seven_day_fable') return ['Fable', 'weekly Fable limit']
  if (isModelWindow(w)) return undefined
  const m = w.windowMinutes ?? 0
  if (m === 300) return ['5h', '5-hour limit']
  if (m === DAY) return ['Day', 'daily limit']
  if (m === 7 * DAY) return ['Week', 'weekly limit']
  if (m >= 28 * DAY && m <= 31 * DAY) return ['Month', 'monthly limit']
  return undefined
}

/** The tag in front of a figure, so it says which limit it is: "5h", "Week", "Fable". */
export function shortLabel(w: Named): string {
  return span(w)?.[0] ?? w.label
}

/** The window as a limit, for use in a sentence: "weekly limit", "5-hour limit". */
export function limitName(w: Named): string {
  return span(w)?.[1] ?? (/limit$/i.test(w.label) ? w.label : `${w.label} limit`)
}

/** The views worth offering for these accounts: Fable only when one of them reports that window. */
export function offeredViews(snaps: (UsageSnapshot | undefined)[]): LimitView[] {
  const fable = snaps.some((s) => s?.windows.some((w) => w.id === 'seven_day_fable'))
  return LIMIT_VIEWS.filter((v) => v !== 'seven_day_fable' || fable)
}

/** The view in effect: a saved Fable choice shows the weekly limit while no account has a Fable one. */
export function shownView(saved: LimitView, offered: LimitView[]): LimitView {
  return offered.includes(saved) ? saved : 'seven_day'
}

export function nextView(view: LimitView, offered: LimitView[]): LimitView {
  return offered[(offered.indexOf(view) + 1) % offered.length] ?? view
}

/**
 * The window that has stopped the account when it is not the one on screen.
 * The view only changes what is shown; an account that is out must still say so.
 */
export function hiddenLimit(snap: UsageSnapshot | undefined, shown: Pick<UsageWindow, 'id'> | undefined): UsageWindow | undefined {
  const b = bindingWindow(snap)
  return b && atLimit(snap) && b.id !== shown?.id ? b : undefined
}

/** Every window of an account, one per line, for a tooltip: the other limits are one hover away. */
export function windowsTip(snap: UsageSnapshot | undefined, now: number): string {
  if (!snap?.windows.length) return 'No live limits'
  return snap.windows
    .map((w) => {
      const left = leftOf(w)
      const share = w.shareOfWeekly ? ` (${formatPct(w.shareOfWeekly)} of the weekly limit)` : ''
      const reset = resetText(w.resetsAt, now)
      return `${w.label}${share}: ${left <= 0.5 ? 'limit reached' : `${formatPct(left)} left`}${reset ? ` · ${reset[0]!.toLowerCase()}${reset.slice(1)}` : ''}`
    })
    .join('\n')
}

/** The limits other than the one on screen with under 20% left, tightest first, each with its words ("Week 8% left"). */
export function lowLimits(snap: UsageSnapshot | undefined, shown: Pick<UsageWindow, 'id'> | undefined): { w: UsageWindow; text: string }[] {
  return (snap?.windows ?? [])
    .filter((w) => w.id !== shown?.id && leftOf(w) < 20)
    .sort((a, b) => leftOf(a) - leftOf(b))
    .map((w) => ({ w, text: leftOf(w) <= 0.5 ? `${shortLabel(w)} limit reached` : `${shortLabel(w)} ${formatPct(leftOf(w))} left` }))
}

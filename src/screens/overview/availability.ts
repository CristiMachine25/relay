import type { Account, UsageSnapshot, UsageWindow } from '@shared/types'
import { bindingWindow, isModelWindow, leftOf } from '@/lib/quota'
import { atLimit, isBlocked, isSignedOut } from '@/lib/grid'
import { spentWindow } from '@/lib/windows'

export function nextExhaustedReset(accounts: Account[], usage: Record<string, UsageSnapshot>, now: number) {
  let next: { account: Account; at: string } | undefined
  for (const account of accounts) {
    if (['needs-login', 'expired', 'blocked'].includes(account.status)) continue
    const window = bindingWindow(usage[account.id])
    if (!window?.resetsAt || leftOf(window) >= 1) continue
    const at = Date.parse(window.resetsAt)
    if (at > now && (!next || at < Date.parse(next.at))) next = { account, at: window.resetsAt }
  }
  return next
}

export function isLastKnownUsage(snapshot: UsageSnapshot | undefined, now: number): boolean {
  if (!snapshot) return false
  if (snapshot.stale) return true
  const general = snapshot.windows.filter((window) => !isModelWindow(window))
  return (general.length ? general : snapshot.windows).some((window) => !!window.resetsAt && Date.parse(window.resetsAt) <= now)
}

export interface Resting {
  account: Account
  kind: 'out' | 'signed-out' | 'blocked'
  /** For an account that is out: the limit that stopped it, the one that comes back last. */
  window?: UsageWindow
}

/**
 * The accounts that can be used now, in the order given, and those that cannot: out through a limit (back soonest
 * first), then signed out or blocked. "Out" is the same as everywhere else (grid's atLimit), whatever limit view is on.
 */
export function splitFleet(accounts: Account[], usage: Record<string, UsageSnapshot>): { ready: Account[]; resting: Resting[] } {
  const ready: Account[] = []
  const out: Resting[] = []
  const stuck: Resting[] = []
  for (const account of accounts) {
    if (isSignedOut(account)) stuck.push({ account, kind: 'signed-out' })
    else if (isBlocked(account)) stuck.push({ account, kind: 'blocked' })
    else if (atLimit(usage[account.id])) out.push({ account, kind: 'out', window: spentWindow(usage[account.id]!.windows) })
    else ready.push(account)
  }
  const back = (r: Resting) => (r.window?.resetsAt ? Date.parse(r.window.resetsAt) : Infinity)
  // Infinity - Infinity is NaN, which would leave the order to chance.
  out.sort((a, b) => (back(a) === back(b) ? 0 : back(a) < back(b) ? -1 : 1))
  return { ready, resting: [...out, ...stuck] }
}

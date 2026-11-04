import type { Account, UsageSnapshot } from '@shared/types'
import { bindingWindow, isModelWindow, leftOf } from '@/lib/quota'

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

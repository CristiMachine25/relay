import type { Account, UsageSnapshot } from '@shared/types'
import { bindingWindow, leftOf } from '@/lib/quota'

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

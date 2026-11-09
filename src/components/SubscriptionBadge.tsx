import clsx from 'clsx'
import { CalendarClock, CalendarSync, CalendarX } from 'lucide-react'
import type { Account } from '@shared/types'
import { subscriptionFor, subscriptionText, subscriptionTip, type SubscriptionInfo, type SubscriptionUrgency } from '@/lib/subscription'

export const URGENCY_TEXT: Record<SubscriptionUrgency, string> = {
  calm: 'text-muted',
  soon: 'text-low',
  now: 'text-empty'
}

/** A looping calendar for a plan that renews, a crossed one for a plan that stops, a clock when nobody has said. */
export function subscriptionIcon(s: SubscriptionInfo) {
  return s.state === 'renews' ? CalendarSync : s.state === 'unknown-renewal' ? CalendarClock : CalendarX
}

/** One quiet line for an account row: when its plan renews or ends. Renders nothing when that is unknown. */
export function SubscriptionBadge({ account, now, className }: { account: Pick<Account, 'subscription' | 'renewsOn' | 'autoRenew'>; now: number; className?: string }) {
  const s = subscriptionFor(account, now)
  const text = subscriptionText(s)
  if (!text) return null
  const Icon = subscriptionIcon(s)
  return (
    <span className={clsx('flex min-w-0 items-center gap-1 text-xs', URGENCY_TEXT[s.urgency], className)} data-tip={subscriptionTip(s) ?? undefined}>
      <Icon size={12} className="shrink-0" aria-hidden />
      <span className="truncate">{text}</span>
    </span>
  )
}

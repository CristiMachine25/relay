import type { Account } from '@shared/types'
import { formatDay, plural } from './format'

/**
 * What the paid plan will do next: renew by itself, end on a day, bill on a day with auto-renew not said,
 * or nothing known. "ended" is a plan with auto-renew off whose day has passed.
 */
export type SubscriptionState = 'renews' | 'ends' | 'unknown-renewal' | 'canceled' | 'ended' | 'none'

/** How loudly to show it: only a plan that stops by itself is ever urgent. */
export type SubscriptionUrgency = 'calm' | 'soon' | 'now'

export interface SubscriptionInfo {
  state: SubscriptionState
  /** The day it renews or ends, as a local YYYY-MM-DD. */
  day: string | null
  /** Whole days until that day: 0 is today, negative once it has passed. */
  daysLeft: number | null
  /** The day was worked out from the start date or rolled on from a past one, not read or set as it is. */
  estimated: boolean
  autoRenew: boolean | null
  urgency: SubscriptionUrgency
  /** The day the plan began, when the provider says. */
  startedOn: string | null
  /** The past day set by hand that `day` was rolled on from. */
  rolledFrom: string | null
}

type Sub = Pick<Account, 'subscription' | 'renewsOn' | 'autoRenew'>

const pad = (n: number) => String(n).padStart(2, '0')
const toDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

function parseTime(iso: string | null | undefined): Date | null {
  const t = iso ? Date.parse(iso) : NaN
  return Number.isNaN(t) ? null : new Date(t)
}

/** A real calendar day written YYYY-MM-DD, or null ("2026-02-31" is not one). */
function parseDay(day: string | null | undefined): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day ?? '')
  if (!m) return null
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  return toDay(d) === day ? d : null
}

function daysBetween(from: Date, to: Date): number {
  const utc = (d: Date) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())
  return Math.round((utc(to) - utc(from)) / 86_400_000)
}

/**
 * `months` after `start`, on the same day of the month and at the same time, or on the month's last day when
 * it is shorter. Always counted from the start itself, so a plan begun on the 31st comes back to the 31st.
 */
function monthsAfter(start: Date, months: number): Date {
  const month = start.getMonth() + months
  const last = new Date(start.getFullYear(), month + 1, 0).getDate()
  return new Date(start.getFullYear(), month, Math.min(start.getDate(), last), start.getHours(), start.getMinutes(), start.getSeconds())
}

/** The first monthly return of `start` that `passed` does not rule out. */
function nextMonthly(start: Date, now: Date, passed: (d: Date) => boolean): Date {
  let months = Math.max(1, (now.getFullYear() - start.getFullYear()) * 12 + now.getMonth() - start.getMonth())
  while (passed(monthsAfter(start, months))) months++
  return monthsAfter(start, months)
}

/**
 * When an account's plan renews or ends, and how sure that is. A day set by hand wins, then the exact end a
 * provider reports, then an estimate: the next monthly anniversary of the day the plan started.
 */
export function subscriptionFor(a: Sub, now: number = Date.now()): SubscriptionInfo {
  const today = new Date(now)
  const started = parseTime(a.subscription?.startedAt)
  const info: SubscriptionInfo = {
    state: 'none',
    day: null,
    daysLeft: null,
    estimated: false,
    autoRenew: a.autoRenew ?? null,
    urgency: 'calm',
    startedOn: started ? toDay(started) : null,
    rolledFrom: null
  }
  // The provider's word that the plan is over beats a note made by hand.
  if (a.subscription?.status === 'canceled') return { ...info, state: 'canceled', autoRenew: false }

  const set = parseDay(a.renewsOn)
  const exact = set ?? parseTime(a.subscription?.endsAt)
  const ahead = (d: Date) => daysBetween(today, d) >= 0
  let day: Date
  if (exact && (ahead(exact) || info.autoRenew === false)) {
    day = exact
  } else if (set) {
    // A day in the past on a plan that may still renew: its next monthly return.
    day = nextMonthly(set, today, (d) => !ahead(d))
    info.estimated = true
    info.rolledFrom = toDay(set)
  } else if (started) {
    day = nextMonthly(started, today, (d) => d.getTime() <= now)
    info.estimated = true
  } else {
    return info
  }

  const daysLeft = daysBetween(today, day)
  const state = daysLeft < 0 ? 'ended' : info.autoRenew === true ? 'renews' : info.autoRenew === false ? 'ends' : 'unknown-renewal'
  const urgency = state === 'ended' || (state === 'ends' && daysLeft <= 2) ? 'now' : state === 'ends' && daysLeft <= 7 ? 'soon' : 'calm'
  return { ...info, state, day: toDay(day), daysLeft, urgency }
}

/** "Nov 16", with the year once it is far enough off to be mistaken for this year's. */
function dateText(s: SubscriptionInfo): string {
  return s.day ? formatDay(s.day, Math.abs(s.daysLeft ?? 0) > 180) : ''
}

/** The short line for a row: "Renews Nov 16", "Ends tomorrow", "Next billing day Nov 16 (est.)". Null when nothing is known. */
export function subscriptionText(s: SubscriptionInfo): string | null {
  if (s.state === 'none') return null
  if (s.state === 'canceled') return 'Subscription canceled'
  if (s.state === 'ended') return `Ended ${dateText(s)}`
  const what = s.state === 'renews' ? 'Renews' : s.state === 'ends' ? 'Ends' : 'Next billing day'
  const when = s.daysLeft === 0 ? 'today' : s.daysLeft === 1 ? 'tomorrow' : dateText(s)
  return `${what} ${when}${s.estimated ? ' (est.)' : ''}`
}

/** What goes with the short line: "in 7 days, auto-renew off". */
export function subscriptionDetail(s: SubscriptionInfo): string {
  if (s.state === 'none') return 'No subscription details yet'
  if (s.state === 'canceled') return 'will not renew'
  const days = s.daysLeft ?? 0
  const when = days < 0 ? `${plural(-days, 'day')} ago` : days <= 1 ? dateText(s) : `in ${plural(days, 'day')}`
  const renew = s.state === 'renews' ? '' : s.autoRenew === false ? ', auto-renew off' : ', auto-renew not set'
  return when + renew
}

/** Why a day is only an estimate, and what to do about it. Null for a day that is exact. */
export function subscriptionNote(s: SubscriptionInfo): string | null {
  if (!s.estimated) return null
  if (s.rolledFrom) return `Estimated from the day you set (${formatDay(s.rolledFrom)}), which has passed. Set the new day if that is wrong.`
  return `Estimated from the day the plan started (${s.startedOn ? formatDay(s.startedOn) : 'unknown'}). Set the day by hand if it is a yearly plan.`
}

/** Everything in one sentence or two, for a tooltip. */
export function subscriptionTip(s: SubscriptionInfo): string | null {
  const text = subscriptionText(s)
  if (!text) return null
  const note = subscriptionNote(s)
  return `${text}, ${subscriptionDetail(s)}.${note ? ` ${note}` : ''}`
}

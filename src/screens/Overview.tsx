import { useEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import { AlertTriangle, Ban, ChevronDown, Clock, LogIn, Plus, RefreshCw, Search, WifiOff } from 'lucide-react'
import type { Account, DailyActivity, ProviderId, UsageHistoryPoint, UsageSnapshot } from '@shared/types'
import { api } from '@/api'
import { modKey } from '@/lib/platform'
import { useStore } from '@/store'
import { PROVIDER_META, PROVIDER_ORDER } from '@/lib/providers'
import { statusLabel } from '@/lib/grid'
import { liveSnoozes, useSnoozes } from '@/lib/snooze'
import { computeAlerts, longWindow, unusedAtResets, wastedValue, type Alert } from '@/lib/quota'
import { creditsText, formatAgo, formatCountdown, formatMoney, formatPct, plural, resetText, windowName } from '@/lib/format'
import { WindowGauge } from '@/components/Meter'
import { lowLimits, shortLabel, viewWindow, windowsTip, VIEW_NAME, type LimitView } from '@/lib/limitView'
import { LimitSwitch } from '@/components/LimitSwitch'
import { useLimitSwitch } from '@/terminals/limitView'
import { SubscriptionBadge } from '@/components/SubscriptionBadge'
import { subscriptionFor } from '@/lib/subscription'
import { AccountDot, ProviderMark, Segmented, SectionTitle } from '@/components/ui'
import { PrimaryLaunch } from '@/components/PrimaryLaunch'
import { UsageOverTime } from '@/charts/UsageOverTime'
import { MostUsed, type ActivityMetric } from '@/charts/MostUsed'
import { Page } from '@/components/Page'
import { AutopilotCard } from '@/autopilot/AutopilotCard'
import { splitFleet, outText, type Resting } from './overview/availability'
import { FirstRun } from './overview/FirstRun'
import { Advisor } from './overview/Advisor'
import { ContinueWork } from './overview/ContinueWork'

export function Overview() {
  const accounts = useStore((s) => s.accounts)
  const usage = useStore((s) => s.usage)
  const settings = useStore((s) => s.settings)
  const now = useStore((s) => s.now)
  const setAddOpen = useStore((s) => s.setAddOpen)
  const setPalette = useStore((s) => s.setPalette)

  const [history, setHistory] = useState<UsageHistoryPoint[]>([])
  const [activity, setActivity] = useState<DailyActivity[]>([])
  const [days, setDays] = useState<'7' | '30'>('30')
  const [metric, setMetric] = useState<ActivityMetric>('tokens')

  const accountKey = accounts.map((a) => a.id).join(',')
  useEffect(() => {
    let live = true
    Promise.all([api.usage.history(null, 30), api.usage.activity(null, 30)])
      .then(([h, a]) => {
        if (live) {
          setHistory(h)
          setActivity(a)
        }
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [accountKey])

  const snoozed = useSnoozes((s) => s.snoozed)
  const alerts = useMemo(() => {
    if (!settings) return []
    // Sign-in reminders the user put off stay hidden until the account's status changes.
    const off = liveSnoozes(snoozed, accounts)
    // An account that is out already waits under "Out for now": its limits are not an alert on top of that.
    const out = new Set(splitFleet(accounts, usage).resting.filter((r) => r.kind === 'out').map((r) => r.account.id))
    return computeAlerts(accounts, usage, settings, now).filter(
      (al) => !(al.kind === 'needs-login' && off[al.accountId]) && !(out.has(al.accountId) && ['limit-reached', 'nearly-exhausted', 'use-it-or-lose-it'].includes(al.kind))
    )
  }, [accounts, usage, settings, now, snoozed])

  if (accounts.length === 0) {
    return (
      <Page title="Start work">
        <FirstRun onAdd={() => setAddOpen(true)} />
      </Page>
    )
  }

  const activitySince = Date.now() - Number(days) * 86_400_000
  const act = activity.filter((d) => Date.parse(d.date + 'T23:59:59') >= activitySince)

  return (
    <Page
      title="Start work"
      actions={
        // The palette has no button of its own; this is where its shortcut is learned.
        <button className="btn btn-ghost btn-sm" onClick={() => setPalette(true)} data-tip="Launch any account or jump to a screen">
          <Search size={13} /> Find and launch <span className="kbd">{modKey(api.platform)} K</span>
        </button>
      }
    >
      <div>
        <h2 className="text-3xl font-semibold tracking-tight">What are you working on?</h2>
        <p className="mt-2 text-muted">Choose a task. Find an account with room. Keep your work moving.</p>
      </div>
      <ContinueWork />
      <Advisor />
      <AutopilotCard />
      {alerts.length > 0 && <Alerts alerts={alerts} />}
      <Board />
      <details className="group rounded-lg border border-rivet bg-deck p-5">
        <summary className="cursor-pointer font-semibold">Usage history <span className="ml-2 text-xs font-normal text-muted">Explore patterns and unused quota</span></summary>
        <section className="mt-5" aria-labelledby="history-title">
        <SectionTitle
          aside={
            <Segmented
              size="sm"
              label="Time range"
              value={days}
              onChange={setDays}
              options={[
                { id: '7', label: '7 days' },
                { id: '30', label: '30 days' }
              ]}
            />
          }
        >
          <span id="history-title">Usage history</span>
        </SectionTitle>
        <div className="grid grid-cols-1 gap-x-8 gap-y-8 rounded-lg border border-rivet p-6 min-[1180px]:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
          <div className="min-w-0">
            <div className="mb-4 flex min-h-7 items-center">
              <h3 className="font-semibold">Weekly and monthly limits used</h3>
            </div>
            <UsageOverTime accounts={accounts} usage={usage} history={history} days={Number(days)} />
          </div>
          <div className="min-w-0 border-t border-rivet pt-6 min-[1180px]:border-l min-[1180px]:border-t-0 min-[1180px]:pl-8 min-[1180px]:pt-0">
            <div className="mb-4 flex min-h-7 items-center justify-between gap-3">
              <h3 className="font-semibold">Most used, last {days} days</h3>
              <Segmented
                size="sm"
                label="Measure"
                value={metric}
                onChange={setMetric}
                options={[
                  { id: 'tokens', label: 'Tokens' },
                  { id: 'messages', label: 'Messages' }
                ]}
              />
            </div>
            <MostUsed accounts={accounts} activity={act} metric={metric} />
            <Unused accounts={accounts} usage={usage} history={history} />
          </div>
        </div>
        </section>
      </details>
    </Page>
  )
}

function alertCopy(al: Alert, a: Account, snap: UsageSnapshot | undefined, now: number): string {
  const w = snap?.windows.find((x) => x.id === al.windowId)
  const name = w ? windowName(w.label) : 'limit'
  const c = formatCountdown(al.resetsAt, now)
  switch (al.kind) {
    case 'use-it-or-lose-it':
      return `${a.label} has ${formatPct(al.left ?? 0)} of its ${name} left, and it resets in ${c}. Use it or lose it.`
    case 'limit-reached':
      return `${a.label} hit its ${name}${/limit|requests/.test(name) ? '' : ' limit'}${c && c !== 'now' ? `. Back in ${c}` : ''}.`
    case 'nearly-exhausted':
      return `${a.label} has only ${formatPct(al.left ?? 0)} of its ${name} left. ${resetText(al.resetsAt, now) ?? ''}.`
    case 'needs-login':
      return `${a.label} is signed out, so its limits aren't tracked.`
    case 'blocked':
      return `${a.label} can't use ${PROVIDER_META[a.providerId].product}.`
    case 'stale':
      return `${a.label}: usage last checked ${formatAgo(snap?.fetchedAt, now)}. ${snap?.error ?? ''}`
  }
}

const ALERT_ICON = {
  'use-it-or-lose-it': Clock,
  'limit-reached': AlertTriangle,
  'nearly-exhausted': AlertTriangle,
  'needs-login': LogIn,
  blocked: Ban,
  stale: WifiOff
}

function Alerts({ alerts }: { alerts: Alert[] }) {
  const accounts = useStore((s) => s.accounts)
  const usage = useStore((s) => s.usage)
  const now = useStore((s) => s.now)
  const providers = useStore((s) => s.providers)
  const { launch, refresh, go } = useStore.getState()
  const [all, setAll] = useState(false)
  const list = useRef<HTMLUListElement>(null)
  const shown = all ? alerts : alerts.slice(0, 3)
  // The alert goes away with its button: keep focus on the alert now in its place, the one
  // before it, or the board when none are left.
  const snooze = (a: Account, i: number) => {
    useSnoozes.getState().snooze(a)
    requestAnimationFrame(() => {
      const items = list.current?.querySelectorAll('li') ?? []
      const next = (items[i] ?? items[i - 1])?.querySelector('button') ?? document.getElementById('board-title')
      next?.focus()
    })
  }
  return (
    <section aria-label="Alerts" className="overflow-hidden rounded-lg border border-rivet">
      <ul ref={list} className="divide-y divide-rivet">
        {shown.map((al, i) => {
          const a = accounts.find((x) => x.id === al.accountId)
          if (!a) return null
          const Icon = ALERT_ICON[al.kind]
          const tone =
            al.kind === 'use-it-or-lose-it'
              ? 'text-hop'
              : al.kind === 'limit-reached' || al.kind === 'blocked'
                ? 'text-empty'
                : al.kind === 'nearly-exhausted'
                  ? 'text-low'
                  : 'text-muted'
          return (
            <li key={i} className="flex min-h-12 flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2">
              <Icon size={16} className={clsx('shrink-0', tone)} aria-hidden />
              <p className="min-w-0 flex-1 basis-64">{alertCopy(al, a, usage[a.id], now)}</p>
              <div className="ml-auto flex shrink-0 items-center gap-2 empty:hidden">
                {al.kind === 'use-it-or-lose-it' && (
                  <PrimaryLaunch account={a} prov={providers.find((p) => p.id === a.providerId)} className="btn btn-sm" />
                )}
                {al.kind === 'needs-login' && (
                  <>
                    <button className="btn btn-sm" onClick={() => launch(a.id, 'login')}>
                      Sign in
                    </button>
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={() => snooze(a, i)}
                      aria-label={`Not now for ${a.label}`}
                      data-tip="Hide this until the account signs in or its status changes"
                    >
                      Not now
                    </button>
                  </>
                )}
                {al.kind === 'blocked' && (
                  <button className="btn btn-sm" onClick={() => go('accounts', a.id)} aria-label={`Details for ${a.label}`}>
                    Details
                  </button>
                )}
                {al.kind === 'stale' && (
                  <button className="btn btn-sm" onClick={() => refresh(a.id)}>
                    <RefreshCw size={12} /> Check again
                  </button>
                )}
              </div>
            </li>
          )
        })}
      </ul>
      {alerts.length > 3 && (
        <button
          className="flex h-8 w-full items-center gap-3 border-t border-rivet px-4 text-xs text-muted hover:bg-raised hover:text-ink"
          onClick={() => setAll(!all)}
          aria-expanded={all}
        >
          <ChevronDown size={16} className={clsx('shrink-0 transition-transform', all && 'rotate-180')} aria-hidden />
          {all ? 'Show fewer' : `Show ${plural(alerts.length - 3, 'more alert')}`}
        </button>
      )}
    </section>
  )
}

/** Every account at a glance, grouped by tool. Accounts that can be used come first; those that are out wait below, quietly. */
export function Board() {
  const accounts = useStore((s) => s.accounts)
  const usage = useStore((s) => s.usage)
  const now = useStore((s) => s.now)
  const setAddOpen = useStore((s) => s.setAddOpen)
  const { view, views, setView } = useLimitSwitch(accounts)
  const groups = PROVIDER_ORDER.map((p) => ({ p, list: accounts.filter((a) => a.providerId === p) })).filter((g) => g.list.length)

  return (
    <section aria-labelledby="board-title">
      <SectionTitle
        aside={
          <div className="flex flex-wrap items-center justify-end gap-x-4 gap-y-2">
            <LimitSwitch view={view} views={views} onChange={setView} subject="account" />
            <button className="btn btn-ghost btn-sm" onClick={() => setAddOpen(true)}>
              <Plus size={14} /> Add account
            </button>
          </div>
        }
      >
        <span id="board-title" tabIndex={-1}>
          All accounts
        </span>
      </SectionTitle>
      <div className="overflow-hidden rounded-lg border border-rivet">
        {groups.map(({ p, list }, gi) => {
          const { ready, resting } = splitFleet(list, usage)
          return (
            <div key={p} role="group" aria-label={PROVIDER_META[p].product}>
              <div className={clsx('flex h-8 items-center gap-2 border-b border-rivet bg-deck px-4 text-xs text-muted', gi > 0 && 'border-t')}>
                <ProviderMark id={p} size={14} />
                <span className="font-medium text-ink">{PROVIDER_META[p].product}</span>
              </div>
              {ready.length > 0 && (
                <ul className="divide-y divide-rivet">
                  {ready.map((a) => (
                    <BoardRow key={a.id} a={a} snap={usage[a.id]} now={now} provider={p} view={view} />
                  ))}
                </ul>
              )}
              {resting.length > 0 && (
                <>
                  <p className={clsx('flex h-7 items-center bg-well px-4 text-xs text-faint', ready.length > 0 && 'border-t border-rivet')}>
                    Out for now · {resting.length}
                  </p>
                  <ul className="divide-y divide-rivet border-t border-rivet">
                    {resting.map((r) => (
                      <RestingRow key={r.account.id} r={r} now={now} provider={p} />
                    ))}
                  </ul>
                </>
              )}
            </div>
          )
        })}
      </div>
    </section>
  )
}

/** The account's name and what it is, as one button to its details. */
function AccountName({ a, provider, snap, now, dim }: { a: Account; provider: ProviderId; snap?: UsageSnapshot; now: number; dim?: boolean }) {
  const go = useStore((s) => s.go)
  return (
    <button className="flex min-w-0 items-center gap-2.5 text-left" onClick={() => go('accounts', a.id)} data-tip="Show details">
      <span className={clsx('flex', dim && 'opacity-40')}>
        <AccountDot account={a} />
      </span>
      <span className="min-w-0">
        <span className={clsx('block truncate font-semibold', dim && 'text-muted')}>{a.label}</span>
        {!dim && (
          <>
            <span className="flex items-center gap-1 truncate text-xs text-muted">
              <ProviderMark id={provider} size={11} />
              {statusLabel(a) ?? (snap?.stale ? `Checked ${formatAgo(snap.fetchedAt, now)}` : a.plan && !a.label.includes(a.plan) ? a.plan : PROVIDER_META[provider].short)}
            </span>
            <SubscriptionBadge account={a} now={now} className="mt-0.5" />
          </>
        )}
      </span>
    </button>
  )
}

/** An account that cannot be used now, on one quiet line: why, and when it is back. */
function RestingRow({ r, now, provider }: { r: Resting; now: number; provider: ProviderId }) {
  const { launch } = useStore.getState()
  const prov = useStore((s) => s.providers.find((p) => p.id === r.account.providerId))
  const a = r.account
  const why =
    r.kind === 'out'
      ? outText(r.window, now)
      : r.kind === 'signed-out'
        ? (a.statusMessage ?? 'Signed out. Sign in to see this account’s limits.')
        : (a.statusMessage ?? `This account can't use ${PROVIDER_META[provider].product}.`)
  return (
    <li className="flex min-h-10 items-center gap-4 px-4 py-1.5 text-muted hover:bg-deck focus-within:bg-deck">
      <div className="w-[10.5rem] shrink-0 min-[1180px]:w-[15rem]">
        <AccountName a={a} provider={provider} now={now} dim />
      </div>
      <p className="min-w-0 flex-1 truncate text-xs" title={why}>
        {why}
      </p>
      {/* A plan about to end matters even while the account is out; a calm renewal stays in the details. */}
      {subscriptionFor(a, now).urgency !== 'calm' && <SubscriptionBadge account={a} now={now} className="shrink-0" />}
      <div className="flex w-[92px] shrink-0 justify-end">
        {r.kind === 'signed-out' ? (
          <button className="btn btn-sm w-[92px]" onClick={() => launch(a.id, 'login')}>
            <LogIn size={13} /> Sign in
          </button>
        ) : r.kind === 'out' ? (
          <PrimaryLaunch account={a} prov={prov} className="btn btn-ghost btn-sm w-[92px]" short atLimit />
        ) : null}
      </div>
    </li>
  )
}

/** The one limit the switch is on, named; other limits that are low are marked, the rest are a hover away. */
function LimitCell({ snap, now, view, refreshing }: { snap: UsageSnapshot; now: number; view: LimitView; refreshing: boolean }) {
  const w = viewWindow(snap, view)
  const low = lowLimits(snap, w).slice(0, 2)
  return (
    <div className="flex min-w-0 items-center gap-x-4" data-tip={windowsTip(snap, now)}>
      <div className="min-w-0 flex-1 basis-0 max-w-[22rem]">
        {w ? (
          <WindowGauge w={w} now={now} compact name={shortLabel(w)} stale={snap.stale} refreshing={refreshing} />
        ) : (
          <p className="text-xs text-muted">No {VIEW_NAME[view]}</p>
        )}
      </div>
      {low.length > 0 && (
        <p className="flex shrink-0 flex-col text-xs font-medium text-low">
          {low.map((l) => (
            <span key={l.w.id} className="whitespace-nowrap">
              {l.text}
            </span>
          ))}
        </p>
      )}
    </div>
  )
}

function BoardRow({ a, snap, now, provider, view }: { a: Account; snap?: UsageSnapshot; now: number; provider: ProviderId; view: LimitView }) {
  const prov = useStore((s) => s.providers.find((p) => p.id === a.providerId))
  const refreshing = useStore((s) => s.refreshingIds.includes(a.id))
  return (
    <li className="grid grid-cols-[10.5rem_minmax(0,1fr)_auto] items-center gap-4 px-4 py-3 min-[1180px]:grid-cols-[15rem_minmax(0,1fr)_auto] min-[1180px]:gap-6 hover:bg-deck focus-within:bg-deck">
      <AccountName a={a} provider={provider} snap={snap} now={now} />
      <div className="min-w-0">
        {snap && snap.windows.length ? (
          <div className="flex items-center gap-4">
            <div className="min-w-0 flex-1">
              <LimitCell snap={snap} now={now} view={view} refreshing={refreshing} />
            </div>
            {snap.credits && snap.windows.length < 3 && <div className="shrink-0 self-center text-xs text-muted">{creditsText(snap.credits)}</div>}
          </div>
        ) : (
          <p className="text-muted">
            {snap?.error ?? 'No usage data yet.'}
            {snap?.credits && ` ${creditsText(snap.credits)}.`}
          </p>
        )}
      </div>
      <div className="flex justify-end">
        <PrimaryLaunch account={a} prov={prov} className="btn btn-sm w-[92px]" short />
      </div>
    </li>
  )
}

/** Bonus: paid quota that reset without being used, from history. */
function Unused({ accounts, usage, history }: { accounts: Account[]; usage: Record<string, UsageSnapshot>; history: UsageHistoryPoint[] }) {
  const rows = useMemo(() => {
    return accounts
      .map((a) => {
        const w = longWindow(usage[a.id])
        if (!w || !a.monthlyCost) return null
        const unused = unusedAtResets(
          history.filter((p) => p.accountId === a.id),
          w.id
        )
        const perPeriod = a.monthlyCost * ((w.windowMinutes ?? 10080) / 43_200)
        return { a, value: wastedValue(unused, perPeriod), resets: unused.length }
      })
      .filter((r): r is { a: Account; value: number; resets: number } => !!r && r.value >= 1)
      .sort((x, y) => y.value - x.value)
  }, [accounts, usage, history])
  if (!rows.length) return null
  const total = rows.reduce((s, r) => s + r.value, 0)
  return (
    <div className="mt-6 border-t border-rivet pt-4">
      <p className="flex flex-wrap items-baseline gap-x-2">
        <span className="font-sans text-lg font-semibold tabular-nums">About {formatMoney(Math.round(total))}</span>
        <span className="text-muted">of paid quota reset unused in the last 30 days.</span>
      </p>
      <p className="mt-2 max-w-[72ch] text-xs text-muted">
        Most from {rows
          .slice(0, 2)
          .map((r) => `${r.a.label} (${formatMoney(Math.round(r.value))})`)
          .join(' and ')}
        . Estimated from your monthly cost and how full each weekly limit was when it reset.
      </p>
    </div>
  )
}

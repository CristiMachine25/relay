import { useState } from 'react'
import { ArrowUpRight, Loader2, RefreshCw, RotateCcw, SquareTerminal } from 'lucide-react'
import type { Account, ProviderId, Recommendation, UsageSnapshot } from '@shared/types'
import { errorText } from '@/api'
import { useStore } from '@/store'
import { useGrid } from '@/terminals/store'
import { PROVIDER_META, PROVIDER_ORDER, TASKS, primaryTarget, primaryVerb } from '@/lib/providers'
import { bindingWindow, leftOf } from '@/lib/quota'
import { formatAgo, formatCountdown, formatPct, resetText, windowName } from '@/lib/format'
import { AccountDot, ProviderMark, Segmented } from '@/components/ui'
import { Meter } from '@/components/Meter'
import { PrimaryLaunch } from '@/components/PrimaryLaunch'
import { isLastKnownUsage, nextExhaustedReset } from './availability'

export function Advisor() {
  const { task, setTask, recs, recsLoading, recsError, accounts, usage, now, providers, launching } = useStore()
  const [provider, setProvider] = useState<ProviderId | 'all'>('all')
  const [starting, setStarting] = useState(false)
  const restored = useGrid((s) => s.restored)
  const { launch, go, loadRecs } = useStore.getState()
  const candidates = accounts.filter((a) => provider === 'all' || a.providerId === provider)
  const usable = recs.filter((r) => r.score > 0 && candidates.some((a) => a.id === r.accountId))
  const top = usable[0]
  const account = top && candidates.find((a) => a.id === top.accountId)
  const snap = account && usage[account.id]
  const window = bindingWindow(snap)
  const lastKnown = isLastKnownUsage(snap, now)
  const prov = account && providers.find((p) => p.id === account.providerId)
  const target = primaryTarget(prov)
  const canEmbed = prov?.cliInstalled === true
  const nextReset = nextExhaustedReset(candidates, usage, now)
  const openWorkspace = async (resume = false) => {
    if (!account || starting || !restored || recsLoading || recsError) return
    setStarting(true)
    try {
      await useGrid.getState().restore()
      const grid = useGrid.getState()
      if (grid.ws.panes.length >= 9 && grid.ws.panes.every((pane) => pane.accountId)) grid.newSession()
      await useGrid.getState().openInGrid(account.id, { resume })
    } catch (error) {
      useStore.getState().toast({ kind: 'error', title: 'Could not open workspace', body: errorText(error) })
    } finally { setStarting(false) }
  }

  return (
    <section aria-labelledby="advisor-title" className="overflow-hidden rounded-xl border border-rivet bg-deck">
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-rivet px-6 py-4">
        <Segmented label="Kind of task" value={task} onChange={setTask} options={[{ id: 'any', label: 'Anything' }, ...TASKS.map((t) => ({ id: t.id, label: t.label, title: t.hint }))]} />
        <label className="flex items-center gap-2 text-xs text-muted">Tool
          <select value={provider} onChange={(e) => setProvider(e.target.value as ProviderId | 'all')}>
            <option value="all">All tools</option>
            {PROVIDER_ORDER.map((id) => <option key={id} value={id}>{PROVIDER_META[id].short}</option>)}
          </select>
        </label>
      </div>
      <div className="grid min-[1100px]:grid-cols-[minmax(0,1fr)_300px]">
        <div className="min-w-0 p-6">
          <h3 id="advisor-title" className="text-sm font-semibold text-muted">Suggested for your task</h3>
          {recsLoading ? (
            <p role="status" className="flex items-center gap-2 py-8 text-muted"><Loader2 size={16} className="animate-spin" /> Finding an account for this task…</p>
          ) : recsError ? (
            <div className="py-6" role="status">
              <p className="font-semibold">Suggestions are unavailable</p>
              <p className="mt-2 text-muted">You can still choose an account below, or try again.</p>
              <button className="btn mt-4" onClick={() => void loadRecs()}><RefreshCw size={14} /> Try again</button>
            </div>
          ) : !account ? (
            <div className="py-6">
              <p className="text-lg font-semibold">{candidates.length ? 'No account is suggested right now' : 'No accounts for this tool yet'}</p>
              <p className="mt-2 text-muted">{nextReset ? `${nextReset.account.label} has an exhausted limit resetting in ${formatCountdown(nextReset.at, now)}. Other limits may still apply.` : 'Check account access and usage, or connect another account.'}</p>
              <button className="btn mt-4" onClick={() => candidates.length ? go('accounts') : useStore.getState().setAddOpen(true)}>{candidates.length ? 'Review accounts' : 'Connect an account'}</button>
            </div>
          ) : (
            <>
              <div className="mt-4 flex flex-wrap items-center gap-3">
                <AccountDot account={account} size={13} />
                <button className="min-w-0 truncate text-2xl font-semibold tracking-tight hover:underline" onClick={() => go('accounts', account.id)}>{account.label}</button>
              </div>
              <p className="mt-2 flex items-center gap-2 text-muted"><ProviderMark id={account.providerId} size={15} />{PROVIDER_META[account.providerId].product}{account.plan ? ` · ${account.plan}` : ''}</p>
              <p className="mt-4 max-w-[72ch] text-muted">{top.reason}</p>
              {window ? (
                <div className="mt-4 rounded-lg border border-rivet bg-ground p-4">
                  <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
                    <p><strong className="text-3xl font-semibold tracking-tight">{formatPct(leftOf(window))}</strong><span className="ml-2 text-muted">{lastKnown ? 'last known, left of' : 'left of'} {windowName(window.label)}</span></p>
                    <span className="text-xs text-muted">{resetText(window.resetsAt, now) ?? 'Reset time unavailable'}</span>
                  </div>
                  <Meter left={leftOf(window)} cells={32} size="sm" label={`${account.label}, ${window.label}`} />
                  <p className="mt-2 text-xs text-muted">{lastKnown ? 'Last known usage · refresh to verify' : 'Usage checked'} {formatAgo(snap?.fetchedAt, now)}</p>
                </div>
              ) : <p className="mt-5 rounded-lg border border-rivet p-4 text-muted">Usage unknown. Check this account’s limits before starting a long session.</p>}
              <div className="mt-4 flex flex-wrap gap-2">
                {canEmbed && <button className="btn btn-primary btn-lg" disabled={starting || !restored} onClick={() => void openWorkspace()}><SquareTerminal size={16} />{starting ? 'Opening…' : !restored ? 'Connecting workspace…' : 'Open workspace'}</button>}
                <button className={canEmbed ? 'btn btn-lg' : 'btn btn-primary btn-lg'} disabled={launching === account.id + target} onClick={() => void launch(account.id, target)}><ArrowUpRight size={15} />{canEmbed ? 'External terminal' : primaryVerb(account.providerId, prov)}</button>
                {canEmbed && <button className="btn btn-ghost btn-lg" disabled={starting || !restored} onClick={() => void openWorkspace(true)}><RotateCcw size={14} />Resume last chat</button>}
              </div>
            </>
          )}
        </div>
        <aside aria-label="Other account choices" className="border-t border-rivet bg-ground/40 p-6 min-[1100px]:border-l min-[1100px]:border-t-0">
          <h3 className="text-sm font-semibold">Other options</h3>
          {recsLoading || recsError ? <p className="mt-4 text-xs text-muted">Choose any account from the board below.</p> : usable.length > 1 ? <ul className="mt-2 divide-y divide-rivet">{usable.slice(1, 3).map((rec) => <Alternative key={rec.accountId} rec={rec} account={candidates.find((a) => a.id === rec.accountId)!} snap={usage[rec.accountId]} />)}</ul> : <p className="mt-4 text-xs text-muted">No other suggestions for this selection.</p>}
          <details className="mt-5 border-t border-rivet pt-4 text-xs text-muted">
            <summary className="cursor-pointer font-medium text-ink">How Relay chooses</summary>
            <p className="mt-2 leading-relaxed">Local rules compare available quota, reset times, plan tier, your tags, and pinned accounts. These are suggestions, not model quality benchmarks. No task is sent to an AI service.</p>
          </details>
        </aside>
      </div>
    </section>
  )
}

export function Alternative({ rec, account, snap }: { rec: Recommendation; account: Account; snap?: UsageSnapshot }) {
  const prov = useStore((s) => s.providers.find((p) => p.id === account.providerId))
  const window = bindingWindow(snap)
  const now = useStore((s) => s.now)
  const lastKnown = isLastKnownUsage(snap, now)
  return (
    <li className="py-4">
      <div className="flex items-center gap-2"><AccountDot account={account} /><span className="min-w-0 flex-1 truncate font-medium">{account.label}</span></div>
      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="text-xs text-muted">{window ? `${formatPct(leftOf(window))} left${lastKnown ? ' · last known' : ''}` : 'Usage unknown'}</span>
        <PrimaryLaunch account={account} prov={prov} className="btn btn-sm" short />
      </div>
      <p className="mt-2 text-xs leading-relaxed text-muted">{rec.reason}</p>
    </li>
  )
}

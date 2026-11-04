import { Fragment, useId, useRef, useState } from 'react'
import clsx from 'clsx'
import {
  AlertTriangle,
  ArrowRight,
  ArrowRightLeft,
  ChevronDown,
  CircleStop,
  FolderOpen,
  Hourglass,
  Mic,
  Play,
  RotateCcw,
  Route,
  ShieldAlert,
  ShieldCheck,
  Square,
  SquareTerminal,
  X,
  type LucideIcon
} from 'lucide-react'
import type { Account, UsageSnapshot } from '@shared/types'
import { api, errorText } from '@/api'
import { useStore } from '@/store'
import { pickAccount } from '@/lib/autopilot'
import { atLimit, historyToTurnOn, isBlocked, isSignedOut } from '@/lib/grid'
import { bindingWindow, leftOf } from '@/lib/quota'
import { formatClock, formatCountdown, formatPct, plural, resetText, windowName } from '@/lib/format'
import { modKey } from '@/lib/platform'
import { Meter } from '@/components/Meter'
import { AccountDot } from '@/components/ui'
import { useAutopilot, type AutopilotLogKind, type AutopilotPhase, type AutopilotRun } from './store'

const DRAFT_KEY = 'relay.autopilot.draft'

function readDraft(): string {
  try {
    return localStorage.getItem(DRAFT_KEY) ?? ''
  } catch {
    return ''
  }
}

function saveDraft(text: string) {
  try {
    if (text) localStorage.setItem(DRAFT_KEY, text)
    else localStorage.removeItem(DRAFT_KEY)
  } catch {
    // A blocked storage only loses the draft.
  }
}

const STATUS: Record<Exclude<AutopilotPhase, 'idle'>, { word: string; dot: string }> = {
  starting: { word: 'Starting…', dot: 'bg-hop' },
  running: { word: 'Running', dot: 'bg-full' },
  'handing-off': { word: 'Switching accounts…', dot: 'bg-hop' },
  waiting: { word: 'Waiting for a reset', dot: 'bg-half' },
  stopped: { word: 'Stopped', dot: 'bg-faint' }
}

/** Overview card: give it a task and walk away; the chat moves to the Claude account with the most left. */
export function AutopilotCard() {
  const accounts = useStore((s) => s.accounts)
  const voice = useStore((s) => s.settings?.claudeVoice)
  const phase = useAutopilot((s) => s.phase)
  const run = useAutopilot((s) => s.run)
  const claude = accounts.filter((a) => a.providerId === 'claude')
  // A stop before the run existed leaves nothing to show: offer the form again.
  const idle = phase === 'idle' || (phase === 'stopped' && !run)
  // A run already under way stays reachable (to stop it) even if its accounts were removed since.
  if (!claude.length && idle) return null

  return (
    <section aria-labelledby="autopilot-title" className="overflow-hidden rounded-lg border border-rivet bg-deck">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-rivet px-6 py-4">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-hop/30 bg-hop/10 text-hop" aria-hidden>
          <Route size={18} />
        </span>
        <div className="min-w-0 flex-1">
          <h2 id="autopilot-title" tabIndex={-1} className="text-md font-semibold">
            Autopilot
          </h2>
          <p className="text-xs text-muted">Give it a task and walk away. When an account runs out, the chat moves to the one with the most left.</p>
        </div>
        {voice && (
          <button
            className="btn btn-ghost btn-sm shrink-0"
            onClick={() => useStore.getState().go('settings')}
            data-tip="Claude Code's hold-to-talk voice mode is on in every Claude account Relay starts"
          >
            <Mic size={13} /> Voice on
          </button>
        )}
      </header>
      {idle ? <Draft claude={claude} /> : <Live phase={phase} run={run} />}
    </section>
  )
}

/** The soonest reset among accounts at their limit, for saying when one is back. */
function soonestBack(accounts: Account[], usage: Record<string, UsageSnapshot>): { a: Account; at: string } | undefined {
  let soonest: { a: Account; at: string } | undefined
  for (const a of accounts) {
    const b = bindingWindow(usage[a.id])
    if (atLimit(usage[a.id]) && b?.resetsAt && (!soonest || Date.parse(b.resetsAt) < Date.parse(soonest.at))) soonest = { a, at: b.resetsAt }
  }
  return soonest
}

/** The accounts in the order a run would use them (the best first), and the ones it can't use now. */
function handoffOrder(accounts: Account[], usage: Record<string, UsageSnapshot>): { order: Account[]; out: Account[] } {
  const order: Account[] = []
  for (let next = pickAccount(accounts, usage, { providerId: 'claude' }); next; ) {
    order.push(next)
    next = pickAccount(accounts, usage, { providerId: 'claude', exclude: order.map((a) => a.id) })
  }
  return { order, out: accounts.filter((a) => !order.includes(a)) }
}

/** Why an account can't take the run now, in a few words. */
function outReason(a: Account, snap: UsageSnapshot | undefined, now: number): string {
  if (isSignedOut(a)) return 'Signed out'
  if (isBlocked(a)) return "Can't use Claude Code"
  const b = bindingWindow(snap)
  if (atLimit(snap)) return b?.resetsAt ? `Back in ${formatCountdown(b.resetsAt, now)}` : 'Limit reached'
  return 'Unavailable'
}

function Draft({ claude }: { claude: Account[] }) {
  const usage = useStore((s) => s.usage)
  const now = useStore((s) => s.now)
  const defaultCwd = useStore((s) => s.settings?.defaultCwd)
  const defaultHome = useStore((s) => s.providers.find((p) => p.id === 'claude')?.defaultHome)
  const [task, setTask] = useState(readDraft)
  const [cwd, setCwd] = useState<string | undefined>()
  const [skip, setSkip] = useState(true)
  const [busy, setBusy] = useState(false)
  const box = useRef<HTMLTextAreaElement>(null)
  const ids = useId()

  const { order, out } = handoffOrder(claude, usage)
  const best = order[0]
  const bind = best && bindingWindow(usage[best.id])
  const back = best ? undefined : soonestBack(claude, usage)
  // Starting turns history on for these, so the conversation can move to any of them.
  const toShare = historyToTurnOn(
    claude.filter((a) => !isSignedOut(a) && !isBlocked(a)),
    defaultHome,
    api.platform
  )
  const empty = !task.trim()
  const folder = cwd ?? defaultCwd ?? undefined

  const submit = async () => {
    if (!best || empty || busy) return
    setBusy(true)
    try {
      // A start that failed keeps the task, so it can be tried again.
      if (await useAutopilot.getState().start({ task: task.trim(), cwd: folder, skipPermissions: skip })) {
        setTask('')
        saveDraft('')
      }
    } catch (e) {
      useStore.getState().toast({ kind: 'error', title: "Autopilot couldn't start", body: errorText(e) })
    } finally {
      setBusy(false)
    }
  }

  // The system's dictation types into whatever has focus, so the task box gets it first.
  const dictate = async () => {
    box.current?.focus()
    const started = await api.system.startDictation().catch(() => false)
    if (!started) {
      useStore.getState().toast({ kind: 'info', title: "Dictation can't start from here", body: "Use your system's dictation shortcut while the task box has focus." })
    }
  }

  return (
    <div className="grid grid-cols-1 min-[1100px]:grid-cols-[minmax(0,1fr)_300px]">
      <form
        className="flex min-w-0 flex-col gap-3 p-6"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <label htmlFor={`${ids}-task`} className="text-sm font-semibold text-muted">
          What should it do?
        </label>
        <div className="rounded-lg border border-rivet bg-ground transition-colors focus-within:border-hop">
          <textarea
            ref={box}
            id={`${ids}-task`}
            data-autopilot-task
            rows={4}
            className="block min-h-[104px] w-full resize-y rounded-b-none rounded-t-lg border-0 bg-transparent px-4 pb-2 pt-3.5 text-md focus-visible:outline-none"
            value={task}
            placeholder="Refactor the billing module and make the tests pass"
            onChange={(e) => {
              setTask(e.target.value)
              saveDraft(e.target.value)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault()
                void submit()
              }
            }}
          />
          <div className="flex flex-wrap items-center gap-2 border-t border-rivet px-3 py-2.5">
            <div role="group" aria-label="Folder" className="flex min-w-0 max-w-full items-center">
              <button
                type="button"
                className="btn btn-sm min-w-0 max-w-[320px] justify-start"
                data-tip={folder ? `Runs in ${folder}. Choose another folder.` : 'Choose the folder it works in'}
                onClick={async () => {
                  const dir = await api.system.pickDirectory()
                  if (dir) setCwd(dir)
                }}
              >
                <FolderOpen size={13} className="shrink-0" />
                <span className="code min-w-0 truncate">{folder ?? 'Your home folder'}</span>
              </button>
              {cwd && (
                <button type="button" className="btn btn-ghost btn-sm shrink-0 px-1.5" aria-label="Use the default folder" onClick={() => setCwd(undefined)}>
                  <X size={13} />
                </button>
              )}
            </div>
            <span className="flex-1" />
            {api.platform === 'darwin' && (
              <button type="button" className="btn btn-ghost btn-sm shrink-0 px-2" onClick={() => void dictate()} aria-label="Dictate the task" data-tip="Dictate the task">
                <Mic size={15} />
              </button>
            )}
            {best && <span className="kbd hidden shrink-0 sm:inline-flex">{modKey(api.platform)} Enter</span>}
            <button type="submit" className="btn btn-primary" disabled={!best || empty || busy} data-tip={best && empty ? 'Write the task first' : undefined}>
              <Play size={14} fill="currentColor" />
              {best ? `Start on ${best.label}${bind ? ` · ${formatPct(leftOf(bind))} left` : ''}` : 'Start'}
            </button>
          </div>
        </div>

        <label
          className={clsx(
            'flex max-w-[80ch] items-start gap-3 rounded-lg border px-4 py-3 transition-colors',
            skip ? 'border-low/40 bg-low/[0.06]' : 'border-rivet'
          )}
        >
          <input type="checkbox" className="mt-0.5 shrink-0" checked={skip} onChange={(e) => setSkip(e.target.checked)} aria-describedby={`${ids}-skip`} />
          <span className="min-w-0">
            <span className="flex items-center gap-2 font-medium">
              Don't stop for permission prompts
              {skip ? <ShieldAlert size={14} className="shrink-0 text-low" aria-hidden /> : <ShieldCheck size={14} className="shrink-0 text-muted" aria-hidden />}
            </span>
            <span id={`${ids}-skip`} className="mt-0.5 block text-xs text-muted">
              {skip
                ? 'Starts Claude Code with bypass permissions, so it never waits for you to click Allow. It can run any command and change any file without asking.'
                : 'Claude Code stops and waits whenever it needs your permission, so a run left alone can sit idle until you answer.'}
            </span>
          </span>
        </label>
        {best && toShare.length > 0 && (
          <p className="max-w-[80ch] text-xs text-muted">
            Starting turns on chat history sharing for {toShare.map((a) => a.label).join(', ')}, so the conversation can move between your Claude accounts.
          </p>
        )}
        {!best && (
          <div className="flex items-center gap-3 rounded-lg border border-rivet bg-ground p-4">
            <Hourglass className="shrink-0 text-low" size={18} aria-hidden />
            <p>
              <span className="font-semibold">No Claude account can take a task right now. </span>
              <span className="text-muted">
                {back ? `${back.a.label} is back first, in ${formatCountdown(back.at, now)}.` : 'Sign in to a Claude account to start.'}
              </span>
            </p>
          </div>
        )}
      </form>

      <aside aria-labelledby={`${ids}-order`} className="border-t border-rivet bg-ground/40 p-6 min-[1100px]:border-l min-[1100px]:border-t-0">
        <h3 id={`${ids}-order`} className="text-sm font-semibold">
          Handoff order
        </h3>
        <p className="mt-1 text-xs text-muted">When one runs out, the chat moves down the list.</p>
        {order.length > 0 && (
          <ol className="mt-3 flex flex-col gap-2.5">
            {order.map((a, i) => (
              <OrderRow key={a.id} n={i + 1} account={a} snap={usage[a.id]} />
            ))}
          </ol>
        )}
        {out.length > 0 && (
          <ul aria-label="Not available now" className={clsx('flex flex-col gap-2', order.length > 0 && 'mt-4 border-t border-rivet pt-4')}>
            {out.map((a) => (
              <li key={a.id} className="flex items-center gap-2 text-xs text-muted">
                <AccountDot account={a} size={8} />
                <span className="min-w-0 flex-1 truncate">{a.label}</span>
                <span className="shrink-0 tabular-nums">{outReason(a, usage[a.id], now)}</span>
              </li>
            ))}
          </ul>
        )}
      </aside>
    </div>
  )
}

function OrderRow({ n, account, snap }: { n: number; account: Account; snap: UsageSnapshot | undefined }) {
  const bind = bindingWindow(snap)
  return (
    <li className="flex items-center gap-3">
      <span
        className={clsx(
          'flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold tabular-nums',
          n === 1 ? 'bg-hop text-hop-ink' : 'border border-rivet text-muted'
        )}
        aria-hidden
      >
        {n}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <AccountDot account={account} size={8} />
          <span className="min-w-0 flex-1 truncate font-medium">{account.label}</span>
          <span className="shrink-0 text-xs tabular-nums text-muted">{bind ? `${formatPct(leftOf(bind))} left` : 'Usage unknown'}</span>
        </div>
        {bind && <Meter left={leftOf(bind)} cells={16} size="xs" label={`${account.label}, ${bind.label}`} className="mt-1.5" />}
      </div>
    </li>
  )
}

const LOG_ICON: Record<AutopilotLogKind, LucideIcon> = {
  start: Play,
  handoff: ArrowRightLeft,
  waiting: Hourglass,
  resumed: RotateCcw,
  'false-alarm': ShieldCheck,
  exit: SquareTerminal,
  stopped: CircleStop,
  error: AlertTriangle
}

const LOG_SHOWN = 5

/** "4m", "2h 14m", "3d 4h": how long a run has been going. */
function elapsed(ms: number): string {
  const m = Math.max(1, Math.floor(ms / 60_000))
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`
  return h % 24 ? `${Math.floor(h / 24)}d ${h % 24}h` : `${Math.floor(h / 24)}d`
}

const iso = (t: number) => new Date(t).toISOString()

/** The accounts a run has been on, oldest first; a resume on the same account isn't a new stop. */
function route(run: AutopilotRun): string[] {
  const ids = (run.legs?.length ? run.legs : [{ accountId: run.accountId }]).map((l) => l.accountId)
  return ids.filter((id, i) => id !== ids[i - 1])
}

/** A run under way or just stopped: what it is doing, on which account, and what happened so far. */
function Live({ phase, run }: { phase: Exclude<AutopilotPhase, 'idle'>; run: AutopilotRun | null }) {
  const log = useAutopilot((s) => s.log)
  const now = useStore((s) => s.now)
  const usage = useStore((s) => s.usage)
  const accounts = useStore((s) => s.accounts)
  const account = run ? accounts.find((a) => a.id === run.accountId) : undefined
  const [all, setAll] = useState(false)
  const { stop, dismiss, openTerminal } = useAutopilot.getState()
  const stopped = phase === 'stopped'
  const status = STATUS[phase]
  const snap = account && usage[account.id]
  const bind = bindingWindow(snap)
  const left = bind ? leftOf(bind) : undefined
  const back = phase === 'waiting' && run?.waitingUntil ? formatCountdown(iso(run.waitingUntil), now) : null
  // The newest entry of a stopped run is its stop, so that is where its time ends.
  const end = stopped ? (log[0]?.t ?? now) : now
  const shown = all ? log : log.slice(0, LOG_SHOWN)
  // Who takes over if this account runs out: the engine's own pick, minus the accounts still out.
  const out = run ? Object.keys(run.exhausted).filter((id) => run.exhausted[id]! > now) : []
  const next = run && !stopped ? pickAccount(accounts, usage, { providerId: 'claude', exclude: [run.accountId, ...out] }) : undefined
  const nextBind = next && bindingWindow(usage[next.id])
  const path = run ? route(run) : []
  // The buttons that took focus go away with the run; land on the next sensible stop instead.
  const leave = (selector: string) => {
    dismiss()
    requestAnimationFrame(() => document.querySelector<HTMLElement>(selector)?.focus())
  }

  return (
    <div className="grid grid-cols-1 min-[1100px]:grid-cols-[minmax(0,1fr)_336px]">
      <div className="min-w-0 p-6">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className={clsx('h-2.5 w-2.5 shrink-0 rounded-full', status.dot)} aria-hidden />
          <p className="text-lg font-semibold">
            <span aria-live="polite">{status.word}</span>
          </p>
          {/* Outside the live region: a countdown that changes every minute shouldn't be read out each time. */}
          {phase === 'waiting' && back && <span className="text-muted">· back {back === 'now' ? 'any moment' : `in ${back}`}</span>}
        </div>
        {run && (
          <>
            <p className="mt-1 text-xs tabular-nums text-muted">
              {stopped ? 'Ran' : 'Running'} {elapsed(end - run.startedAt)} · {run.handoffs ? plural(run.handoffs, 'handoff') : stopped ? 'no handoffs' : 'no handoffs yet'}
              {run.cwd && (
                <>
                  {' · '}
                  <code className="code" data-tip={run.cwd}>
                    {run.cwd}
                  </code>
                </>
              )}
            </p>
            <blockquote className="mt-4 max-w-[80ch] border-l-2 border-hop/60 pl-4">
              <p className="line-clamp-3 text-md" data-tip={run.task}>
                {run.task}
              </p>
            </blockquote>
            {run.error && (
              <p className="mt-4 flex max-w-[80ch] items-start gap-2 rounded-lg border border-empty/40 bg-empty/10 px-4 py-3">
                <AlertTriangle size={14} className="mt-[3px] shrink-0 text-empty" aria-hidden />
                <span>{run.error}</span>
              </p>
            )}

            <div className="mt-5 rounded-lg border border-rivet bg-ground p-4">
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted">{stopped ? 'Last on' : 'Now on'}</span>
                {account && <AccountDot account={account} />}
                <span className="min-w-0 flex-1 truncate font-medium">{account?.label ?? 'Account removed'}</span>
              </div>
              {account && bind && left !== undefined ? (
                <>
                  <div className="mt-3 flex flex-wrap items-baseline justify-between gap-2">
                    <p>
                      <strong className="text-hero font-semibold">{formatPct(left)}</strong>
                      <span className="ml-2 text-muted">{atLimit(snap) ? 'Limit reached' : `left of ${windowName(bind.label)}`}</span>
                    </p>
                    <span className="text-xs tabular-nums text-muted">{resetText(bind.resetsAt, now) ?? 'No reset scheduled'}</span>
                  </div>
                  <Meter left={left} cells={32} size="sm" label={`${account.label}, ${bind.label}`} className="mt-3" />
                </>
              ) : (
                <p className="mt-2 text-xs text-muted">Usage unknown for this account.</p>
              )}
              {!stopped && (
                <p className="mt-3 flex flex-wrap items-center gap-x-1.5 border-t border-rivet pt-3 text-xs text-muted">
                  {next ? (
                    <>
                      Next if it runs out: <AccountDot account={next} size={8} />
                      <span className="font-medium text-ink">{next.label}</span>
                      {nextBind && <span className="tabular-nums">· {formatPct(leftOf(nextBind))} left</span>}
                    </>
                  ) : (
                    'No other account has room; it will wait for a reset if this one runs out.'
                  )}
                </p>
              )}
            </div>

            {path.length > 1 && (
              <div className="mt-4">
                <h3 className="text-xs text-muted">Route so far</h3>
                <ol className="mt-2 flex flex-wrap items-center gap-1.5">
                  {path.map((id, i) => {
                    const a = accounts.find((x) => x.id === id)
                    const current = i === path.length - 1
                    return (
                      <Fragment key={`${id}-${i}`}>
                        {i > 0 && <ArrowRight size={12} className="text-faint" aria-hidden />}
                        <li
                          className={clsx(
                            'flex h-7 items-center gap-1.5 rounded border px-2.5 text-xs',
                            current ? 'border-hop/50 bg-hop/10 font-medium text-ink' : 'border-rivet text-muted'
                          )}
                          aria-current={current ? 'step' : undefined}
                        >
                          {a && <AccountDot account={a} size={8} />}
                          {a?.label ?? 'Removed account'}
                        </li>
                      </Fragment>
                    )
                  })}
                </ol>
              </div>
            )}
          </>
        )}
        <div className="mt-5 flex flex-wrap gap-2">
          {stopped && (
            <button className="btn btn-primary" onClick={() => leave('[data-autopilot-task]')}>
              <Play size={14} fill="currentColor" /> Start a new task
            </button>
          )}
          {run && (
            <button className="btn" onClick={openTerminal}>
              <SquareTerminal size={14} /> Open terminal
            </button>
          )}
          {stopped ? (
            <button className="btn btn-ghost" onClick={() => leave('#autopilot-title')}>
              Done
            </button>
          ) : (
            <button className="btn btn-danger" onClick={stop} data-tip="Stop moving the chat between accounts. The terminal keeps running.">
              <Square size={12} fill="currentColor" /> Stop
            </button>
          )}
        </div>
      </div>
      <div className="border-t border-rivet bg-ground/40 px-6 pb-4 pt-6 min-[1100px]:border-l min-[1100px]:border-t-0">
        <h3 id="autopilot-activity" className="text-sm font-semibold">
          Activity
        </h3>
        {log.length === 0 && <p className="mt-3 text-muted">Nothing yet.</p>}
        <ol aria-labelledby="autopilot-activity" className="relative mt-3">
          {shown.map((e, i) => {
            const Icon = LOG_ICON[e.kind]
            return (
              <li key={`${e.t}-${i}`} className="relative flex gap-3 pb-4 last:pb-0">
                {/* The thread between entries, behind the icons. */}
                {i < shown.length - 1 && <span className="absolute bottom-0 left-[11px] top-6 w-px bg-rivet" aria-hidden />}
                <span
                  className={clsx(
                    'relative flex h-6 w-6 shrink-0 items-center justify-center rounded-full border bg-deck',
                    e.kind === 'error' ? 'border-empty/50 text-empty' : e.kind === 'handoff' || e.kind === 'resumed' ? 'border-hop/50 text-hop' : 'border-rivet text-muted'
                  )}
                  aria-hidden
                >
                  <Icon size={12} />
                </span>
                <div className="min-w-0 flex-1 pt-0.5">
                  <p className="leading-[19px]">{e.text}</p>
                  <time dateTime={iso(e.t)} className="text-xs tabular-nums text-muted">
                    {formatClock(iso(e.t))}
                  </time>
                </div>
              </li>
            )
          })}
        </ol>
        {log.length > LOG_SHOWN && (
          <button
            className="-mx-2 mt-2 flex h-7 items-center gap-2 rounded px-2 text-xs text-muted hover:bg-raised hover:text-ink"
            onClick={() => setAll(!all)}
            aria-expanded={all}
          >
            <ChevronDown size={14} className={clsx('shrink-0 transition-transform', all && 'rotate-180')} aria-hidden />
            {all ? 'Show fewer' : `Show all ${log.length}`}
          </button>
        )}
      </div>
    </div>
  )
}

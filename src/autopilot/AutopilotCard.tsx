import { useId, useState } from 'react'
import clsx from 'clsx'
import { AlertTriangle, ArrowRightLeft, ChevronDown, CircleStop, FolderOpen, Hourglass, Play, RotateCcw, ShieldCheck, Square, SquareTerminal, X, type LucideIcon } from 'lucide-react'
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

/** Overview card: give it a task and walk away; the chat moves to the Claude account with the most left. */
export function AutopilotCard() {
  const accounts = useStore((s) => s.accounts)
  const phase = useAutopilot((s) => s.phase)
  const run = useAutopilot((s) => s.run)
  const claude = accounts.filter((a) => a.providerId === 'claude')
  // A stop before the run existed leaves nothing to show: offer the form again.
  const idle = phase === 'idle' || (phase === 'stopped' && !run)
  // A run already under way stays reachable (to stop it) even if its accounts were removed since.
  if (!claude.length && idle) return null

  return (
    <section aria-labelledby="autopilot-title" className="rounded-lg border border-rivet bg-deck">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-rivet px-6 py-3">
        <h2 id="autopilot-title" tabIndex={-1} className="font-serif text-[17px] font-semibold">
          Autopilot
        </h2>
        <p className="min-w-0 text-xs text-muted">
          Give it a task and walk away. When an account runs out, the chat moves to the one with the most left.
        </p>
      </div>
      {phase === 'idle' || idle ? <Draft claude={claude} /> : <Live phase={phase} run={run} />}
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

function Draft({ claude }: { claude: Account[] }) {
  const usage = useStore((s) => s.usage)
  const now = useStore((s) => s.now)
  const defaultCwd = useStore((s) => s.settings?.defaultCwd)
  const defaultHome = useStore((s) => s.providers.find((p) => p.id === 'claude')?.defaultHome)
  const [task, setTask] = useState(readDraft)
  const [cwd, setCwd] = useState<string | undefined>()
  const [skip, setSkip] = useState(true)
  const [busy, setBusy] = useState(false)
  const ids = useId()

  const best = pickAccount(claude, usage, { providerId: 'claude' })
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

  return (
    <form
      className="flex flex-col gap-4 px-6 pb-6 pt-5"
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
    >
      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${ids}-task`} className="label">
          Task
        </label>
        <textarea
          id={`${ids}-task`}
          data-autopilot-task
          rows={3}
          className="w-full resize-y leading-[19px]"
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
      </div>

      <div className="flex flex-col gap-1.5">
        <span id={`${ids}-folder`} className="label">
          Folder
        </span>
        <div role="group" aria-labelledby={`${ids}-folder`} className="flex min-w-0 items-center gap-2">
          <code className="code min-w-0 truncate text-muted" data-tip={folder}>
            {folder ?? 'Your home folder'}
          </code>
          <button
            type="button"
            className="btn btn-sm shrink-0"
            onClick={async () => {
              const dir = await api.system.pickDirectory()
              if (dir) setCwd(dir)
            }}
          >
            <FolderOpen size={13} /> Choose
          </button>
          {cwd && (
            <button type="button" className="btn btn-ghost btn-sm shrink-0 px-1.5" aria-label="Use the default folder" onClick={() => setCwd(undefined)}>
              <X size={13} />
            </button>
          )}
        </div>
      </div>

      <label className="flex max-w-[72ch] items-start gap-2.5">
        <input type="checkbox" className="mt-0.5 shrink-0" checked={skip} onChange={(e) => setSkip(e.target.checked)} aria-describedby={`${ids}-skip`} />
        <span className="min-w-0">
          <span className="font-medium">Don't stop for permission prompts</span>
          <span id={`${ids}-skip`} className="mt-0.5 block text-xs text-muted">
            Starts Claude Code with bypass permissions, so it never waits for you to click Allow. It can run any command and change any file
            without asking.
          </span>
        </span>
      </label>

      {!best && (
        <div className="flex items-center gap-3">
          <Hourglass className="shrink-0 text-low" size={18} aria-hidden />
          <p>
            <span className="font-semibold">No Claude account can take a task right now. </span>
            <span className="text-muted">
              {back ? `${back.a.label} is back first, in ${formatCountdown(back.at, now)}.` : 'Sign in to a Claude account to start.'}
            </span>
          </p>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <button type="submit" className="btn btn-primary" disabled={!best || empty || busy} data-tip={best && empty ? 'Write the task first' : undefined}>
          <Play size={14} fill="currentColor" />
          {best ? `Start on ${best.label}${bind ? ` · ${formatPct(leftOf(bind))} left` : ''}` : 'Start'}
        </button>
        {best && (
          <span className="text-xs text-muted">
            or <span className="kbd">{modKey(api.platform)} Enter</span>
          </span>
        )}
      </div>
      {best && toShare.length > 0 && (
        <p className="-mt-1 max-w-[72ch] text-xs text-muted">
          Starting turns on chat history sharing for {toShare.map((a) => a.label).join(', ')}, so the conversation can move between your Claude
          accounts.
        </p>
      )}
    </form>
  )
}

const STATUS: Record<Exclude<AutopilotPhase, 'idle'>, { word: string; dot: string }> = {
  starting: { word: 'Starting…', dot: 'bg-hop' },
  running: { word: 'Running', dot: 'bg-full' },
  'handing-off': { word: 'Switching accounts…', dot: 'bg-hop' },
  waiting: { word: 'Waiting for a reset', dot: 'bg-half' },
  stopped: { word: 'Stopped', dot: 'bg-faint' }
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

/** A run under way or just stopped: what it is doing, on which account, and what happened so far. */
function Live({ phase, run }: { phase: Exclude<AutopilotPhase, 'idle'>; run: AutopilotRun | null }) {
  const log = useAutopilot((s) => s.log)
  const now = useStore((s) => s.now)
  const usage = useStore((s) => s.usage)
  const account = useStore((s) => (run ? s.accounts.find((a) => a.id === run.accountId) : undefined))
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
  // The buttons that took focus go away with the run; land on the next sensible stop instead.
  const leave = (selector: string) => {
    dismiss()
    requestAnimationFrame(() => document.querySelector<HTMLElement>(selector)?.focus())
  }

  return (
    <div className="grid grid-cols-1 min-[1100px]:grid-cols-[minmax(0,1fr)_336px]">
      <div className="min-w-0 px-6 pb-6 pt-5">
        <p className="flex flex-wrap items-center gap-x-2 font-semibold">
          <span className={clsx('h-2 w-2 shrink-0 rounded-full', status.dot)} aria-hidden />
          <span aria-live="polite">{status.word}</span>
          {/* Outside the live region: a countdown that changes every minute shouldn't be read out each time. */}
          {phase === 'waiting' && back && <span className="font-normal text-muted">· back {back === 'now' ? 'any moment' : `in ${back}`}</span>}
        </p>
        {run && (
          <>
            <p className="mt-3 line-clamp-2 max-w-[72ch]" data-tip={run.task}>
              {run.task}
            </p>
            {run.error && (
              <p className="mt-3 flex max-w-[72ch] items-start gap-2">
                <AlertTriangle size={14} className="mt-[3px] shrink-0 text-empty" aria-hidden />
                <span>{run.error}</span>
              </p>
            )}
            <div className="mt-5 max-w-md">
              <div className="flex items-center gap-2">
                {account && <AccountDot account={account} />}
                <span className="min-w-0 flex-1 truncate font-medium">{account?.label ?? 'Account removed'}</span>
                {left !== undefined && (
                  <span className="shrink-0 text-xs font-semibold tabular-nums">{atLimit(snap) ? 'Limit reached' : `${formatPct(left)} left`}</span>
                )}
              </div>
              {account && bind && left !== undefined && (
                <>
                  <Meter left={left} cells={20} size="xs" label={`${account.label}, ${bind.label}`} className="mt-2" />
                  <div className="mt-1 text-xs tabular-nums text-muted">
                    {windowName(bind.label)}, {(resetText(bind.resetsAt, now) ?? 'no reset scheduled').toLowerCase()}
                  </div>
                </>
              )}
            </div>
            <p className="mt-4 text-xs tabular-nums text-muted">
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
          </>
        )}
        <div className="mt-4 flex flex-wrap gap-2">
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
      <div className="border-t border-rivet px-6 pb-3 pt-5 min-[1100px]:border-l min-[1100px]:border-t-0">
        <h3 id="autopilot-activity" className="text-xs font-medium text-muted">
          Activity
        </h3>
        {log.length === 0 && <p className="mt-3 text-muted">Nothing yet.</p>}
        <ul aria-labelledby="autopilot-activity" className="mt-1 divide-y divide-rivet">
          {shown.map((e, i) => {
            const Icon = LOG_ICON[e.kind]
            return (
              <li key={`${e.t}-${i}`} className="flex items-start gap-3 py-2">
                <time dateTime={iso(e.t)} className="w-16 shrink-0 text-xs leading-[19px] tabular-nums text-muted">
                  {formatClock(iso(e.t))}
                </time>
                <Icon size={14} className={clsx('mt-[2.5px] shrink-0', e.kind === 'error' ? 'text-empty' : 'text-muted')} aria-hidden />
                <span className="min-w-0 flex-1">{e.text}</span>
              </li>
            )
          })}
        </ul>
        {log.length > LOG_SHOWN && (
          <button
            className="-mx-2 mt-1 flex h-7 items-center gap-2 rounded px-2 text-xs text-muted hover:bg-raised hover:text-ink"
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

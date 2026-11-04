import { useId, useState } from 'react'
import { FolderOpen, Hourglass, Play, X } from 'lucide-react'
import type { Account, UsageSnapshot } from '@shared/types'
import { api, errorText } from '@/api'
import { useStore } from '@/store'
import { pickAccount } from '@/lib/autopilot'
import { atLimit, historyToTurnOn, isBlocked, isSignedOut } from '@/lib/grid'
import { bindingWindow, leftOf } from '@/lib/quota'
import { formatCountdown, formatPct } from '@/lib/format'
import { modKey } from '@/lib/platform'
import { useAutopilot } from './store'

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
  const claude = accounts.filter((a) => a.providerId === 'claude')
  if (!claude.length) return null

  return (
    <section aria-labelledby="autopilot-title" className="rounded-lg border border-rivet bg-deck">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-rivet px-6 py-3">
        <h2 id="autopilot-title" className="font-serif text-[17px] font-semibold">
          Autopilot
        </h2>
        <p className="min-w-0 text-xs text-muted">
          Give it a task and walk away. When an account runs out, the chat moves to the one with the most left.
        </p>
      </div>
      {phase === 'idle' && <Draft claude={claude} />}
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
      await useAutopilot.getState().start({ task: task.trim(), cwd: folder, skipPermissions: skip })
      setTask('')
      saveDraft('')
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

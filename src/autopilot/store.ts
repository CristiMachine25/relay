// Autopilot: runs one task in Claude Code on the account with the most left and, when that account's usage
// runs out mid-task, moves the same conversation to the next account by itself. Built for someone away from
// the keyboard. Pure decisions live in @/lib/autopilot; this store owns the run, its timers and the terminal.
import { create } from 'zustand'
import type { Account, UsageSnapshot } from '@shared/types'
import { api, errorText } from '@/api'
import { useStore } from '@/store'
import { useGrid } from '@/terminals/store'
import { tailText } from '@/terminals/registry'
import { CONTINUE_PROMPT, exhaustedUntil, limitHit, permissionArgs, pickAccount, soonestReset, taskArg } from '@/lib/autopilot'
import { atLimit, historyShared, historyToTurnOn, isBlocked, isSignedOut } from '@/lib/grid'
import { bindingWindow, leftOf } from '@/lib/quota'

export type AutopilotPhase = 'idle' | 'starting' | 'running' | 'handing-off' | 'waiting' | 'stopped'

export type AutopilotLogKind = 'start' | 'handoff' | 'waiting' | 'resumed' | 'false-alarm' | 'exit' | 'stopped' | 'error'

export interface AutopilotLogEntry {
  /** Epoch ms. */
  t: number
  kind: AutopilotLogKind
  text: string
}

export interface AutopilotRun {
  id: string
  task: string
  cwd?: string
  skipPermissions: boolean
  providerId: 'claude'
  /** The account the run's terminal is on now. */
  accountId: string
  /** Grid pane and session the run owns. */
  paneUid: string
  sessionId: string
  startedAt: number
  handoffs: number
  /** Account id → epoch ms it is expected back after running out during this run. */
  exhausted: Record<string, number>
  /** While waiting: epoch ms the next account is expected to have room. */
  waitingUntil?: number
  /** Why the run stopped on its own. */
  error?: string
  /** The CLI's conversation id, last seen before a handoff; used when the pane has no terminal left to ask. */
  conversationId?: string
}

export interface AutopilotStartInput {
  task: string
  cwd?: string
  skipPermissions: boolean
}

interface AutopilotState {
  phase: AutopilotPhase
  run: AutopilotRun | null
  /** Newest first, at most 50. */
  log: AutopilotLogEntry[]
  /** Restore a saved run and start watching. Safe to call more than once. */
  init(): Promise<void>
  start(input: AutopilotStartInput): Promise<void>
  /** Stop watching; the terminal keeps running. */
  stop(): void
  /** Forget a stopped run and its log, back to idle. */
  dismiss(): void
  /** Show the run's pane in the terminal grid. */
  openTerminal(): void
}

const STORAGE_KEY = 'relay.autopilot'
const LOG_MAX = 50
const SECOND = 1000
const MINUTE = 60 * SECOND
/** A (re)started CLI replays the conversation's old screens, which may include the last limit message. */
const QUIET_AFTER_SPAWN = 20 * SECOND
const TEXT_DEBOUNCE = SECOND
const TEXT_POLL = 15 * SECOND
/** Limit text with this much left on the account's fresh usage is a false alarm (e.g. the task talks about limits). */
const ROOM_LEFT = 5
const FALSE_ALARM_MUTE = 2 * MINUTE
/** Usage this old didn't come from the refresh that checked a limit message: the refresh failed. */
const FRESH_USAGE = MINUTE
/** Lets a pane close or a manual restart finish before an exit counts as the CLI stopping by itself. */
const EXIT_SETTLE = SECOND
const CRASH_EXITS = 3
const CRASH_SPAN = 10 * MINUTE
/** After a reset the provider's numbers can lag a little. */
const WAKE_AFTER_RESET = MINUTE
const WAKE_UNKNOWN = 10 * MINUTE
const RETRY_AFTER_ERROR = MINUTE

const PANE_CLOSED = "The run's pane was closed"
const ACCOUNT_REMOVED = "The run's account was removed"
const GONE_AFTER_RESTART = "Relay restarted and the run's terminal was gone"

const active = (p: AutopilotPhase) => p !== 'idle' && p !== 'stopped'

/** What the engine tracks about the run's current terminal; reset for every run, never saved. */
interface Watch {
  terminalId?: string
  spawnedAt: number
  /** No limit-text checks before this (after a false alarm). */
  mutedUntil: number
  /** The terminal a false alarm was logged for: once per terminal is enough. */
  falseAlarmFor?: string
  /** The terminal whose exit was already seen. */
  exitSeen?: string
  /** Recent exits that weren't ours, for the crash-loop guard. */
  exits: number[]
  /** A handoff or wake-up is in flight; other signals wait. */
  busy: boolean
  /** A limit-text check is refreshing usage. */
  checking: boolean
  /** No retry before this after a failed start. */
  retryAt: number
}

const freshWatch = (): Watch => ({ spawnedAt: 0, mutedUntil: 0, exits: [], busy: false, checking: false, retryAt: 0 })
let w = freshWatch()
/** Subscriptions and timers that live while a run is active. */
let offs: (() => void)[] = []
const timers: { debounce?: ReturnType<typeof setTimeout>; poll?: ReturnType<typeof setInterval>; wake?: ReturnType<typeof setTimeout>; exit?: ReturnType<typeof setTimeout> } = {}
let initialized = false

export const useAutopilot = create<AutopilotState>((set, get) => ({
  phase: 'idle',
  run: null,
  log: [],

  async init() {
    if (initialized) return
    initialized = true
    const saved = load()
    // A run started before the saved one could be read wins (the card only shows once the app is ready).
    if (!saved?.run || get().phase !== 'idle') return
    const { run, log } = saved
    if (!active(saved.phase)) {
      set({ phase: saved.phase, run, log })
      return
    }
    await useGrid.getState().restore()
    const at = paneOf(run.paneUid)
    const tid = at?.pane.terminalId
    const live = !!tid && useGrid.getState().infos[tid]?.exited === false
    // A waiting run only needs its pane: waking up starts a terminal anyway.
    if (!at?.pane.accountId || (!live && saved.phase !== 'waiting')) {
      set({ phase: 'stopped', run: { ...run, error: GONE_AFTER_RESTART }, log: entry(log, 'stopped', GONE_AFTER_RESTART) })
      return
    }
    w = freshWatch()
    w.terminalId = tid
    w.spawnedAt = Date.now()
    const waiting = saved.phase === 'waiting'
    // A handoff cut short may have started the next account already: the pane knows which one it is on.
    set({ phase: waiting ? 'waiting' : 'running', run: { ...run, accountId: at.pane.accountId }, log })
    if (waiting) scheduleWake(run.waitingUntil)
  },

  async start(input) {
    const fail = (title: string, body?: string) => useStore.getState().toast({ kind: 'error', title, body })
    if (active(get().phase)) return fail('Autopilot is already running', 'Stop the current run first.')
    const task = input.task.trim()
    if (!task) return fail('Give Autopilot a task first')
    if (!best()) return fail('No Claude account has room right now', "Autopilot needs a signed-in Claude account that isn't at its limit.")

    w = freshWatch()
    set({ phase: 'starting', run: null, log: [] })
    const starting = () => get().phase === 'starting'
    try {
      // Turn on history sharing for every account that could take over, so the chat can move to any of them.
      const home = claudeHome()
      const signedIn = useStore.getState().accounts.filter((a) => a.providerId === 'claude' && !isBlocked(a) && !isSignedOut(a))
      for (const x of historyToTurnOn(signedIn, home, api.platform))
        await useStore.getState().updateAccount(x.id, { sharing: { ...x.sharing, history: true } }, { quiet: true })
      await useGrid.getState().restore()
      if (!starting()) return
      const first = best()
      if (!first) return finish('No Claude account has room right now', true)

      // A session of its own, so the run never takes over a pane the user is working in. The grid stays where it
      // is on screen; the terminal sizes itself when the user opens it.
      const g = useGrid.getState()
      const sessionId = g.newSession()
      g.renameSession(sessionId, 'Autopilot')
      const paneUid = useGrid.getState().ws.panes[0]!.uid
      const cwd = input.cwd?.trim() || useStore.getState().settings?.defaultCwd || undefined
      const run: AutopilotRun = {
        id: `ap${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        task,
        cwd,
        skipPermissions: input.skipPermissions,
        providerId: 'claude',
        accountId: first.id,
        paneUid,
        sessionId,
        startedAt: Date.now(),
        handoffs: 0,
        exhausted: {}
      }
      set({ run })
      await useGrid.getState().start(0, { accountId: first.id, target: 'cli', cwd, extraArgs: [...permissionArgs(input.skipPermissions), taskArg(task)] })
      if (!starting() || get().run?.id !== run.id) return
      const tid = paneOf(paneUid)?.pane.terminalId
      if (!tid) return finish(`Couldn't start the terminal: ${useGrid.getState().errors[paneUid] || 'it did not start'}`, true)
      spawned(tid)
      set({ phase: 'running' })
      addLog('start', `Started on ${first.label}${leftText(first.id)}.`)
    } catch (e) {
      if (starting()) finish(`Couldn't start: ${errorText(e)}`, true)
    }
  },

  stop() {
    if (active(get().phase)) finish('Stopped by you', false)
  },

  dismiss() {
    if (get().phase === 'stopped') set({ phase: 'idle', run: null, log: [] })
  },

  openTerminal() {
    const run = get().run
    const at = run && useGrid.getState().locate(run.paneUid)
    if (!at) return
    const g = useGrid.getState()
    if (g.activeId !== at.sessionId) g.switchSession(at.sessionId)
    useGrid.getState().focus(at.index)
    useStore.getState().go('terminals')
  }
}))

const get = () => useAutopilot.getState()
const set = (patch: Partial<AutopilotState>) => useAutopilot.setState(patch)

function entry(log: AutopilotLogEntry[], kind: AutopilotLogKind, text: string): AutopilotLogEntry[] {
  return [{ t: Date.now(), kind, text }, ...log].slice(0, LOG_MAX)
}

function addLog(kind: AutopilotLogKind, text: string) {
  set({ log: entry(get().log, kind, text) })
}

function patchRun(patch: Partial<AutopilotRun>) {
  const run = get().run
  if (run) set({ run: { ...run, ...patch } })
}

/** Ends the run: by the user (`error` false) or on its own, with the reason kept on the run. */
function finish(reason: string, error: boolean) {
  const run = get().run
  set({ phase: 'stopped', run: run && error ? { ...run, error: reason } : run, log: entry(get().log, 'stopped', reason) })
  if (error) useStore.getState().toast({ kind: 'error', title: 'Autopilot stopped', body: reason })
}

const claudeHome = () => useStore.getState().providers.find((p) => p.id === 'claude')?.defaultHome

const best = () => {
  const s = useStore.getState()
  return pickAccount(s.accounts, s.usage, { providerId: 'claude' })
}

const label = (id: string) => useStore.getState().accounts.find((a) => a.id === id)?.label ?? 'The account'

/** " (82% left)" for an account with usage numbers, '' without. */
function leftText(id: string): string {
  const b = bindingWindow(useStore.getState().usage[id])
  return b ? ` (${Math.round(leftOf(b))}% left)` : ''
}

/** The pane the run owns, wherever it is, or null when no session has it. */
function paneOf(uid: string) {
  const g = useGrid.getState()
  const at = g.locate(uid)
  if (!at) return null
  const ws = at.sessionId === g.activeId ? g.ws : g.sessions.find((x) => x.id === at.sessionId)?.ws
  const pane = ws?.panes[at.index]
  return pane ? { ...at, pane } : null
}

/** Starts watching a new terminal of the run. */
function spawned(terminalId: string) {
  w.terminalId = terminalId
  w.spawnedAt = Date.now()
  w.mutedUntil = 0
  w.falseAlarmFor = undefined
  w.exitSeen = undefined
}

function keepAwake(on: boolean) {
  try {
    void api.system.keepAwake(on).catch(() => {})
  } catch {
    /* a backend without it: the run still works while the computer stays awake */
  }
}

async function refreshAll() {
  try {
    await useStore.getState().refresh()
  } catch {
    /* the store reports refresh errors itself; decide on the numbers we have */
  }
}

function watch() {
  unwatch()
  offs = [
    api.on('terminal-output', ({ id }) => {
      if (id !== w.terminalId || get().phase !== 'running') return
      clearTimeout(timers.debounce)
      timers.debounce = setTimeout(() => void checkText(), TEXT_DEBOUNCE)
    }),
    useStore.subscribe((s, prev) => {
      if (s.accounts !== prev.accounts) onAccounts()
      if (s.usage !== prev.usage) onUsage()
    }),
    useGrid.subscribe(() => onGrid())
  ]
  timers.poll = setInterval(() => void checkText(), TEXT_POLL)
}

function unwatch() {
  for (const off of offs) off()
  offs = []
  clearTimeout(timers.debounce)
  clearInterval(timers.poll)
  clearTimeout(timers.wake)
  clearTimeout(timers.exit)
}

function onAccounts() {
  const run = get().run
  if (run && active(get().phase) && !useStore.getState().accounts.some((a) => a.id === run.accountId)) finish(ACCOUNT_REMOVED, true)
}

function onUsage() {
  const { phase, run } = get()
  if (!run) return
  if (phase === 'running' && atLimit(useStore.getState().usage[run.accountId])) void handoff('limit')
  else if (phase === 'waiting') void wake(false)
}

function onGrid() {
  const { phase, run } = get()
  if (!run || (phase !== 'running' && phase !== 'waiting') || w.busy) return
  const at = paneOf(run.paneUid)
  if (!at?.pane.accountId) return finish(PANE_CLOSED, true)
  if (phase !== 'running') return
  const tid = at.pane.terminalId
  if (!tid) return
  if (tid !== w.terminalId) {
    // The user restarted the pane or moved it to another account by hand: follow the new terminal.
    spawned(tid)
    if (at.pane.accountId !== run.accountId) patchRun({ accountId: at.pane.accountId })
    return
  }
  if (useGrid.getState().infos[tid]?.exited && w.exitSeen !== tid) {
    w.exitSeen = tid
    clearTimeout(timers.exit)
    timers.exit = setTimeout(() => onExit(tid), EXIT_SETTLE)
  }
}

/** The run's CLI stopped by itself (crash, /exit, an error): continue the chat, unless it keeps happening. */
function onExit(tid: string) {
  const { phase, run } = get()
  if (!run || phase !== 'running' || w.busy || w.terminalId !== tid) return
  const at = paneOf(run.paneUid)
  if (!at?.pane.accountId) return finish(PANE_CLOSED, true)
  if (at.pane.terminalId !== tid) return
  const now = Date.now()
  w.exits = [...w.exits.filter((t) => now - t < CRASH_SPAN), now]
  const code = useGrid.getState().infos[tid]?.exitCode
  addLog('exit', `The terminal on ${label(run.accountId)} exited${code !== undefined && code !== null ? ` (code ${code})` : ''}.`)
  if (w.exits.length >= CRASH_EXITS) return finish(`The terminal exited ${CRASH_EXITS} times in 10 minutes`, true)
  void handoff('exit')
}

/** Usage that came from a refresh just now and that the provider vouches for. */
const fresh = (snap: UsageSnapshot, since: number) => !snap.stale && !snap.error && Date.parse(snap.fetchedAt) >= since - FRESH_USAGE

/** Looks for the CLI's limit message on screen; the account's usage has the last word when it has numbers. */
async function checkText() {
  const { phase, run } = get()
  const id = w.terminalId
  if (phase !== 'running' || !run || !id || w.busy || w.checking) return
  const now = Date.now()
  if (now - w.spawnedAt < QUIET_AFTER_SPAWN || now < w.mutedUntil) return
  if (!limitHit(tailText(id, 40))) return
  w.checking = true
  try {
    await useStore.getState().refresh(run.accountId)
  } catch {
    /* no fresh numbers: the text decides */
  } finally {
    w.checking = false
  }
  if (get().phase !== 'running' || get().run?.id !== run.id || w.terminalId !== id) return
  const snap = useStore.getState().usage[run.accountId]
  const b = bindingWindow(snap)
  if (snap && b && fresh(snap, now) && leftOf(b) >= ROOM_LEFT) {
    w.mutedUntil = Date.now() + FALSE_ALARM_MUTE
    if (w.falseAlarmFor !== id) {
      w.falseAlarmFor = id
      addLog('false-alarm', `The terminal mentioned a usage limit, but ${label(run.accountId)} still has ${Math.round(leftOf(b))}% left. Carrying on.`)
    }
    return
  }
  void handoff('limit')
}

/** The account to continue on: most left, not drained during this run, and able to open the chat's history. */
function nextAccount(run: AutopilotRun): Account | undefined {
  const s = useStore.getState()
  const current = s.accounts.find((a) => a.id === run.accountId)
  if (!current) return undefined
  const now = Date.now()
  const home = claudeHome()
  const out = Object.keys(run.exhausted).filter((id) => run.exhausted[id]! > now)
  return pickAccount(s.accounts, s.usage, {
    providerId: 'claude',
    exclude: out,
    accept: (a) => a.id === current.id || historyShared(current, a, home, api.platform)
  })
}

/** The run's account ran out (`limit`) or its CLI stopped (`exit`): move the chat to the best account. */
async function handoff(why: 'limit' | 'exit') {
  const { phase, run } = get()
  if (phase !== 'running' || !run || w.busy) return
  w.busy = true
  try {
    clearTimeout(timers.debounce)
    const from = run.accountId
    const snap = useStore.getState().usage[from]
    const b = bindingWindow(snap)
    const exhausted = why === 'limit' ? { ...run.exhausted, [from]: exhaustedUntil(snap, Date.now()) } : run.exhausted
    // Window labels read "5-hour session" or "Weekly limit".
    const reason = why === 'limit' ? `${label(from)} ran out${b ? ` (${b.label.replace(/\s*limit$/i, '')} limit)` : ''}.` : 'The terminal stopped.'
    set({ phase: 'handing-off', run: { ...run, exhausted } })
    await refreshAll()
    if (get().phase !== 'handing-off' || get().run?.id !== run.id) return
    const next = nextAccount(get().run!)
    if (!next) return wait()
    await relaunch(next, (left) => `${reason} Continued on ${next.label}${left}.`, 'handoff')
  } finally {
    w.busy = false
  }
}

/** While waiting: try again with the latest usage (refreshed first when a timer woke us). */
async function wake(refresh: boolean) {
  const { phase, run } = get()
  if (phase !== 'waiting' || !run || w.busy || Date.now() < w.retryAt) return
  w.busy = true
  try {
    if (refresh) await refreshAll()
    if (get().phase !== 'waiting' || get().run?.id !== run.id) return
    const next = nextAccount(get().run!)
    if (!next) return wait()
    set({ phase: 'handing-off' })
    // Even on the same account, restart with the continue prompt: the drained CLI may still hold the chat.
    await relaunch(next, (left) => `${next.label} has room again${left}. Continued the task.`, 'resumed')
  } finally {
    w.busy = false
  }
}

/** Nothing has room: wait for the soonest reset, or check every 10 minutes when no reset time is known. */
function wait() {
  const run = get().run!
  const s = useStore.getState()
  const until = soonestReset(
    s.accounts.filter((a) => a.providerId === 'claude'),
    s.usage,
    run.exhausted,
    Date.now()
  )
  const changed = get().phase !== 'waiting' || run.waitingUntil !== until
  set({ phase: 'waiting', run: { ...run, waitingUntil: until } })
  if (changed) addLog('waiting', until ? `No account has room. Waiting until ${clock(until)}.` : 'No account has room. Checking again every 10 minutes.')
  scheduleWake(until)
}

function scheduleWake(until: number | undefined) {
  clearTimeout(timers.wake)
  const ms = until ? Math.max(SECOND, until + WAKE_AFTER_RESET - Date.now()) : WAKE_UNKNOWN
  timers.wake = setTimeout(() => void wake(true), ms)
}

function clock(t: number): string {
  const d = new Date(t)
  const today = d.toDateString() === new Date().toDateString()
  return today ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })
}

/**
 * Restarts the run's pane on `next`, resuming the chat with the continue prompt. Exactly one CLI owns the chat
 * afterwards: the grid stops the old one first. A start that fails leaves the run waiting for a retry.
 */
async function relaunch(next: Account, describe: (left: string) => string, kind: 'handoff' | 'resumed') {
  const run = get().run!
  let conversationId = run.conversationId
  let thrown: string | undefined
  try {
    const at = paneOf(run.paneUid)
    if (!at?.pane.accountId) return finish(PANE_CLOSED, true)
    // The grid only restarts panes of the session on screen.
    if (useGrid.getState().activeId !== at.sessionId) useGrid.getState().switchSession(at.sessionId)
    const extraArgs = [...permissionArgs(run.skipPermissions), CONTINUE_PROMPT]
    if (at.pane.terminalId) {
      conversationId = (await api.terminals.session(at.pane.terminalId).catch(() => null)) ?? conversationId
      await useGrid.getState().continueOn(at.index, next.id, { extraArgs })
    } else {
      // An earlier start failed: nothing left to ask for the chat, so use the id seen before.
      await useGrid.getState().start(at.index, { accountId: next.id, target: 'cli', cwd: at.pane.cwd ?? run.cwd, resume: true, resumeSession: conversationId, extraArgs })
    }
  } catch (e) {
    thrown = errorText(e)
  }
  if (get().phase !== 'handing-off' || get().run?.id !== run.id) return // stopped meanwhile
  const after = paneOf(run.paneUid)
  if (!after?.pane.accountId) return finish(PANE_CLOSED, true)
  const tid = after.pane.terminalId
  if (!tid) {
    const why = thrown ?? (useGrid.getState().errors[run.paneUid] || 'the terminal did not start')
    addLog('error', `Couldn't continue on ${next.label}: ${why}`)
    w.retryAt = Date.now() + RETRY_AFTER_ERROR
    set({ phase: 'waiting', run: { ...get().run!, conversationId, waitingUntil: w.retryAt } })
    clearTimeout(timers.wake)
    timers.wake = setTimeout(() => void wake(true), RETRY_AFTER_ERROR)
    return
  }
  if (thrown) addLog('error', thrown)
  spawned(tid)
  const text = describe(leftText(next.id))
  set({ phase: 'running', run: { ...get().run!, accountId: next.id, handoffs: run.handoffs + 1, waitingUntil: undefined, conversationId } })
  addLog(kind, text)
  useStore.getState().toast({ kind: 'info', title: kind === 'resumed' ? 'Autopilot resumed' : 'Autopilot moved on', body: text })
}

function load(): Pick<AutopilotState, 'phase' | 'run' | 'log'> | null {
  try {
    const d = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as Partial<AutopilotState> | null
    const phases: AutopilotPhase[] = ['idle', 'starting', 'running', 'handing-off', 'waiting', 'stopped']
    if (!d || !phases.includes(d.phase as AutopilotPhase)) return null
    const run = d.run && typeof d.run.paneUid === 'string' && typeof d.run.accountId === 'string' ? d.run : null
    return { phase: d.phase as AutopilotPhase, run, log: Array.isArray(d.log) ? d.log.slice(0, LOG_MAX) : [] }
  } catch {
    return null
  }
}

function save({ phase, run, log }: AutopilotState) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ phase, run, log }))
  } catch {
    /* private mode or full storage: the run works, it just won't survive a restart */
  }
}

useAutopilot.subscribe((s, prev) => {
  if (s.phase !== prev.phase || s.run !== prev.run || s.log !== prev.log) save(s)
  if (active(s.phase) !== active(prev.phase)) {
    if (active(s.phase)) watch()
    else unwatch()
    keepAwake(active(s.phase))
  }
})

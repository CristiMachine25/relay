// Autopilot: runs one task in Claude Code on the account with the most left and, when that account's usage
// runs out mid-task, moves the same conversation to the next account by itself. Built for someone away from
// the keyboard. Pure decisions live in @/lib/autopilot; this store owns the run, its timers and the terminal.
import { create } from 'zustand'
import { api, errorText } from '@/api'
import { useStore } from '@/store'
import { useGrid } from '@/terminals/store'
import { permissionArgs, pickAccount, taskArg } from '@/lib/autopilot'
import { historyToTurnOn, isBlocked, isSignedOut } from '@/lib/grid'
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

const LOG_MAX = 50
const active = (p: AutopilotPhase) => p !== 'idle' && p !== 'stopped'

export const useAutopilot = create<AutopilotState>((set, get) => ({
  phase: 'idle',
  run: null,
  log: [],

  async init() {},

  async start(input) {
    const fail = (title: string, body?: string) => useStore.getState().toast({ kind: 'error', title, body })
    if (active(get().phase)) return fail('Autopilot is already running', 'Stop the current run first.')
    const task = input.task.trim()
    if (!task) return fail('Give Autopilot a task first')
    if (!best()) return fail('No Claude account has room right now', "Autopilot needs a signed-in Claude account that isn't at its limit.")

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

function keepAwake(on: boolean) {
  try {
    void api.system.keepAwake(on).catch(() => {})
  } catch {
    /* a backend without it: the run still works while the computer stays awake */
  }
}

useAutopilot.subscribe((s, prev) => {
  if (active(s.phase) !== active(prev.phase)) keepAwake(active(s.phase))
})

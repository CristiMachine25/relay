import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Account, TerminalInfo, TerminalSpawnRequest, UsageSnapshot } from '@shared/types'
import { CONTINUE_PROMPT, FABLE, restartPrompt, taskArg } from '@/lib/autopilot'

// A fake backend: spawns answer at once, kills report the exit like the real backend does.
const fake = vi.hoisted(() => {
  const handlers: Record<string, ((payload: unknown) => void)[]> = {}
  const state = {
    seq: 0,
    requests: [] as TerminalSpawnRequest[],
    live: [] as TerminalInfo[],
    spawnError: null as string | null,
    exit: (_id: string, _code: number | null) => {},
    screens: {} as Record<string, string>
  }
  return { handlers, state }
})

vi.mock('@/api', () => ({
  api: {
    platform: 'darwin',
    terminals: {
      spawn: vi.fn(async (req: TerminalSpawnRequest) => {
        fake.state.requests.push(req)
        if (fake.state.spawnError) throw fake.state.spawnError
        const info = { id: `t${++fake.state.seq}`, accountId: req.accountId, exited: false } as TerminalInfo
        fake.state.live.push(info)
        return info
      }),
      kill: vi.fn(async (id: string) => {
        fake.state.live = fake.state.live.filter((t) => t.id !== id)
        fake.state.exit(id, null)
      }),
      list: async () => fake.state.live,
      scrollback: async () => '',
      session: vi.fn(async () => 'conv-1')
    },
    system: { keepAwake: vi.fn(async () => true) },
    on: (event: string, cb: (payload: unknown) => void) => {
      ;(fake.handlers[event] ??= []).push(cb)
      return () => {
        fake.handlers[event] = (fake.handlers[event] ?? []).filter((x) => x !== cb)
      }
    }
  },
  errorText: String
}))

vi.mock('@/terminals/registry', () => ({
  disposeTerm: vi.fn(),
  estimateSize: () => ({ cols: 100, rows: 30 }),
  focusTerm: vi.fn(),
  getTerm: vi.fn(),
  prepare: vi.fn(),
  onTerminalExit: (fn: (id: string, code: number | null) => void) => {
    fake.state.exit = fn
  },
  // A screen is its text; a mark sits on its last row and reading after it skips the rows up to there.
  markEnd: (id: string) => ({ line: rows(id).length - 1 }),
  tailText: (id: string, lines = 40, fromLine = 0) => rows(id).slice(fromLine).slice(-lines).join('\n')
}))
const rows = (id: string) => (fake.state.screens[id] ? fake.state.screens[id].split('\n') : [])

// The main store, reduced to what autopilot reads. `server` is what a usage refresh brings back.
const main = vi.hoisted(() => {
  type Listener = (s: Record<string, unknown>, prev: Record<string, unknown>) => void
  const listeners = new Set<Listener>()
  const server: Record<string, { used: number; resetsAt?: string; stale?: boolean; fable?: number; fableResetsAt?: string }> = {}
  let state: Record<string, unknown> = {}
  const setState = (patch: Record<string, unknown>) => {
    const prev = state
    state = { ...state, ...patch }
    for (const l of listeners) l(state, prev)
  }
  return { listeners, server, setState, getState: () => state, reset: (s: Record<string, unknown>) => (state = s) }
})
vi.mock('@/store', () => ({
  useStore: {
    getState: () => main.getState(),
    setState: main.setState,
    subscribe: (l: (s: Record<string, unknown>, prev: Record<string, unknown>) => void) => {
      main.listeners.add(l)
      return () => main.listeners.delete(l)
    }
  }
}))

vi.stubGlobal('document', { querySelector: () => null })
vi.stubGlobal('requestAnimationFrame', (f: () => void) => f())
const storage = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (k: string) => storage.get(k) ?? null,
  setItem: (k: string, v: string) => void storage.set(k, v),
  removeItem: (k: string) => void storage.delete(k)
})

const { api } = await import('@/api')

const NOW = Date.parse('2026-11-04T10:00:00Z')
const HOUR = 3_600_000

type Usage = { used: number; resetsAt?: string; stale?: boolean; fable?: number; fableResetsAt?: string }
const snap = (accountId: string, u: Usage): UsageSnapshot => ({
  accountId,
  providerId: 'claude',
  fetchedAt: new Date().toISOString(),
  source: 'api',
  stale: u.stale,
  windows: [
    { id: 'five_hour', label: '5-hour', usedPercent: u.used, resetsAt: u.resetsAt, windowMinutes: 300 },
    // The Fable window, when the test gives one: half the weekly limit.
    ...(u.fable === undefined
      ? []
      : [{ id: 'seven_day_fable', label: 'Weekly Fable', usedPercent: u.fable, resetsAt: u.fableResetsAt, windowMinutes: 10080, shareOfWeekly: 50 }])
  ]
})

const account = (id: string, label: string, extra: Partial<Account> = {}): Account =>
  ({
    id,
    providerId: 'claude',
    label,
    homeDir: `/Users/me/.claude-${id}`,
    isDefaultHome: false,
    sharing: { skills: true, plugins: true, agents: true, instructions: true, settings: true, mcp: true, history: true },
    status: 'ok',
    ...extra
  }) as Account

/** Sets what the backend's usage reports, now and on the next refresh. */
function setUsage(used: Record<string, number | Usage>) {
  for (const [id, u] of Object.entries(used)) main.server[id] = typeof u === 'number' ? { used: u } : u
  main.setState({ usage: serverUsage() })
}
const serverUsage = () => Object.fromEntries(Object.entries(main.server).map(([id, u]) => [id, snap(id, u)]))

const refresh = vi.fn(async (_id?: string) => main.setState({ usage: serverUsage() }))
const toast = vi.fn()
const go = vi.fn()
const updateAccount = vi.fn(async (id: string, patch: Partial<Account>) => {
  const accounts = (main.getState().accounts as Account[]).map((a) => (a.id === id ? { ...a, ...patch } : a))
  main.setState({ accounts })
  return true
})

function resetMain(accounts: Account[]) {
  for (const k of Object.keys(main.server)) delete main.server[k]
  main.reset({
    accounts,
    usage: {},
    providers: [{ id: 'claude', defaultHome: '/Users/me/.claude' }],
    settings: { defaultCwd: '/work' },
    resolvedTheme: 'dark',
    refresh,
    toast,
    go,
    updateAccount
  })
}

/** Fresh grid + autopilot modules, as after an app start; localStorage carries over. */
async function boot() {
  vi.resetModules()
  const { useGrid } = await import('@/terminals/store')
  const { useAutopilot } = await import('./store')
  return { grid: useGrid, ap: useAutopilot }
}

const emit = (event: string, payload: unknown) => (fake.handlers[event] ?? []).forEach((cb) => cb(payload))
const lastSpawn = () => fake.state.requests[fake.state.requests.length - 1]!
const kinds = (log: { kind: string }[]) => log.map((x) => x.kind)
/** The run's terminal id right now. */
function runTerminal(grid: Awaited<ReturnType<typeof boot>>['grid'], uid: string) {
  const g = grid.getState()
  const at = g.locate(uid)!
  const ws = at.sessionId === g.activeId ? g.ws : g.sessions.find((x) => x.id === at.sessionId)!.ws
  return ws.panes[at.index]!.terminalId
}

/** The old window goes away: its listeners and timers with it (the backend and its terminals stay). */
function quitApp() {
  main.listeners.clear()
  for (const k of Object.keys(fake.handlers)) delete fake.handlers[k]
  const now = Date.now()
  vi.clearAllTimers() // also rewinds the fake clock
  vi.setSystemTime(now)
}

const H1 = account('h1', 'Claude H1')
const H2 = account('h2', 'Claude H2')
const H3 = account('h3', 'Claude H3')
const TASK = { task: 'Fix the flaky test', skipPermissions: true }

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  for (const k of Object.keys(fake.handlers)) delete fake.handlers[k]
  main.listeners.clear()
  storage.clear()
  fake.state.seq = 0
  fake.state.requests = []
  fake.state.live = []
  fake.state.spawnError = null
  fake.state.screens = {}
  vi.clearAllMocks()
  vi.mocked(api.terminals.session).mockImplementation(async () => 'conv-1')
  resetMain([H1, H2, H3])
  setUsage({ h1: 70, h2: 20, h3: 50 })
})

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

/** Starts a run on h2 (most left) and lets the "replayed screen" quiet period pass. */
async function running() {
  const env = await boot()
  await env.ap.getState().start(TASK)
  await vi.advanceTimersByTimeAsync(21_000)
  return env
}

describe('starting a run', () => {
  it('starts the task on the account with the most left, in a new "Autopilot" session, with the permission flags', async () => {
    const { grid, ap } = await boot()
    const before = grid.getState().activeId
    await ap.getState().start({ task: '  Fix the\nflaky test ', skipPermissions: true })
    const s = ap.getState()
    expect(s.phase).toBe('running')
    expect(s.run).toMatchObject({ accountId: 'h2', task: 'Fix the\nflaky test', handoffs: 0, skipPermissions: true })
    expect(fake.state.requests).toHaveLength(1)
    expect(lastSpawn()).toMatchObject({
      accountId: 'h2',
      target: 'cli',
      cwd: '/work',
      extraArgs: ['--permission-mode', 'bypassPermissions', 'Fix the flaky test']
    })
    expect(lastSpawn().resume).toBeFalsy()
    const session = grid.getState().sessions.find((x) => x.id === s.run!.sessionId)!
    expect(session.name).toBe('Autopilot')
    expect(session.id).not.toBe(before)
    expect(grid.getState().locate(s.run!.paneUid)).toEqual({ sessionId: session.id, index: 0 })
    expect(runTerminal(grid, s.run!.paneUid)).toBe('t1')
    expect(kinds(s.log)).toEqual(['start'])
    expect(s.log[0]!.text).toContain('Claude H2')
    expect(api.system.keepAwake).toHaveBeenLastCalledWith(true)
    expect(go).not.toHaveBeenCalled()
  })

  it('uses the given folder and leaves permission prompts on when asked', async () => {
    const { ap } = await boot()
    await ap.getState().start({ task: 'Do it', cwd: '/elsewhere', skipPermissions: false })
    expect(lastSpawn()).toMatchObject({ cwd: '/elsewhere', extraArgs: ['Do it'] })
  })

  it('turns on history sharing for signed-in accounts that lack it, so the chat can move to any of them', async () => {
    const off = (a: Account) => ({ ...a.sharing, history: false })
    const main1 = account('m', 'Main', { homeDir: '/Users/me/.claude', isDefaultHome: true, sharing: off(H1) })
    const noHist = account('n', 'No history', { sharing: off(H1) })
    const signedOut = account('o', 'Signed out', { sharing: off(H1), status: 'needs-login' })
    const blocked = account('b', 'Blocked', { sharing: off(H1), status: 'blocked' })
    resetMain([H1, main1, noHist, signedOut, blocked])
    setUsage({ h1: 10 })
    const { ap } = await boot()
    await ap.getState().start(TASK)
    expect(updateAccount).toHaveBeenCalledTimes(1)
    expect(updateAccount).toHaveBeenCalledWith('n', { sharing: { ...H1.sharing, history: true } }, { quiet: true })
  })

  it('refuses an empty task, a second run, and a run with no usable account', async () => {
    const { ap } = await boot()
    expect(await ap.getState().start({ task: '   ', skipPermissions: true })).toBe(false)
    expect(ap.getState().phase).toBe('idle')
    expect(toast).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'error' }))

    setUsage({ h1: 100, h2: 100, h3: 100 })
    expect(await ap.getState().start(TASK)).toBe(false)
    expect(ap.getState().phase).toBe('idle')
    expect(fake.state.requests).toHaveLength(0)

    setUsage({ h1: 10 })
    expect(await ap.getState().start(TASK)).toBe(true)
    expect(await ap.getState().start(TASK)).toBe(false)
    expect(fake.state.requests).toHaveLength(1)
    expect(toast).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'error' }))
  })

  it('goes back to the form, saying why, when it fails before a run exists', async () => {
    resetMain([H1, account('n', 'No history', { sharing: { ...H1.sharing, history: false } })])
    setUsage({ h1: 10 })
    updateAccount.mockRejectedValueOnce(new Error('disk full'))
    const { ap } = await boot()
    expect(await ap.getState().start(TASK)).toBe(false)
    expect(ap.getState()).toMatchObject({ phase: 'idle', run: null, log: [] })
    expect(toast).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'error', body: expect.stringContaining('disk full') }))
    expect(api.system.keepAwake).toHaveBeenLastCalledWith(false)
  })

  it('goes back to the form when stopped before its run exists', async () => {
    const { ap } = await boot()
    const started = ap.getState().start(TASK)
    expect(ap.getState().phase).toBe('starting')
    ap.getState().stop()
    expect(await started).toBe(false)
    expect(ap.getState()).toMatchObject({ phase: 'idle', run: null })
    expect(fake.state.requests).toHaveLength(0)
  })

  it('stops with the reason when the first terminal could not start', async () => {
    fake.state.spawnError = 'claude not found'
    const { ap } = await boot()
    expect(await ap.getState().start(TASK)).toBe(false)
    expect(ap.getState().phase).toBe('stopped')
    expect(ap.getState().run!.error).toContain('claude not found')
    expect(api.system.keepAwake).toHaveBeenLastCalledWith(false)
  })
})

describe('moving to the next account', () => {
  it('reacts to limit text on the terminal (debounced) and confirms it with a refresh', async () => {
    const { grid, ap } = await running()
    main.server.h2 = { used: 100, resetsAt: new Date(NOW + 2 * HOUR).toISOString() }
    fake.state.screens.t1 = "Working…\nYou've hit your limit · resets 2pm"
    emit('terminal-output', { id: 't1', data: 'x' })
    expect(refresh).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1_100)
    expect(refresh).toHaveBeenCalledWith('h2')
    const run = ap.getState().run!
    expect(ap.getState().phase).toBe('running')
    expect(run.accountId).toBe('h3')
    expect(run.handoffs).toBe(1)
    expect(run.legs!.map((l) => l.accountId)).toEqual(['h2', 'h3'])
    expect(run.exhausted.h2).toBe(Date.parse(main.server.h2.resetsAt!))
    expect(api.terminals.kill).toHaveBeenCalledWith('t1')
    expect(lastSpawn()).toMatchObject({
      accountId: 'h3',
      resume: true,
      resumeSession: 'conv-1',
      extraArgs: ['--permission-mode', 'bypassPermissions', CONTINUE_PROMPT]
    })
    expect(runTerminal(grid, run.paneUid)).toBe('t2')
    expect(ap.getState().log[0]).toMatchObject({ kind: 'handoff' })
    expect(ap.getState().log[0]!.text).toMatch(/Claude H2 ran out .*Continued on Claude H3 \(50% left\)/)
    expect(toast).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'info' }))
  })

  it('also checks the screen every 15 seconds without new output', async () => {
    const { ap } = await running()
    main.server.h2 = { used: 100 }
    fake.state.screens.t1 = 'Claude usage limit reached.'
    await vi.advanceTimersByTimeAsync(15_000)
    expect(ap.getState().run!.accountId).toBe('h3')
  })

  it('ignores limit text shown in the first 20 seconds after a spawn (a resumed chat replays old screens), then and later', async () => {
    const { ap } = await boot()
    await ap.getState().start(TASK)
    main.server.h2 = { used: 100 }
    fake.state.screens.t1 = "Earlier: You've hit your limit · resets 2pm\n> continue"
    emit('terminal-output', { id: 't1', data: 'x' })
    await vi.advanceTimersByTimeAsync(15_500)
    expect(refresh).not.toHaveBeenCalled()
    // Still on screen once the quiet period is over, the replayed message is still not a new one.
    await vi.advanceTimersByTimeAsync(60_000)
    expect(refresh).not.toHaveBeenCalled()
    expect(ap.getState().run!.accountId).toBe('h2')
    fake.state.screens.t1 += "\nWorking…\nYou've hit your limit · resets 5pm"
    emit('terminal-output', { id: 't1', data: 'x' })
    await vi.advanceTimersByTimeAsync(1_100)
    expect(ap.getState().run!.accountId).toBe('h3')
  })

  it('hands off when a usage update shows the account at its limit', async () => {
    const { ap } = await running()
    setUsage({ h2: 100 })
    await vi.advanceTimersByTimeAsync(0)
    expect(ap.getState().run!.accountId).toBe('h3')
    expect(lastSpawn()).toMatchObject({ accountId: 'h3', resume: true, extraArgs: ['--permission-mode', 'bypassPermissions', CONTINUE_PROMPT] })
    expect(ap.getState().run!.exhausted.h2).toBe(NOW + 21_000 + HOUR)
  })

  it('skips accounts the chat history cannot reach', async () => {
    resetMain([H1, H2, account('h3', 'Claude H3', { sharing: { ...H1.sharing, history: false } })])
    setUsage({ h1: 70, h2: 20, h3: 30 })
    updateAccount.mockImplementationOnce(async () => false) // turning history on for h3 failed
    const { ap } = await running()
    setUsage({ h2: 100 })
    await vi.advanceTimersByTimeAsync(0)
    expect(ap.getState().run!.accountId).toBe('h1')
  })

  it('continues its own pane in the background, leaving the user in the session they switched to meanwhile', async () => {
    const { grid, ap } = await running()
    const uid = ap.getState().run!.paneUid
    let release = () => {}
    refresh.mockImplementationOnce(() => new Promise<void>((r) => (release = () => r(main.setState({ usage: serverUsage() })))))
    setUsage({ h2: 100 })
    await vi.advanceTimersByTimeAsync(0)
    expect(ap.getState().phase).toBe('handing-off')
    // The user opens a session of their own while the usage refreshes; its pane 0 is the user's.
    const mine = grid.getState().newSession()
    const userPane = grid.getState().ws.panes[0]
    release()
    await vi.advanceTimersByTimeAsync(0)
    expect(ap.getState().phase).toBe('running')
    expect(grid.getState().activeId).toBe(mine)
    expect(grid.getState().ws.panes[0]).toEqual(userPane)
    expect(runTerminal(grid, uid)).toBe('t2')
    expect(ap.getState().run!.accountId).toBe('h3')
  })

  it('waits and retries no sooner than a minute later when the next terminal fails to start', async () => {
    const { grid, ap } = await running()
    fake.state.spawnError = 'spawn failed'
    setUsage({ h2: 100 })
    await vi.advanceTimersByTimeAsync(0)
    expect(ap.getState().phase).toBe('waiting')
    expect(ap.getState().log[0]).toMatchObject({ kind: 'error' })
    expect(ap.getState().log[0]!.text).toContain('spawn failed')
    fake.state.spawnError = null
    setUsage({ h1: 40 })
    await vi.advanceTimersByTimeAsync(0)
    expect(fake.state.requests).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(61_000)
    expect(fake.state.requests).toHaveLength(3)
    expect(ap.getState().phase).toBe('running')
    expect(ap.getState().run!.accountId).toBe('h1')
    // The pane had no terminal left to ask, so the conversation id seen before the first try is used.
    expect(lastSpawn()).toMatchObject({ accountId: 'h1', resume: true, resumeSession: 'conv-1' })
    expect(runTerminal(grid, ap.getState().run!.paneUid)).toBe('t2')
  })
})

describe('the conversation it continues', () => {
  const session = () => vi.mocked(api.terminals.session)

  it('is learned from the running CLI once the replayed screens are over', async () => {
    const { ap } = await boot()
    await ap.getState().start(TASK)
    expect(session()).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(20_000)
    expect(session()).toHaveBeenCalledWith('t1')
    expect(ap.getState().run!.conversationId).toBe('conv-1')
  })

  it('is asked for on every check until the CLI can say, then no more', async () => {
    session().mockResolvedValue(null)
    const { ap } = await running()
    expect(ap.getState().run!.conversationId).toBeUndefined()
    session().mockResolvedValue('conv-late')
    await vi.advanceTimersByTimeAsync(15_000)
    expect(ap.getState().run!.conversationId).toBe('conv-late')
    const asked = session().mock.calls.length
    await vi.advanceTimersByTimeAsync(60_000)
    expect(session().mock.calls.length).toBe(asked)
  })

  it('is asked for again when a handoff starts, while the CLI still runs', async () => {
    await running()
    session().mockResolvedValue('conv-2')
    setUsage({ h2: 100 })
    await vi.advanceTimersByTimeAsync(0)
    expect(lastSpawn()).toMatchObject({ accountId: 'h3', resume: true, resumeSession: 'conv-2' })
  })

  it('is the one seen while the CLI ran, not what its exited terminal is asked', async () => {
    await running()
    session().mockResolvedValue('newest-in-folder')
    fake.state.exit('t1', 1)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(lastSpawn()).toMatchObject({ accountId: 'h2', resume: true, resumeSession: 'conv-1' })
    expect(session()).toHaveBeenCalledTimes(1)
  })

  it('is never guessed: with none known, the task starts over in a new chat', async () => {
    session().mockResolvedValue(null)
    const { grid, ap } = await running()
    setUsage({ h2: 100 })
    await vi.advanceTimersByTimeAsync(0)
    expect(lastSpawn().resume).toBeFalsy()
    expect(lastSpawn().resumeSession).toBeUndefined()
    expect(lastSpawn()).toMatchObject({ accountId: 'h3', extraArgs: ['--permission-mode', 'bypassPermissions', taskArg(restartPrompt(TASK.task))] })
    expect(api.terminals.kill).toHaveBeenCalledWith('t1')
    expect(runTerminal(grid, ap.getState().run!.paneUid)).toBe('t2')
    expect(ap.getState().phase).toBe('running')
    expect(ap.getState().log[0]).toMatchObject({ kind: 'handoff' })
    expect(ap.getState().log[0]!.text).toMatch(/started the task over in a new chat/)
  })
})

describe('limit text the usage does not confirm', () => {
  it('is ignored, logged once, and not re-checked for 2 minutes', async () => {
    const { ap } = await running()
    fake.state.screens.t1 = 'The docs say: 5-hour limit reached means wait'
    emit('terminal-output', { id: 't1', data: 'x' })
    await vi.advanceTimersByTimeAsync(1_100)
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(ap.getState().run!.accountId).toBe('h2')
    expect(kinds(ap.getState().log)).toEqual(['false-alarm', 'start'])
    expect(ap.getState().log[0]!.text).toContain('80% left')

    emit('terminal-output', { id: 't1', data: 'x' })
    await vi.advanceTimersByTimeAsync(110_000)
    expect(refresh).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(30_000)
    expect(refresh).toHaveBeenCalledTimes(2)
    expect(kinds(ap.getState().log)).toEqual(['false-alarm', 'start'])
    expect(fake.state.requests).toHaveLength(1)
  })

  it('is trusted when the usage is stale', async () => {
    const { ap } = await running()
    main.server.h2 = { used: 20, stale: true }
    fake.state.screens.t1 = "You've hit your limit"
    emit('terminal-output', { id: 't1', data: 'x' })
    await vi.advanceTimersByTimeAsync(1_100)
    expect(ap.getState().run!.accountId).toBe('h3')
  })

  it('is trusted when the account reports no usage at all', async () => {
    resetMain([H1, H2])
    setUsage({ h1: 100 })
    const { ap } = await running()
    expect(ap.getState().run!.accountId).toBe('h2')
    fake.state.screens.t1 = "You've hit your limit"
    emit('terminal-output', { id: 't1', data: 'x' })
    await vi.advanceTimersByTimeAsync(1_100)
    expect(ap.getState().phase).toBe('waiting')
  })
})

describe('when no account has room', () => {
  it('waits for the soonest reset, then resumes on the account that came back', async () => {
    const soon = new Date(NOW + HOUR).toISOString()
    const later = new Date(NOW + 3 * HOUR).toISOString()
    resetMain([H1, H2])
    setUsage({ h1: { used: 100, resetsAt: later }, h2: 20 })
    const { ap } = await running()
    setUsage({ h2: { used: 100, resetsAt: soon } })
    await vi.advanceTimersByTimeAsync(0)
    expect(ap.getState().phase).toBe('waiting')
    expect(ap.getState().run!.waitingUntil).toBe(Date.parse(soon))
    expect(ap.getState().log[0]).toMatchObject({ kind: 'waiting' })
    expect(fake.state.requests).toHaveLength(1)

    // Reset passes; the next refresh shows room again.
    main.server.h2 = { used: 0 }
    await vi.advanceTimersByTimeAsync(Date.parse(soon) - Date.now() + 61_000)
    expect(ap.getState().phase).toBe('running')
    expect(ap.getState().run!.accountId).toBe('h2')
    expect(ap.getState().run!.waitingUntil).toBeUndefined()
    expect(lastSpawn()).toMatchObject({ accountId: 'h2', resume: true, resumeSession: 'conv-1', extraArgs: ['--permission-mode', 'bypassPermissions', CONTINUE_PROMPT] })
    expect(api.terminals.kill).toHaveBeenCalledWith('t1')
    expect(ap.getState().log[0]).toMatchObject({ kind: 'resumed' })
  })

  it('resumes early when a usage update shows an account with room', async () => {
    resetMain([H1, H2])
    setUsage({ h1: 100, h2: 20 })
    const { ap } = await running()
    setUsage({ h2: 100 })
    await vi.advanceTimersByTimeAsync(0)
    expect(ap.getState().phase).toBe('waiting')
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    setUsage({ h1: 30 })
    await vi.advanceTimersByTimeAsync(0)
    expect(ap.getState().phase).toBe('running')
    expect(ap.getState().run!.accountId).toBe('h1')
  })
})

describe('when the terminal exits', () => {
  it('logs it and picks the conversation back up on the best account', async () => {
    const { grid, ap } = await running()
    fake.state.exit('t1', 1)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(kinds(ap.getState().log).slice(0, 2)).toEqual(['handoff', 'exit'])
    // h2 still has the most left, so it carries on there.
    expect(lastSpawn()).toMatchObject({ accountId: 'h2', resume: true, resumeSession: 'conv-1' })
    expect(ap.getState().phase).toBe('running')
    expect(runTerminal(grid, ap.getState().run!.paneUid)).toBe('t2')
  })

  it('stops after 3 exits within 10 minutes', async () => {
    const { ap } = await running()
    for (const id of ['t1', 't2']) {
      fake.state.exit(id, 1)
      await vi.advanceTimersByTimeAsync(60_000)
    }
    expect(ap.getState().phase).toBe('running')
    fake.state.exit('t3', 1)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(ap.getState().phase).toBe('stopped')
    expect(ap.getState().run!.error).toMatch(/3 times/)
    expect(fake.state.requests).toHaveLength(3)
    expect(api.system.keepAwake).toHaveBeenLastCalledWith(false)
  })

  it('does not count the exits its own handoffs cause', async () => {
    const { ap } = await running()
    setUsage({ h2: 100 })
    await vi.advanceTimersByTimeAsync(30_000)
    setUsage({ h3: 100 })
    await vi.advanceTimersByTimeAsync(30_000)
    expect(ap.getState().run!.accountId).toBe('h1')
    fake.state.exit('t3', 1)
    await vi.advanceTimersByTimeAsync(30_000)
    fake.state.exit('t4', 1)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(ap.getState().phase).toBe('running')
    expect(kinds(ap.getState().log).filter((k) => k === 'exit')).toHaveLength(2)
  })

})

describe('stopping', () => {
  it('stops reacting, keeps the terminal, and lets the computer sleep', async () => {
    const { ap } = await running()
    ap.getState().stop()
    expect(ap.getState().phase).toBe('stopped')
    expect(ap.getState().log[0]).toMatchObject({ kind: 'stopped', text: 'Stopped by you' })
    expect(api.system.keepAwake).toHaveBeenLastCalledWith(false)
    setUsage({ h2: 100 })
    fake.state.screens.t1 = "You've hit your limit"
    emit('terminal-output', { id: 't1', data: 'x' })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(api.terminals.kill).not.toHaveBeenCalled()
    expect(fake.state.requests).toHaveLength(1)

    ap.getState().dismiss()
    expect(ap.getState()).toMatchObject({ phase: 'idle', run: null, log: [] })
  })

  it("closes the run's grid session when it is dismissed, unless a terminal in it still runs", async () => {
    const { grid, ap } = await running()
    const { sessionId } = ap.getState().run!
    ap.getState().stop()
    ap.getState().dismiss()
    await vi.advanceTimersByTimeAsync(0)
    expect(grid.getState().sessions.some((x) => x.id === sessionId)).toBe(true)

    await ap.getState().start(TASK)
    const second = ap.getState().run!
    ap.getState().stop()
    fake.state.exit(runTerminal(grid, second.paneUid)!, 0)
    ap.getState().dismiss()
    await vi.advanceTimersByTimeAsync(0)
    expect(grid.getState().sessions.some((x) => x.id === second.sessionId)).toBe(false)
    expect(grid.getState().sessions.some((x) => x.id === sessionId)).toBe(true)
  })

  it('stops when the pane is closed', async () => {
    const { grid, ap } = await running()
    await grid.getState().close(0)
    expect(ap.getState().phase).toBe('stopped')
    expect(ap.getState().run!.error).toMatch(/closed/)
  })

  it("stops when the run's account is removed", async () => {
    const { ap } = await running()
    main.setState({ accounts: [H1, H3] })
    expect(ap.getState().phase).toBe('stopped')
    expect(ap.getState().run!.error).toMatch(/removed/)
  })

  it("does not let a check left over from a stopped run unlock the next run's checks", async () => {
    /** The next usage refresh hangs until the returned function is called. */
    const hang = () => {
      let done = () => {}
      refresh.mockImplementationOnce(() => new Promise<void>((r) => (done = r)))
      return () => done()
    }
    const { grid, ap } = await running()
    fake.state.screens.t1 = "You've hit your limit"
    const first = hang()
    emit('terminal-output', { id: 't1', data: 'x' })
    await vi.advanceTimersByTimeAsync(1_100)
    expect(refresh).toHaveBeenCalledTimes(1)
    ap.getState().stop()
    ap.getState().dismiss()

    await ap.getState().start(TASK)
    await vi.advanceTimersByTimeAsync(21_000)
    const t2 = runTerminal(grid, ap.getState().run!.paneUid)!
    fake.state.screens[t2] = "You've hit your limit"
    hang()
    emit('terminal-output', { id: t2, data: 'x' })
    await vi.advanceTimersByTimeAsync(1_100)
    expect(refresh).toHaveBeenCalledTimes(2)
    // The old run's check finishes; the new run's is still waiting for its refresh.
    first()
    await vi.advanceTimersByTimeAsync(0)
    emit('terminal-output', { id: t2, data: 'x' })
    await vi.advanceTimersByTimeAsync(1_100)
    expect(refresh).toHaveBeenCalledTimes(2)
  })

  it('opens the terminal on request', async () => {
    const { grid, ap } = await running()
    grid.getState().newSession()
    ap.getState().openTerminal()
    expect(grid.getState().activeId).toBe(ap.getState().run!.sessionId)
    expect(go).toHaveBeenCalledWith('terminals')
  })
})

describe('staying on Fable', () => {
  const FABLE_TASK = { ...TASK, model: 'fable' as const }
  const fableArgs = ['--permission-mode', 'bypassPermissions', '--model', FABLE.id]

  it('asks the CLI for Fable when it starts the task', async () => {
    const { ap } = await boot()
    await ap.getState().start(FABLE_TASK)
    expect(ap.getState().run).toMatchObject({ model: 'fable' })
    expect(lastSpawn()).toMatchObject({ accountId: 'h2', extraArgs: [...fableArgs, 'Fix the flaky test'] })
  })

  it('asks for Fable again on the next account, resuming the chat or starting over', async () => {
    const { ap } = await boot()
    await ap.getState().start(FABLE_TASK)
    await vi.advanceTimersByTimeAsync(21_000)
    setUsage({ h2: 100 })
    await vi.advanceTimersByTimeAsync(0)
    expect(lastSpawn()).toMatchObject({ accountId: 'h3', resume: true, resumeSession: 'conv-1', extraArgs: [...fableArgs, CONTINUE_PROMPT] })

    vi.mocked(api.terminals.session).mockResolvedValue(null)
    ap.getState().stop()
    ap.getState().dismiss()
    setUsage({ h2: 20 })
    await ap.getState().start(FABLE_TASK)
    await vi.advanceTimersByTimeAsync(21_000)
    setUsage({ h2: 100 })
    await vi.advanceTimersByTimeAsync(0)
    expect(lastSpawn().resumeSession).toBeUndefined()
    expect(lastSpawn()).toMatchObject({ accountId: 'h3', extraArgs: [...fableArgs, taskArg(restartPrompt(TASK.task))] })
  })

  it('starts on the account with the most left counting Fable, and says how much Fable that is', async () => {
    // h2 has the most left in general but little Fable; h1 reports no Fable window, so it comes last.
    setUsage({ h1: 0, h2: { used: 20, fable: 90 }, h3: { used: 10, fable: 30 } })
    const { ap } = await boot()
    await ap.getState().start(FABLE_TASK)
    expect(ap.getState().run!.accountId).toBe('h3')
    expect(ap.getState().log[0]!.text).toBe('Started on Claude H3 (Fable 70% left).')
  })

  it('moves on to the account with the most left counting Fable', async () => {
    setUsage({ h1: { used: 70, fable: 20 }, h2: { used: 20, fable: 0 }, h3: { used: 50, fable: 90 } })
    const { ap } = await boot()
    await ap.getState().start(FABLE_TASK)
    await vi.advanceTimersByTimeAsync(21_000)
    setUsage({ h2: { used: 100, fable: 0 } })
    await vi.advanceTimersByTimeAsync(0)
    expect(ap.getState().run!.accountId).toBe('h1')
    expect(ap.getState().log[0]!.text).toMatch(/Continued on Claude H1 \(30% left\)\.$/)
  })

  it('does not start when no account has Fable left, though they have room in general', async () => {
    setUsage({ h1: { used: 0, fable: 100 }, h2: { used: 0, fable: 100 }, h3: { used: 0, fable: 100 } })
    const { ap } = await boot()
    expect(await ap.getState().start(FABLE_TASK)).toBe(false)
    expect(toast).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'error', title: 'No Claude account has Fable left right now' }))
    expect(await ap.getState().start(TASK)).toBe(true)
  })

  /** A Fable run on h2 (most left), past its quiet period. */
  async function onFable() {
    const env = await boot()
    await env.ap.getState().start(FABLE_TASK)
    await vi.advanceTimersByTimeAsync(21_000)
    return env
  }
  const fableReset = new Date(NOW + 50 * HOUR).toISOString()

  it('takes the CLI running out of Fable as a drain, checks it, and moves on', async () => {
    setUsage({ h1: { used: 70, fable: 10 }, h2: { used: 20, fable: 40 }, h3: { used: 50, fable: 20 } })
    const { ap } = await onFable()
    main.server.h2 = { used: 20, fable: 100, fableResetsAt: fableReset }
    fake.state.screens.t1 = 'Working…\nFable limit reached · continuing on Sonnet 5'
    emit('terminal-output', { id: 't1', data: 'x' })
    await vi.advanceTimersByTimeAsync(1_100)
    expect(refresh).toHaveBeenCalledWith('h2')
    const run = ap.getState().run!
    expect(run.accountId).toBe('h3')
    // Back when its Fable allowance resets, not its 5-hour session.
    expect(run.exhausted.h2).toBe(Date.parse(fableReset))
    expect(ap.getState().log[0]).toMatchObject({ kind: 'handoff', text: 'Claude H2 ran out of Fable. Continued on Claude H3 (50% left).' })
    expect(lastSpawn()).toMatchObject({ accountId: 'h3', extraArgs: [...fableArgs, CONTINUE_PROMPT] })
  })

  it('carries on when the account still has plenty of Fable left', async () => {
    setUsage({ h2: { used: 20, fable: 40 } })
    const { ap } = await onFable()
    fake.state.screens.t1 = "You've reached your Fable limit."
    emit('terminal-output', { id: 't1', data: 'x' })
    await vi.advanceTimersByTimeAsync(1_100)
    expect(ap.getState().run!.accountId).toBe('h2')
    expect(ap.getState().log[0]).toMatchObject({
      kind: 'false-alarm',
      text: 'The terminal mentioned the Fable limit, but Claude H2 still has Fable 60% left. Carrying on.'
    })
  })

  it('is not dismissed because the general limits still have room', async () => {
    setUsage({ h2: { used: 20, fable: 98 } })
    const { ap } = await onFable()
    fake.state.screens.t1 = "You've reached your Fable limit."
    emit('terminal-output', { id: 't1', data: 'x' })
    await vi.advanceTimersByTimeAsync(1_100)
    expect(ap.getState().run!.accountId).toBe('h3')
  })

  it('trusts the Fable text on an account that reports no Fable window', async () => {
    const { ap } = await onFable()
    fake.state.screens.t1 = "You've reached your Fable limit."
    emit('terminal-output', { id: 't1', data: 'x' })
    await vi.advanceTimersByTimeAsync(1_100)
    expect(ap.getState().run!.accountId).toBe('h3')
  })

  it('moves on when a usage update shows the account out of Fable, with no text on screen', async () => {
    setUsage({ h2: { used: 20, fable: 40 } })
    const { ap } = await onFable()
    setUsage({ h2: { used: 20, fable: 100, fableResetsAt: fableReset } })
    await vi.advanceTimersByTimeAsync(0)
    expect(ap.getState().run!.accountId).toBe('h3')
    expect(ap.getState().run!.exhausted.h2).toBe(Date.parse(fableReset))
    expect(ap.getState().log[0]!.text).toMatch(/^Claude H2 ran out of Fable\./)
  })

  it('ignores Fable running out on a run on the default model', async () => {
    setUsage({ h2: { used: 20, fable: 40 } })
    const { ap } = await running()
    fake.state.screens.t1 = 'Fable limit reached · continuing on Sonnet 5'
    emit('terminal-output', { id: 't1', data: 'x' })
    await vi.advanceTimersByTimeAsync(1_100)
    expect(refresh).not.toHaveBeenCalled()
    setUsage({ h2: { used: 20, fable: 100 } })
    await vi.advanceTimersByTimeAsync(0)
    expect(ap.getState().run!.accountId).toBe('h2')
    expect(fake.state.requests).toHaveLength(1)
  })

  it("keeps the account's default model otherwise", async () => {
    const { ap } = await running()
    expect(ap.getState().run!.model).toBe('default')
    expect(lastSpawn().extraArgs).not.toContain('--model')
  })
})

describe('across restarts', () => {
  it('saves the run and picks it up again while its terminal is still running', async () => {
    const first = await running()
    const saved = JSON.parse(storage.get('relay.autopilot')!)
    expect(saved).toMatchObject({ phase: 'running', run: { accountId: 'h2' } })
    expect(saved.log).toHaveLength(1)
    const run = first.ap.getState().run!
    quitApp()

    const { ap } = await boot()
    expect(ap.getState().phase).toBe('idle')
    await ap.getState().init()
    await ap.getState().init()
    expect(ap.getState().phase).toBe('running')
    expect(ap.getState().run).toEqual(run)
    expect(api.system.keepAwake).toHaveBeenLastCalledWith(true)

    // Old screen text is replayed after a restart: it is ignored, and new limit text after it is not.
    fake.state.screens.t1 = "You've hit your limit"
    main.server.h2 = { used: 100 }
    await vi.advanceTimersByTimeAsync(30_000)
    expect(ap.getState().run!.accountId).toBe('h2')
    fake.state.screens.t1 += "\nYou've hit your limit"
    await vi.advanceTimersByTimeAsync(15_000)
    expect(ap.getState().run!.accountId).toBe('h3')
  })

  it('loads a run saved before it had a model as one on the default model', async () => {
    await running()
    const saved = JSON.parse(storage.get('relay.autopilot')!)
    delete saved.run.model
    storage.set('relay.autopilot', JSON.stringify(saved))
    quitApp()

    const { ap } = await boot()
    await ap.getState().init()
    expect(ap.getState().phase).toBe('running')
    expect(ap.getState().run!.model).toBe('default')
  })

  it('drops damaged route entries from a saved run but keeps the run', async () => {
    await running()
    const saved = JSON.parse(storage.get('relay.autopilot')!)
    saved.run.legs = [null, { accountId: 'h2', at: 1 }, { accountId: 7 }]
    storage.set('relay.autopilot', JSON.stringify(saved))
    quitApp()

    const { ap } = await boot()
    await ap.getState().init()
    expect(ap.getState().phase).toBe('running')
    expect(ap.getState().run!.legs).toEqual([{ accountId: 'h2', at: 1 }])
  })

  it('leaves alone a run started while the saved one was being restored', async () => {
    const saved = (await running()).ap.getState().run!
    quitApp()

    const { ap } = await boot()
    const restoring = ap.getState().init()
    const started = ap.getState().start({ task: 'A new task', skipPermissions: false })
    await Promise.all([restoring, started])
    expect(ap.getState().phase).toBe('running')
    expect(ap.getState().run!.id).not.toBe(saved.id)
    expect(ap.getState().run!.task).toBe('A new task')
    expect(kinds(ap.getState().log)).toEqual(['start'])
  })

  it('lets the computer sleep after a reload with no run under way, in case the old page kept it awake', async () => {
    const { ap } = await boot()
    await ap.getState().init()
    expect(api.system.keepAwake).toHaveBeenLastCalledWith(false)

    const first = await running()
    first.ap.getState().stop()
    quitApp()
    vi.mocked(api.system.keepAwake).mockClear()
    const again = await boot()
    await again.ap.getState().init()
    expect(again.ap.getState().phase).toBe('stopped')
    expect(api.system.keepAwake).toHaveBeenLastCalledWith(false)
  })

  it("stops a saved run whose terminal is gone", async () => {
    await running()
    quitApp()
    fake.state.live = []

    const { ap } = await boot()
    await ap.getState().init()
    expect(ap.getState().phase).toBe('stopped')
    expect(ap.getState().log[0]).toMatchObject({ kind: 'stopped', text: "Relay restarted and the run's terminal was gone" })
    expect(JSON.parse(storage.get('relay.autopilot')!).phase).toBe('stopped')
  })

  it('keeps waiting after a restart and wakes at the reset', async () => {
    resetMain([H2])
    const soon = new Date(NOW + HOUR).toISOString()
    setUsage({ h2: 20 })
    await running()
    setUsage({ h2: { used: 100, resetsAt: soon } })
    await vi.advanceTimersByTimeAsync(0)
    quitApp()

    const { ap } = await boot()
    await ap.getState().init()
    expect(ap.getState().phase).toBe('waiting')
    main.server.h2 = { used: 0 }
    await vi.advanceTimersByTimeAsync(Date.parse(soon) - Date.now() + 61_000)
    expect(ap.getState().phase).toBe('running')
    expect(ap.getState().log[0]).toMatchObject({ kind: 'resumed' })
  })
})

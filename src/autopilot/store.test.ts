import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Account, TerminalInfo, TerminalSpawnRequest, UsageSnapshot } from '@shared/types'
import { CONTINUE_PROMPT } from '@/lib/autopilot'

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
  tailText: (id: string) => fake.state.screens[id] ?? ''
}))

// The main store, reduced to what autopilot reads. `server` is what a usage refresh brings back.
const main = vi.hoisted(() => {
  type Listener = (s: Record<string, unknown>, prev: Record<string, unknown>) => void
  const listeners = new Set<Listener>()
  const server: Record<string, { used: number; resetsAt?: string; stale?: boolean }> = {}
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

const snap = (accountId: string, used: number, resetsAt?: string, stale?: boolean): UsageSnapshot => ({
  accountId,
  providerId: 'claude',
  fetchedAt: new Date().toISOString(),
  source: 'api',
  stale,
  windows: [{ id: 'five_hour', label: '5-hour', usedPercent: used, resetsAt, windowMinutes: 300 }]
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
function setUsage(used: Record<string, number | { used: number; resetsAt?: string; stale?: boolean }>) {
  for (const [id, u] of Object.entries(used)) main.server[id] = typeof u === 'number' ? { used: u } : u
  main.setState({ usage: serverUsage() })
}
const serverUsage = () => Object.fromEntries(Object.entries(main.server).map(([id, u]) => [id, snap(id, u.used, u.resetsAt, u.stale)]))

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

/** Fresh grid + autopilot modules, as after an app start. */
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
    await ap.getState().start({ task: '   ', skipPermissions: true })
    expect(ap.getState().phase).toBe('idle')
    expect(toast).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'error' }))

    setUsage({ h1: 100, h2: 100, h3: 100 })
    await ap.getState().start(TASK)
    expect(ap.getState().phase).toBe('idle')
    expect(fake.state.requests).toHaveLength(0)

    setUsage({ h1: 10 })
    await ap.getState().start(TASK)
    await ap.getState().start(TASK)
    expect(fake.state.requests).toHaveLength(1)
    expect(toast).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'error' }))
  })

  it('stops with the reason when the first terminal could not start', async () => {
    fake.state.spawnError = 'claude not found'
    const { ap } = await boot()
    await ap.getState().start(TASK)
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

  it('ignores limit text in the first 20 seconds after a spawn (a resumed chat replays old screens)', async () => {
    const { ap } = await boot()
    await ap.getState().start(TASK)
    main.server.h2 = { used: 100 }
    fake.state.screens.t1 = "You've hit your limit"
    emit('terminal-output', { id: 't1', data: 'x' })
    await vi.advanceTimersByTimeAsync(15_500)
    expect(refresh).not.toHaveBeenCalled()
    expect(ap.getState().run!.accountId).toBe('h2')
    await vi.advanceTimersByTimeAsync(15_000)
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

  it('moves the grid to the autopilot session before continuing', async () => {
    const { grid, ap } = await running()
    const other = grid.getState().newSession()
    expect(grid.getState().activeId).toBe(other)
    setUsage({ h2: 100 })
    await vi.advanceTimersByTimeAsync(0)
    expect(grid.getState().activeId).toBe(ap.getState().run!.sessionId)
    expect(runTerminal(grid, ap.getState().run!.paneUid)).toBe('t2')
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

  it('opens the terminal on request', async () => {
    const { grid, ap } = await running()
    grid.getState().newSession()
    ap.getState().openTerminal()
    expect(grid.getState().activeId).toBe(ap.getState().run!.sessionId)
    expect(go).toHaveBeenCalledWith('terminals')
  })
})

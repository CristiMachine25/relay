import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Account, TerminalInfo, TerminalSpawnRequest, UsageSnapshot } from '@shared/types'

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

/** Starts a run on h2 (most left). */
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

describe('stopping', () => {
  it('keeps the terminal and lets the computer sleep', async () => {
    const { ap } = await running()
    ap.getState().stop()
    expect(ap.getState().phase).toBe('stopped')
    expect(ap.getState().log[0]).toMatchObject({ kind: 'stopped', text: 'Stopped by you' })
    expect(api.system.keepAwake).toHaveBeenLastCalledWith(false)
    expect(api.terminals.kill).not.toHaveBeenCalled()

    ap.getState().dismiss()
    expect(ap.getState()).toMatchObject({ phase: 'idle', run: null, log: [] })
  })

  it('opens the terminal on request', async () => {
    const { grid, ap } = await running()
    grid.getState().newSession()
    ap.getState().openTerminal()
    expect(grid.getState().activeId).toBe(ap.getState().run!.sessionId)
    expect(go).toHaveBeenCalledWith('terminals')
  })
})

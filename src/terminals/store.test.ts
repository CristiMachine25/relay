import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalInfo, TerminalSpawnRequest } from '@shared/types'

const spawns: ((info: TerminalInfo) => void)[] = []
const requests: TerminalSpawnRequest[] = []
const kill = vi.fn(async () => {})
const session = vi.fn(async (_id: string): Promise<string | null> => null)
vi.mock('@/api', () => ({
  api: {
    terminals: {
      spawn: (req: TerminalSpawnRequest) => {
        requests.push(req)
        return new Promise((r) => spawns.push(r))
      },
      kill,
      list: async () => [],
      scrollback: async () => '',
      session
    }
  },
  errorText: String
}))
vi.mock('@/store', () => ({ useStore: { getState: () => ({ resolvedTheme: 'dark', settings: null, go() {} }) } }))
const registry = vi.hoisted(() => ({
  disposeTerm: vi.fn(),
  estimateSize: () => ({ cols: 80, rows: 24 }),
  focusTerm: vi.fn(),
  getTerm: vi.fn(),
  onTerminalExit: vi.fn(),
  prepare: vi.fn()
}))
vi.mock('./registry', () => registry)
vi.stubGlobal('document', { querySelector: () => null })
vi.stubGlobal('requestAnimationFrame', (f: () => void) => f())

const { useGrid } = await import('./store')
const info = (id: string) => ({ id, accountId: 'acc-1' }) as TerminalInfo

describe('a spawn that finishes after its pane moved on', () => {
  beforeEach(() => {
    spawns.length = 0
    requests.length = 0
    vi.clearAllMocks()
  })

  it('kills the terminal when the pane was closed during the spawn', async () => {
    const started = useGrid.getState().start(0, { accountId: 'acc-1', target: 'cli' })
    await useGrid.getState().close(0)
    spawns[0]!(info('t-closed'))
    await started
    expect(kill).toHaveBeenCalledWith('t-closed')
    expect(registry.disposeTerm).toHaveBeenCalledWith('t-closed')
    expect(registry.getTerm).not.toHaveBeenCalled()
    expect(useGrid.getState().ws.panes[0]!.terminalId).toBeUndefined()
    expect(useGrid.getState().starting[useGrid.getState().ws.panes[0]!.uid]).toBe(false)
  })

  it('attaches the terminal to its pane in the session the user switched away from', async () => {
    const uid = useGrid.getState().ws.panes[0]!.uid
    const from = useGrid.getState().activeId
    const started = useGrid.getState().start(0, { accountId: 'acc-1', target: 'cli' })
    useGrid.getState().newSession()
    spawns[0]!(info('t-elsewhere'))
    await started
    expect(kill).not.toHaveBeenCalled()
    expect(useGrid.getState().ws.panes.some((p) => p.terminalId)).toBe(false)
    const pane = useGrid.getState().sessions.find((x) => x.id === from)!.ws.panes.find((p) => p.uid === uid)!
    expect(pane.terminalId).toBe('t-elsewhere')
    useGrid.getState().switchSession(from)
    expect(useGrid.getState().ws.panes[0]!.terminalId).toBe('t-elsewhere')
  })
})

describe('moving a pane to another account', () => {
  beforeEach(() => {
    spawns.length = 0
    requests.length = 0
    vi.clearAllMocks()
    // An empty pane: starting one that has a terminal stops that terminal first.
    useGrid.getState().newSession()
  })

  it("reopens that pane's own conversation, asked for before the pane stops", async () => {
    const started = useGrid.getState().start(0, { accountId: 'acc-1', target: 'cli', cwd: '/work' })
    spawns[0]!(info('t-1'))
    await started
    session.mockImplementation(async (id) => {
      expect(kill).not.toHaveBeenCalled()
      return id === 't-1' ? 'conv-1' : null
    })

    const moved = useGrid.getState().continueOn(0, 'acc-2')
    await vi.waitFor(() => expect(spawns).toHaveLength(2))
    spawns[1]!({ id: 't-2', accountId: 'acc-2' } as TerminalInfo)
    await moved
    expect(kill).toHaveBeenCalledWith('t-1')
    expect(requests[1]).toMatchObject({ accountId: 'acc-2', cwd: '/work', resume: true, resumeSession: 'conv-1' })
  })

  it('falls back to the most recent conversation when the tool cannot say', async () => {
    const started = useGrid.getState().start(0, { accountId: 'acc-1', target: 'cli' })
    spawns[0]!(info('t-3'))
    await started
    session.mockResolvedValue(null)
    const moved = useGrid.getState().continueOn(0, 'acc-2')
    await vi.waitFor(() => expect(spawns).toHaveLength(2))
    spawns[1]!({ id: 't-4', accountId: 'acc-2' } as TerminalInfo)
    await moved
    expect(requests[1]).toMatchObject({ resume: true })
    expect(requests[1]!.resumeSession).toBeUndefined()
  })
})

describe('panes by id, whichever session is on screen', () => {
  beforeEach(() => {
    spawns.length = 0
    requests.length = 0
    vi.clearAllMocks()
    session.mockReset()
  })

  /** A new session with a running pane; returns the session and the pane's uid. */
  async function sessionWithPane(id: string) {
    const sessionId = useGrid.getState().newSession()
    const uid = useGrid.getState().ws.panes[0]!.uid
    const started = useGrid.getState().start(0, { accountId: 'acc-1', target: 'cli', cwd: '/work' })
    spawns[spawns.length - 1]!(info(id))
    await started
    return { sessionId, uid }
  }
  const paneIn = (sessionId: string, uid: string) => {
    const g = useGrid.getState()
    const ws = sessionId === g.activeId ? g.ws : g.sessions.find((x) => x.id === sessionId)!.ws
    return ws.panes.find((p) => p.uid === uid)!
  }

  it("moves its own pane when the user switches sessions meanwhile, and leaves the user's pane alone", async () => {
    const { sessionId, uid } = await sessionWithPane('t-own')
    let answer: (id: string) => void = () => {}
    session.mockImplementation(() => new Promise((r) => (answer = r)))
    const moved = useGrid.getState().continueOn(0, 'acc-2')
    // While the conversation is looked up, the user opens another session; its pane 0 is the user's.
    const mine = useGrid.getState().newSession()
    const userPane = useGrid.getState().ws.panes[0]!
    answer('conv-own')
    await vi.waitFor(() => expect(spawns).toHaveLength(2))
    spawns[1]!({ id: 't-own-2', accountId: 'acc-2' } as TerminalInfo)
    await moved
    expect(useGrid.getState().activeId).toBe(mine)
    expect(useGrid.getState().ws.panes[0]).toEqual(userPane)
    expect(paneIn(sessionId, uid)).toMatchObject({ accountId: 'acc-2', terminalId: 't-own-2', resumeSession: 'conv-own' })
    expect(kill).toHaveBeenCalledWith('t-own')
  })

  it('continues a pane of a session in the background in the conversation it is given, without asking for one', async () => {
    const { sessionId, uid } = await sessionWithPane('t-bg')
    useGrid.getState().newSession()
    const moved = useGrid.getState().continuePane(uid, 'acc-2', { resumeSession: 'conv-given', extraArgs: ['continue'] })
    await vi.waitFor(() => expect(spawns).toHaveLength(2))
    spawns[1]!({ id: 't-bg-2', accountId: 'acc-2' } as TerminalInfo)
    await moved
    expect(session).not.toHaveBeenCalled()
    expect(kill).toHaveBeenCalledWith('t-bg')
    expect(requests[1]).toMatchObject({ accountId: 'acc-2', cwd: '/work', resume: true, resumeSession: 'conv-given', extraArgs: ['continue'] })
    expect(paneIn(sessionId, uid)).toMatchObject({ accountId: 'acc-2', terminalId: 't-bg-2' })
  })

  it("starts a pane of a session in the background afresh, replacing that pane's terminal", async () => {
    const { sessionId, uid } = await sessionWithPane('t-fresh')
    useGrid.getState().newSession()
    const started = useGrid.getState().startPane(uid, { accountId: 'acc-1', target: 'cli', cwd: '/work', extraArgs: ['task'] })
    await vi.waitFor(() => expect(spawns).toHaveLength(2))
    expect(kill).toHaveBeenCalledWith('t-fresh')
    spawns[1]!(info('t-fresh-2'))
    await started
    expect(requests[1]!.resume).toBeFalsy()
    expect(paneIn(sessionId, uid).terminalId).toBe('t-fresh-2')
  })
})

describe('extra CLI arguments', () => {
  beforeEach(() => {
    spawns.length = 0
    requests.length = 0
    vi.clearAllMocks()
    session.mockReset()
    // An empty pane: starting one that has a terminal stops that terminal first.
    useGrid.getState().newSession()
  })

  async function startWithTask(id: string) {
    const started = useGrid.getState().start(0, { accountId: 'acc-1', target: 'cli', cwd: '/work', extraArgs: ['--permission-mode', 'bypassPermissions', 'fix it'] })
    spawns[0]!(info(id))
    await started
  }

  it('sends them with the spawn, but keeps them out of the pane', async () => {
    await startWithTask('t-args')
    expect(requests[0]).toMatchObject({ accountId: 'acc-1', cwd: '/work', extraArgs: ['--permission-mode', 'bypassPermissions', 'fix it'] })
    expect(useGrid.getState().ws.panes[0]).not.toHaveProperty('extraArgs')
  })

  it('does not send them again when the pane restarts', async () => {
    await startWithTask('t-again')
    const restarted = useGrid.getState().restart(0, true)
    await vi.waitFor(() => expect(spawns).toHaveLength(2))
    spawns[1]!(info('t-again-2'))
    await restarted
    expect(requests[1]).toMatchObject({ accountId: 'acc-1', resume: true })
    expect(requests[1]!.extraArgs).toBeUndefined()
  })

  it("passes them on when the pane moves to another account, still in the pane's conversation", async () => {
    await startWithTask('t-move')
    session.mockImplementation(async (id) => (id === 't-move' ? 'conv-9' : null))
    const moved = useGrid.getState().continueOn(0, 'acc-2', { extraArgs: ['continue'] })
    await vi.waitFor(() => expect(spawns).toHaveLength(2))
    spawns[1]!({ id: 't-moved', accountId: 'acc-2' } as TerminalInfo)
    await moved
    expect(kill).toHaveBeenCalledWith('t-move')
    expect(requests[1]).toMatchObject({ accountId: 'acc-2', cwd: '/work', resume: true, resumeSession: 'conv-9', extraArgs: ['continue'] })
  })
})

describe('sessions', () => {
  beforeEach(() => {
    spawns.length = 0
    requests.length = 0
    vi.clearAllMocks()
  })

  it('returns the id of a new session, which becomes the active one', () => {
    const id = useGrid.getState().newSession()
    expect(id).toBe(useGrid.getState().activeId)
    expect(useGrid.getState().sessions.some((x) => x.id === id)).toBe(true)
  })

  it('starts a terminal in a new named session', async () => {
    const id = useGrid.getState().newSession()
    useGrid.getState().renameSession(id, 'Autopilot')
    const started = useGrid.getState().start(0, { accountId: 'acc-1', target: 'cli', extraArgs: ['task'] })
    spawns[0]!(info('t-auto'))
    await started
    expect(useGrid.getState().sessions.find((x) => x.id === id)!.name).toBe('Autopilot')
    expect(useGrid.getState().activeId).toBe(id)
    expect(useGrid.getState().ws.panes[0]).toMatchObject({ accountId: 'acc-1', terminalId: 't-auto' })
  })

  it('finds a pane in the active session or in one in the background', () => {
    const first = useGrid.getState().newSession()
    useGrid.getState().setLayout(2)
    const uid = useGrid.getState().ws.panes[1]!.uid
    expect(useGrid.getState().locate(uid)).toEqual({ sessionId: first, index: 1 })
    const second = useGrid.getState().newSession()
    const other = useGrid.getState().ws.panes[0]!.uid
    expect(useGrid.getState().locate(other)).toEqual({ sessionId: second, index: 0 })
    expect(useGrid.getState().locate(uid)).toEqual({ sessionId: first, index: 1 })
    expect(useGrid.getState().locate('no-such-pane')).toBeNull()
  })
})

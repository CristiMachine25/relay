import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Account, ProviderInfo, UsageSnapshot } from '@shared/types'
import { DEFAULT_SHARING } from '@shared/types'

vi.mock('@/api', () => ({ api: { platform: 'darwin', on: () => () => {} }, errorText: String }))
// The real store runs the engine; the card only reads its state and calls its actions on click.
vi.mock('@/autopilot/store', async () => {
  const { create } = await import('zustand')
  return {
    useAutopilot: create(() => ({ phase: 'idle', run: null, log: [], init: async () => {}, start: async () => true, stop() {}, dismiss() {}, openTerminal() {} }))
  }
})
const { useStore } = await import('@/store')
const { useAutopilot } = await import('@/autopilot/store')
const { AutopilotCard } = await import('./AutopilotCard')

const NOW = Date.parse('2026-11-04T12:00:00Z')

const account = (id: string, label: string, extra: Partial<Account> = {}): Account => ({
  id,
  providerId: 'claude',
  label,
  homeDir: `/Users/sam/.relay/${id}`,
  isDefaultHome: false,
  sharing: { ...DEFAULT_SHARING, history: true },
  color: '#3987E5',
  tags: [],
  status: 'ok',
  createdAt: '2026-01-01T00:00:00Z',
  launchCount: 0,
  ...extra
})

const snap = (accountId: string, used: number, resetsInMin = 90): UsageSnapshot => ({
  accountId,
  providerId: 'claude',
  fetchedAt: new Date(NOW).toISOString(),
  source: 'api',
  windows: [{ id: 'five_hour', label: '5-hour session', usedPercent: used, resetsAt: new Date(NOW + resetsInMin * 60_000).toISOString(), windowMinutes: 300 }]
})

/** The same with the Fable window, by percent of its allowance used. */
const fable = (accountId: string, used: number, fableUsed: number, resetsInMin = 3000): UsageSnapshot => {
  const s = snap(accountId, used)
  const w = { id: 'seven_day_fable', label: 'Weekly Fable', usedPercent: fableUsed, resetsAt: new Date(NOW + resetsInMin * 60_000).toISOString(), windowMinutes: 10080, shareOfWeekly: 50 }
  return { ...s, windows: [...s.windows, w] }
}

const claude = { id: 'claude', name: 'Claude Code', defaultHome: '/Users/sam/.claude' } as ProviderInfo
const work = account('w', 'Work')
const home = account('h', 'Home')

// renderToStaticMarkup reads the stores' initial state (zustand's server snapshot), so that is what gets set.
type StoreState = ReturnType<typeof useStore.getState>
type PilotState = ReturnType<typeof useAutopilot.getState>
function render(s: Partial<StoreState>, pilot: Partial<PilotState> = {}) {
  Object.assign(useStore.getInitialState(), { providers: [claude], now: NOW, settings: null, ...s })
  Object.assign(useAutopilot.getInitialState(), { phase: 'idle', run: null, log: [], ...pilot })
  return renderToStaticMarkup(<AutopilotCard />)
}

describe('AutopilotCard', () => {
  it('stays out of the way without Claude accounts', () => {
    expect(render({ accounts: [] })).toBe('')
    expect(render({ accounts: [account('c', 'Codex', { providerId: 'codex' })] })).toBe('')
  })

  it('offers the Claude account with the most left', () => {
    const html = render({ accounts: [work, home], usage: { w: snap('w', 70), h: snap('h', 20) } })
    expect(html).toContain('aria-labelledby="autopilot-title"')
    expect(html).toContain('Start on Home · 80% left</button>')
    expect(html).toContain('Your home folder')
    expect(html).toMatch(/type="checkbox"[^>]*checked=""/)
    expect(html).toContain('It can run any command')
    // Every account already shares history, so there is nothing to turn on.
    expect(html).not.toContain('turns on chat history sharing')
  })

  it('lists the accounts in the order a run would use them, and the ones it cannot use', () => {
    const out = account('o', 'Out')
    const html = render({ accounts: [work, home, out], usage: { w: snap('w', 70), h: snap('h', 20), o: snap('o', 100, 45) } })
    expect(html).toContain('Handoff order')
    expect(html.indexOf('>Home<')).toBeLessThan(html.indexOf('>Work<'))
    expect(html).toContain('aria-label="Not available now"')
    expect(html).toContain('Back in 45m')
    expect(html).toContain('aria-label="Dictate the task"')
  })

  it('says which accounts get history sharing turned on', () => {
    const solo = account('s', 'Solo', { sharing: { ...DEFAULT_SHARING, history: false } })
    const main = account('m', 'Main', { homeDir: '/Users/sam/.claude', isDefaultHome: true, sharing: { ...DEFAULT_SHARING, history: false } })
    const html = render({ accounts: [work, solo, main], usage: {}, settings: { defaultCwd: '/Users/sam/code' } as StoreState['settings'] })
    expect(html).toContain('turns on chat history sharing for Solo, so')
    expect(html).toContain('/Users/sam/code')
  })

  it('explains why it cannot start when every Claude account is at its limit', () => {
    const html = render({ accounts: [work, home], usage: { w: snap('w', 100, 200), h: snap('h', 100, 45) } })
    expect(html).toContain('No Claude account can take a task right now')
    expect(html).toContain('Home is back first, in 45m.')
    expect(html).toMatch(/<button type="submit" class="btn btn-primary" disabled=""/)
  })

  describe('the model', () => {
    const checked = (html: string) => html.match(/role="radio" aria-checked="true"[^>]*>([^<]*)</)?.[1]

    it('stays on Fable by default once an account reports its Fable allowance, and explains the trade-off', () => {
      const html = render({ accounts: [work, home], usage: { w: fable('w', 70, 10), h: fable('h', 20, 38) } })
      expect(html).toMatch(/role="radiogroup" aria-labelledby="[^"]+"/)
      expect(checked(html)).toBe('Fable 5.2 only')
      expect(html).toContain('Fable may use half of each account')
      expect(html).toContain('instead of carrying on with another model')
    })

    it("keeps the account's default model when no account reports a Fable allowance", () => {
      const html = render({ accounts: [work, home], usage: { w: snap('w', 70), h: snap('h', 20) } })
      expect(checked(html)).toBe('Account default')
      expect(html).toContain('Start on Home · 80% left</button>')
    })

    it('remembers the last choice', () => {
      const saved = new Map([['relay.autopilot.model', 'default']])
      vi.stubGlobal('localStorage', { getItem: (k: string) => saved.get(k) ?? null, setItem: () => {}, removeItem: () => {} })
      try {
        expect(checked(render({ accounts: [work], usage: { w: fable('w', 20, 0) } }))).toBe('Account default')
      } finally {
        vi.unstubAllGlobals()
      }
    })

    it('ranks and labels the accounts by the Fable they have left, and says when one is out of it', () => {
      const out = account('o', 'Out')
      const old = account('x', 'Older check')
      const html = render({ accounts: [work, home, out, old], usage: { w: fable('w', 70, 10), h: fable('h', 20, 38), o: fable('o', 0, 100), x: snap('x', 0) } })
      // Home's Fable (62% left) beats Work's 5-hour session (30% left).
      expect(html).toContain('Start on Home · Fable 62% left</button>')
      expect(html.indexOf('>Home<')).toBeLessThan(html.indexOf('>Work<'))
      expect(html).toContain('>30% left<')
      // No Fable window: last in line, but not left out.
      expect(html.indexOf('>Work<')).toBeLessThan(html.indexOf('>Older check<'))
      expect(html).toContain('Fable unknown')
      expect(html).toMatch(/aria-label="Not available now"(?:(?!<\/ul>).)*Out(?:(?!<\/ul>).)*Out of Fable until /)
    })

    it('says no account has Fable left when every one is out of it', () => {
      const html = render({ accounts: [work, home], usage: { w: fable('w', 0, 100, 600), h: fable('h', 0, 100, 3000) } })
      expect(html).toContain('No Claude account has Fable left right now')
      expect(html).toContain('Work is back first, in 10h.')
    })
  })

  const run = (extra: Partial<NonNullable<PilotState['run']>> = {}): NonNullable<PilotState['run']> => ({
    id: 'r1',
    task: 'Refactor the billing module and make the tests pass',
    cwd: '/Users/sam/code/shop',
    skipPermissions: true,
    model: 'default',
    providerId: 'claude',
    accountId: 'w',
    paneUid: 'p1',
    sessionId: 's1',
    startedAt: NOW - (2 * 60 + 14) * 60_000,
    handoffs: 3,
    exhausted: {},
    ...extra
  })
  const log = Array.from({ length: 7 }, (_, i) => ({ t: NOW - i * 60_000, kind: i === 0 ? ('handoff' as const) : ('start' as const), text: `Entry ${i}` }))

  it('shows a running task with its account, handoffs and a way to stop it', () => {
    const html = render({ accounts: [work, home], usage: { w: snap('w', 40) } }, { phase: 'running', run: run(), log })
    expect(html).toContain('<span aria-live="polite">Running</span>')
    expect(html).toContain('Refactor the billing module')
    expect(html).toContain('Work</span>')
    expect(html).toContain('60% left')
    expect(html).toContain('role="meter"')
    expect(html).toContain('Running 2h 14m · 3 handoffs')
    expect(html).toContain('Open terminal</button>')
    expect(html).toContain('Stop</button>')
    // Newest first, five of seven until asked for all.
    expect(html.indexOf('Entry 0')).toBeLessThan(html.indexOf('Entry 1'))
    expect(html).not.toContain('Entry 5')
    expect(html).toContain('Show all 7')
  })

  it('shows a run that stays on Fable, and how much Fable it has left', () => {
    const html = render({ accounts: [work, home], usage: { w: fable('w', 10, 55), h: fable('h', 0, 80) } }, { phase: 'running', run: run({ model: 'fable' }), log })
    expect(html).toContain('Fable 5.2 only')
    expect(html).toContain('45%</strong>')
    expect(html).toContain('left of weekly Fable')
    expect(html).toContain('· Fable 20% left')
  })

  it('shows the route a run took and who is next', () => {
    const legs = [{ accountId: 'h', at: NOW - 90 * 60_000 }, { accountId: 'h', at: NOW - 80 * 60_000 }, { accountId: 'w', at: NOW - 30 * 60_000 }]
    const html = render({ accounts: [work, home], usage: { w: snap('w', 40), h: snap('h', 50) } }, { phase: 'running', run: run({ legs }), log })
    expect(html).toContain('Route so far')
    // A resume on the same account is one stop, and the current one is marked.
    expect(html.match(/<li class="flex items-center gap-1.5"/g)).toHaveLength(2)
    expect(html).toMatch(/aria-current="step">(?:(?!<\/li>).)*Work<\/span><\/li>/)
    expect(html).toContain('Next if it runs out:')
    expect(html).toContain('· 50% left')
  })

  it('never names an account as next that cannot open the chat', () => {
    const solo = account('s', 'Solo', { sharing: { ...DEFAULT_SHARING, history: false } })
    const html = render({ accounts: [work, solo], usage: { w: snap('w', 40), s: snap('s', 0) } }, { phase: 'running', run: run(), log })
    expect(html).not.toContain('Solo</span>')
    expect(html).toContain('No other account has room')
  })

  it('says when a waiting run is back', () => {
    const html = render(
      { accounts: [work], usage: { w: snap('w', 100) } },
      { phase: 'waiting', run: run({ handoffs: 0, waitingUntil: NOW + 45 * 60_000 }), log: [] }
    )
    expect(html).toContain('Waiting for a reset</span>')
    expect(html).toContain('· back in 45m')
    expect(html).toContain('Limit reached')
    expect(html).toContain('no handoffs yet')
    expect(html).toContain('Nothing yet.')
  })

  it('shows the form again for a run that stopped before it existed', () => {
    const html = render({ accounts: [work], usage: { w: snap('w', 40) } }, { phase: 'stopped', run: null, log: [] })
    expect(html).toContain('Start on Work · 60% left</button>')
    expect(html).not.toContain('Stopped</span>')
  })

  it('shows why a run stopped and offers a new task', () => {
    const stoppedLog = [{ t: NOW - 60 * 60_000, kind: 'error' as const, text: 'The terminal kept exiting' }]
    const html = render(
      { accounts: [work], usage: { w: snap('w', 40) } },
      { phase: 'stopped', run: run({ error: 'The terminal exited 3 times in 10 minutes.' }), log: stoppedLog }
    )
    expect(html).toContain('Stopped</span>')
    expect(html).toContain('The terminal exited 3 times in 10 minutes.')
    expect(html).toContain('Ran 1h 14m · 3 handoffs')
    expect(html).toContain('Start a new task</button>')
    expect(html).toContain('Done</button>')
    expect(html).not.toContain('Stop</button>')
  })
})

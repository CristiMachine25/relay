import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Account, UsageSnapshot, UsageWindow } from '@shared/types'
import { DEFAULT_SHARING } from '@shared/types'

vi.mock('@/api', () => ({ api: { platform: 'darwin', on: () => () => {} }, errorText: String }))
// xterm needs a DOM; the header and banner never reach it in a static render.
vi.mock('./registry', () => ({ acquireWebgl() {}, fitTerm() {}, getTerm: () => ({ host: null }) }))
vi.mock('./store', async () => {
  const { create } = await import('zustand')
  return {
    useGrid: create(() => ({
      ws: { focused: 0, maximized: null, panes: [{ uid: 'p1', accountId: 'w', target: 'cli' }] },
      infos: { t1: { id: 't1', accountId: 'w', exited: false } },
      starting: {},
      errors: {},
      continueOn: async () => {},
      focus() {}
    }))
  }
})
vi.mock('@/autopilot/store', async () => {
  const { create } = await import('zustand')
  return { useAutopilot: create(() => ({ phase: 'idle', run: null })) }
})
const { useStore } = await import('@/store')
const { useAutopilot } = await import('@/autopilot/store')
const { Pane } = await import('./Pane')
const { useLimitView } = await import('./limitView')

const account = (id: string, label: string): Account => ({
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
  launchCount: 0
})
const snap = (accountId: string, used: number): UsageSnapshot => ({
  accountId,
  providerId: 'claude',
  fetchedAt: '2026-11-04T12:00:00Z',
  source: 'api',
  windows: [{ id: 'five_hour', label: '5-hour session', usedPercent: used, resetsAt: null }]
})

Object.assign(useStore.getInitialState(), { accounts: [account('w', 'Work'), account('h', 'Home')], usage: { w: snap('w', 100), h: snap('h', 10) } })
const pane = { uid: 'p1', accountId: 'w', target: 'cli' as const, terminalId: 't1' }
const render = (phase: string, paneUid = 'p1') => {
  Object.assign(useAutopilot.getInitialState(), { phase, run: { paneUid } })
  return renderToStaticMarkup(<Pane index={0} pane={pane} />)
}

describe('a pane an autopilot run owns', () => {
  it('is marked and leaves the move to the autopilot', () => {
    const html = render('running')
    expect(html).toContain('>Autopilot</span>')
    expect(html).toContain('Work hit its 5-hour session limit.')
    expect(html).toContain('Autopilot is moving this chat to another account…')
    expect(html).not.toContain('Continue on Home</button>')
  })

  it('says the autopilot is waiting while no account has room', () => {
    const html = render('waiting')
    expect(html).toContain('Autopilot is waiting for an account to have room…')
    expect(html).not.toContain('moving this chat')
    expect(html).not.toContain('Continue on Home</button>')
  })

  it('keeps the manual button once the run stopped, or on other panes', () => {
    for (const html of [render('stopped'), render('running', 'p2')]) {
      expect(html).not.toContain('>Autopilot</span>')
      expect(html).toContain('Continue on Home</button>')
    }
  })
})

const win = (id: string, label: string, used: number, extra: Partial<UsageWindow> = {}): UsageWindow => ({ id, label, usedPercent: used, windowMinutes: id === 'five_hour' ? 300 : 10080, resetsAt: null, ...extra })
const withWindows = (...windows: UsageWindow[]) => {
  // A static render reads the store's initial state.
  Object.assign(useStore.getInitialState(), { usage: { w: { ...snap('w', 0), windows } } })
}
const header = (view: 'five_hour' | 'seven_day' | 'seven_day_fable' = 'five_hour') => {
  Object.assign(useLimitView.getInitialState(), { view })
  Object.assign(useAutopilot.getInitialState(), { phase: 'idle', run: null })
  return renderToStaticMarkup(<Pane index={0} pane={pane} />)
}

describe('the limit a pane header shows', () => {
  const both = [win('five_hour', '5-hour session', 36, { resetsAt: '2026-11-09T14:10:00Z' }), win('seven_day', 'Weekly', 80)]

  it('is named, with how much is left and when it resets', () => {
    Object.assign(useStore.getInitialState(), { now: Date.parse('2026-11-09T12:00:00Z') })
    withWindows(...both)
    const html = header()
    expect(html).toContain('>5h</span>')
    expect(html).toContain('64%')
    expect(html).toContain('resets 2h 10m')
  })

  it('follows the chosen view', () => {
    withWindows(...both)
    const html = header('seven_day')
    expect(html).toContain('>Week</span>')
    expect(html).toContain('20%')
    expect(html).not.toContain('>5h</span>')
  })

  it('lists every window in the tooltip', () => {
    withWindows(...both)
    const html = header()
    expect(html).toContain('5-hour session: 64% left')
    expect(html).toContain('Weekly: 20% left')
  })

  it('says so, quietly, when the account has no such limit', () => {
    withWindows(win('seven_day', 'Weekly', 10))
    expect(header()).toContain('No 5-hour limit')
    withWindows(...both)
    expect(header('seven_day_fable')).not.toContain('Fable limit')
    withWindows()
    expect(header()).toContain('No live limits')
  })

  it('marks an account that is out through the limit not on screen', () => {
    withWindows(win('five_hour', '5-hour session', 20), win('seven_day', 'Weekly', 100))
    const html = header()
    expect(html).toContain('Weekly limit reached')
    expect(html).toContain('80%')
    // Viewing the limit that ran out needs no extra mark.
    expect(header('seven_day')).not.toContain('limit reached</span>')
  })

  it('does not warn while the account still has room', () => {
    withWindows(...both)
    expect(header()).not.toContain('limit reached')
  })
})

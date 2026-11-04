import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Account, UsageSnapshot } from '@shared/types'
import { DEFAULT_SHARING } from '@shared/types'

vi.mock('@/api', () => ({ api: { platform: 'darwin', on: () => () => {} }, errorText: String }))
// xterm needs a DOM; the header and banner never reach it in a static render.
vi.mock('./registry', () => ({ acquireWebgl() {}, fitTerm() {}, getTerm: () => ({ host: null }) }))
vi.mock('./store', async () => {
  const { create } = await import('zustand')
  return {
    useGrid: create(() => ({
      ws: { focused: 0, maximized: null },
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

  it('keeps the manual button once the run stopped, or on other panes', () => {
    for (const html of [render('stopped'), render('running', 'p2')]) {
      expect(html).not.toContain('>Autopilot</span>')
      expect(html).toContain('Continue on Home</button>')
    }
  })
})

import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Account, UsageSnapshot, UsageWindow } from '@shared/types'
import { DEFAULT_SHARING } from '@shared/types'

vi.mock('@/api', () => ({ api: { platform: 'darwin', on: () => () => {} }, errorText: String }))
vi.mock('@/terminals/store', () => ({
  useGrid: Object.assign((select: (s: unknown) => unknown) => select({ ws: { panes: [] } }), { getState: () => ({}) })
}))
vi.mock('@/charts/AccountCharts', () => ({ DailyTokens: () => null, WindowHistory: () => null }))
vi.mock('@/charts/UsageOverTime', () => ({ UsageOverTime: () => null }))
vi.mock('@/charts/MostUsed', () => ({ MostUsed: () => null }))
vi.mock('@/autopilot/AutopilotCard', () => ({ AutopilotCard: () => null }))
vi.mock('@/terminals/registry', () => ({ restyleAll() {} }))
vi.mock('@/terminals/Pane', () => ({ Pane: () => null }))
vi.mock('@/terminals/Sessions', () => ({ SessionsPanel: () => null }))
const { useStore } = await import('@/store')
const { useLimitView } = await import('@/terminals/limitView')
const { Board } = await import('./Overview')
const { Accounts } = await import('./Accounts')
const { LimitSwitch: TerminalsSwitch } = await import('@/terminals/Terminals')

const NOW = Date.parse('2026-11-09T12:00:00Z')
const at = (hours: number) => new Date(NOW + hours * 3_600_000).toISOString()
const account = (id: string, label: string, status: Account['status'] = 'ok'): Account => ({
  id,
  providerId: 'claude',
  label,
  homeDir: `/test/${id}`,
  isDefaultHome: false,
  sharing: DEFAULT_SHARING,
  color: '#3987E5',
  tags: [],
  status,
  createdAt: at(0),
  launchCount: 0
})
const win = (id: string, label: string, usedPercent: number, hours?: number): UsageWindow => ({
  id,
  label,
  usedPercent,
  windowMinutes: id === 'five_hour' ? 300 : 10080,
  resetsAt: hours === undefined ? null : at(hours)
})
const snap = (accountId: string, ...windows: UsageWindow[]): UsageSnapshot => ({ accountId, providerId: 'claude', fetchedAt: at(0), source: 'api', windows })
const five = (used: number, hours = 2) => win('five_hour', '5-hour session', used, hours)
const week = (used: number, hours = 70) => win('seven_day', 'Weekly limit', used, hours)
const fable = (used: number) => win('seven_day_fable', 'Weekly Fable', used, 70)

// A mix: a spent account listed first, one that is fine, one low on its week, one out on 5 hours, one signed out.
const accounts = [
  account('spent', 'Spent One'),
  account('fine', 'Fine One'),
  account('low', 'Low One'),
  account('tired', 'Tired One'),
  account('gone', 'Gone One', 'needs-login')
]
const usage = {
  spent: snap('spent', five(0), week(100, 76), fable(100)),
  fine: snap('fine', five(36), week(40), fable(10)),
  low: snap('low', five(30), week(92)),
  tired: snap('tired', five(100, 1), week(50))
}
const seed = (view: 'five_hour' | 'seven_day' | 'seven_day_fable') => {
  Object.assign(useStore.getInitialState(), { accounts, usage, now: NOW, providers: [], refreshingIds: [], selectedId: 'fine' })
  Object.assign(useLimitView.getInitialState(), { view })
}
const board = (view: 'five_hour' | 'seven_day' | 'seven_day_fable' = 'five_hour') => {
  seed(view)
  return renderToStaticMarkup(<Board />)
}
const rowOf = (html: string, name: string) => html.split('<li ').find((r) => r.includes(`>${name}<`)) ?? ''
// The Accounts details have radio groups of their own: read only the limit switch.
const switchOf = (html: string) => html.slice(html.indexOf('aria-labelledby="limit-switch-label"')).split('</div>')[0] ?? ''
const checked = (html: string) => [...switchOf(html).matchAll(/aria-checked="true"[^>]*>([^<]+)</g)].map((m) => m[1])

describe('the account board on Start work', () => {
  it('lists the accounts that can be used first, in their order, then those that are out under one quiet heading', () => {
    const html = board()
    const order = ['Fine One', 'Low One', 'Out for now · ', 'Tired One', 'Spent One', 'Gone One'].map((t) => html.indexOf(t))
    expect(order.every((i) => i >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    expect(html).toMatch(/Out for now · (<!-- -->)?3</)
    expect(html.match(/Out for now/g)).toHaveLength(1)
  })

  it('shows an account that is out on one line: the limit that stopped it and when it is back, soonest first', () => {
    const html = board()
    expect(rowOf(html, 'Spent One')).toMatch(/Weekly limit reached · back \w{3} /)
    expect(rowOf(html, 'Tired One')).toContain('5-hour limit reached · back in 1h')
    // No gauges, and no 5-hour or Fable figure beside the spent weekly limit.
    expect(rowOf(html, 'Spent One')).not.toContain('role="meter"')
    expect(rowOf(html, 'Spent One')).not.toContain('5h')
    expect(rowOf(html, 'Spent One')).not.toContain('Fable')
    expect(html.indexOf('Tired One')).toBeLessThan(html.indexOf('Spent One'))
  })

  it('keeps Sign in for a signed-out account and gives an account that is out no primary button', () => {
    const html = board()
    expect(rowOf(html, 'Gone One')).toContain('Sign in')
    expect(rowOf(html, 'Spent One')).toContain('btn-ghost')
    expect(rowOf(html, 'Spent One')).not.toContain('btn-primary')
  })

  it('shows one labeled gauge per usable account: the limit the switch is on', () => {
    const fiveHours = rowOf(board('five_hour'), 'Fine One')
    expect(fiveHours).toContain('>5h<')
    expect(fiveHours).toContain('64% left')
    expect(fiveHours.match(/role="meter"/g)).toHaveLength(1)
    const weekly = rowOf(board('seven_day'), 'Fine One')
    expect(weekly).toContain('>Week<')
    expect(weekly).toContain('60% left')
    expect(weekly.match(/role="meter"/g)).toHaveLength(1)
  })

  it('puts the other limits in the row tooltip and marks one that is running low', () => {
    const html = rowOf(board('five_hour'), 'Low One')
    expect(html).toContain('Week 8% left')
    expect(html).toContain('data-tip="5-hour session: 70% left')
    expect(html).toContain('Weekly limit: 8% left')
    expect(rowOf(board('five_hour'), 'Fine One')).not.toContain('Week 60% left')
  })

  it('says so, quietly, when the account has no such limit', () => {
    Object.assign(useStore.getInitialState(), { usage: { ...usage, fine: snap('fine', week(40)) } })
    Object.assign(useLimitView.getInitialState(), { view: 'five_hour' })
    expect(rowOf(renderToStaticMarkup(<Board />), 'Fine One')).toContain('No 5-hour limit')
  })

  it('does not let the switch change who is out', () => {
    for (const view of ['five_hour', 'seven_day', 'seven_day_fable'] as const) {
      const html = board(view)
      expect(html).toMatch(/Out for now · (<!-- -->)?3</)
      expect(rowOf(html, 'Spent One')).toContain('Weekly limit reached')
    }
  })
})

describe('one Limits switch on Terminals, Start work and Accounts', () => {
  it('shows the same saved choice in all three places, and offers Fable when an account has that limit', () => {
    for (const view of ['five_hour', 'seven_day', 'seven_day_fable'] as const) {
      seed(view)
      const label = { five_hour: '5 hours', seven_day: 'Week', seven_day_fable: 'Fable' }[view]
      expect(checked(renderToStaticMarkup(<Board />))).toEqual([label])
      expect(checked(renderToStaticMarkup(<Accounts />))).toEqual([label])
      // Terminals offers what its panes report; here it has none, so a saved Fable choice shows as Week.
      expect(checked(renderToStaticMarkup(<TerminalsSwitch />))).toEqual([view === 'seven_day_fable' ? 'Week' : label])
    }
  })

  it('offers no Fable when no account in the list reports it', () => {
    seed('five_hour')
    Object.assign(useStore.getInitialState(), { usage: { fine: snap('fine', five(1), week(1)) } })
    const html = renderToStaticMarkup(<Board />)
    expect([...switchOf(html).matchAll(/role="radio"[^>]*>([^<]+)</g)].map((m) => m[1])).toEqual(['5 hours', 'Week'])
  })
})

describe('the Accounts list', () => {
  it('lists usable accounts with their chosen limit and keeps the ones that are out below, in a quiet block', () => {
    seed('seven_day')
    const html = renderToStaticMarkup(<Accounts />)
    expect(html).toContain('Week 60% left')
    expect(html).toMatch(/Out for now · (<!-- -->)?3</)
    expect(html.indexOf('Fine One')).toBeLessThan(html.indexOf('Out for now'))
    expect(html.indexOf('Out for now')).toBeLessThan(html.indexOf('Spent One'))
    expect(html).toContain('Weekly limit reached')
  })

  it('keeps every limit in the details of an account that is out, and says the shorter ones are not counting', () => {
    seed('five_hour')
    Object.assign(useStore.getInitialState(), { selectedId: 'spent' })
    const html = renderToStaticMarkup(<Accounts />)
    expect(html).toContain('Not counting until the weekly limit resets')
    expect(html).toMatch(/Limit reached · back in 3d 4h/)
    expect(html).not.toContain('100% left')
  })
})

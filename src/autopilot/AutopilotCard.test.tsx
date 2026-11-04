import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Account, ProviderInfo, UsageSnapshot } from '@shared/types'
import { DEFAULT_SHARING } from '@shared/types'

vi.mock('@/api', () => ({ api: { platform: 'darwin', on: () => () => {} }, errorText: String }))
// The real store runs the engine; the card only reads its state and calls its actions on click.
vi.mock('@/autopilot/store', async () => {
  const { create } = await import('zustand')
  return {
    useAutopilot: create(() => ({ phase: 'idle', run: null, log: [], init: async () => {}, start: async () => {}, stop() {}, dismiss() {}, openTerminal() {} }))
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
})

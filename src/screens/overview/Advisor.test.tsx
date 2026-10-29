import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Account, UsageSnapshot } from '@shared/types'
import { DEFAULT_SHARING } from '@shared/types'
import { nextExhaustedReset } from './availability'

vi.mock('@/api', () => ({ api: { platform: 'darwin' }, errorText: String }))
vi.mock('@/terminals/store', () => ({ useGrid: (selector: (s: { restored: boolean }) => unknown) => selector({ restored: true }) }))
const { useStore } = await import('@/store')
const { Advisor, Alternative } = await import('./Advisor')
const now = Date.parse('2026-10-29T12:00:00Z')
const account: Account = { id: 'work', providerId: 'claude', label: 'Work', homeDir: '/test', isDefaultHome: false, sharing: DEFAULT_SHARING, color: '#3987E5', tags: [], status: 'ok', createdAt: new Date(now).toISOString(), launchCount: 0 }
const snapshot = (usedPercent: number, hours: number): UsageSnapshot => ({ accountId: account.id, providerId: 'claude', source: 'api', fetchedAt: new Date(now).toISOString(), windows: [{ id: 'week', label: 'Weekly', usedPercent, resetsAt: new Date(now + hours * 3_600_000).toISOString() }] })
const rec = { accountId: 'work', score: 40, reason: 'No usage data yet.' }
const seed = (extra: Partial<ReturnType<typeof useStore.getState>> = {}) => Object.assign(useStore.getInitialState(), { accounts: [account], usage: {}, recs: [rec], recsLoading: false, recsError: null, ...extra })

describe('task advisor', () => {
  it('does not describe unknown usage as exhausted in alternatives', () => {
    seed()
    const html = renderToStaticMarkup(<Alternative account={account} rec={rec} />)
    expect(html).toContain('Usage unknown')
    expect(html).not.toContain('0% left')
  })
  it('hides a stale suggestion while a different task is being ranked', () => {
    seed({ recsLoading: true })
    const html = renderToStaticMarkup(<Advisor />)
    expect(html).toContain('Finding an account for this task')
    expect(html).not.toContain('Open workspace')
    expect(html).not.toContain('Resume last chat')
  })
  it('reports ranking failure separately from account exhaustion', () => {
    seed({ recsError: 'Offline' })
    const html = renderToStaticMarkup(<Advisor />)
    expect(html).toContain('Suggestions are unavailable')
    expect(html).not.toContain('No account is suggested right now')
  })
})

describe('exhausted reset hint', () => {
  it('ignores healthy, blocked, signed-out, and past resets', () => {
    expect(nextExhaustedReset([account], { work: snapshot(30, 1) }, now)).toBeUndefined()
    expect(nextExhaustedReset([{ ...account, status: 'blocked' }], { work: snapshot(100, 1) }, now)).toBeUndefined()
    expect(nextExhaustedReset([{ ...account, status: 'needs-login' }], { work: snapshot(100, 1) }, now)).toBeUndefined()
    expect(nextExhaustedReset([account], { work: snapshot(100, -1) }, now)).toBeUndefined()
    expect(nextExhaustedReset([account], { work: snapshot(100, 2) }, now)?.account.id).toBe('work')
  })
})

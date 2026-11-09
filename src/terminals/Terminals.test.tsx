import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { UsageSnapshot, UsageWindow } from '@shared/types'

vi.mock('@/api', () => ({ api: { platform: 'darwin', on: () => () => {} }, errorText: String }))
vi.mock('./registry', () => ({ restyleAll() {} }))
vi.mock('./Pane', () => ({ Pane: () => null }))
vi.mock('./Sessions', () => ({ SessionsPanel: () => null }))
vi.mock('./store', async () => {
  const { create } = await import('zustand')
  return { useGrid: create(() => ({ ws: { panes: [{ uid: 'p1', accountId: 'w', target: 'cli' }, { uid: 'p2', target: 'cli' }] } })) }
})
const { useStore } = await import('@/store')
const { useLimitView } = await import('./limitView')
const { LimitSwitch } = await import('./Terminals')

const windows = (...ids: string[]): UsageWindow[] => ids.map((id) => ({ id, label: id, usedPercent: 10, windowMinutes: id === 'five_hour' ? 300 : 10080 }))
const snap = (accountId: string, w: UsageWindow[]): UsageSnapshot => ({ accountId, providerId: 'claude', fetchedAt: '2026-11-09T12:00:00Z', source: 'api', windows: w })
const render = (usage: Record<string, UsageSnapshot>, view: 'five_hour' | 'seven_day' | 'seven_day_fable' = 'five_hour') => {
  Object.assign(useStore.getInitialState(), { usage })
  Object.assign(useLimitView.getInitialState(), { view })
  return renderToStaticMarkup(<LimitSwitch />)
}
const checked = (html: string) => [...html.matchAll(/aria-checked="true"[^>]*>([^<]+)</g)].map((m) => m[1])
const radios = (html: string) => [...html.matchAll(/role="radio"[^>]*>([^<]+)</g)].map((m) => m[1])

describe('the limit switch', () => {
  it('is a labeled choice between the 5-hour and the weekly limit', () => {
    const html = render({ w: snap('w', windows('five_hour', 'seven_day')) })
    expect(html).toContain('Limits</span>')
    expect(html).toContain('role="radiogroup" aria-labelledby="limit-switch-label"')
    expect(radios(html)).toEqual(['5 hours', 'Week'])
    expect(checked(html)).toEqual(['5 hours'])
    expect(html).toContain('data-tip="Show each pane&#x27;s weekly limit"')
  })

  it('offers Fable only when an account in the grid reports that limit', () => {
    const fable = snap('other', windows('five_hour', 'seven_day', 'seven_day_fable'))
    // An account that is not in a pane does not count.
    expect(radios(render({ w: snap('w', windows('five_hour', 'seven_day')), other: fable }))).toEqual(['5 hours', 'Week'])
    const html = render({ w: { ...fable, accountId: 'w' } }, 'seven_day_fable')
    expect(radios(html)).toEqual(['5 hours', 'Week', 'Fable'])
    expect(checked(html)).toEqual(['Fable'])
    expect(html).toContain('half of the weekly one')
  })

  it('shows Week as chosen while a saved Fable choice is not on offer', () => {
    expect(checked(render({ w: snap('w', windows('five_hour', 'seven_day')) }, 'seven_day_fable'))).toEqual(['Week'])
  })
})

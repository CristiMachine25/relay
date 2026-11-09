import { describe, expect, it } from 'vitest'
import type { Account, UsageSnapshot, UsageWindow } from '@shared/types'
import { DEFAULT_SHARING } from '@shared/types'
import { splitFleet } from './availability'

const NOW = Date.parse('2026-11-09T12:00:00Z')
const at = (hours: number) => new Date(NOW + hours * 3_600_000).toISOString()
const account = (id: string, status: Account['status'] = 'ok'): Account => ({
  id,
  providerId: 'claude',
  label: id,
  homeDir: '/test',
  isDefaultHome: false,
  sharing: DEFAULT_SHARING,
  color: '#3987E5',
  tags: [],
  status,
  createdAt: at(0),
  launchCount: 0
})
const win = (id: string, usedPercent: number, hours?: number, windowMinutes = id === 'five_hour' ? 300 : 10080): UsageWindow => ({
  id,
  label: id,
  usedPercent,
  windowMinutes,
  resetsAt: hours === undefined ? null : at(hours)
})
const snap = (id: string, ...windows: UsageWindow[]): UsageSnapshot => ({ accountId: id, providerId: 'claude', fetchedAt: at(0), source: 'api', windows })

describe('splitFleet', () => {
  const list = [
    account('week-late'),
    account('fine-1'),
    account('signed-out', 'needs-login'),
    account('five-hour'),
    account('blocked', 'blocked'),
    account('week-soon'),
    account('fine-2'),
    account('fable-only')
  ]
  const usage = {
    'week-late': snap('week-late', win('five_hour', 0), win('seven_day', 100, 100)),
    'fine-1': snap('fine-1', win('five_hour', 10, 3), win('seven_day', 20, 90)),
    'five-hour': snap('five-hour', win('five_hour', 100, 2), win('seven_day', 50, 90)),
    'week-soon': snap('week-soon', win('five_hour', 100, 1), win('seven_day', 100, 30)),
    'fine-2': snap('fine-2'),
    'fable-only': snap('fable-only', win('five_hour', 10, 3), win('seven_day', 20, 90), win('seven_day_fable', 100, 90))
  }
  const { ready, resting } = splitFleet(list, usage)

  it('puts the accounts that can be used first, in their given order', () => {
    expect(ready.map((a) => a.id)).toEqual(['fine-1', 'fine-2', 'fable-only'])
  })

  it('puts the accounts that are out next, the one back soonest first', () => {
    expect(resting.map((r) => r.account.id)).toEqual(['five-hour', 'week-soon', 'week-late', 'signed-out', 'blocked'])
    expect(resting.map((r) => r.kind)).toEqual(['out', 'out', 'out', 'signed-out', 'blocked'])
  })

  it('names the limit that stopped each account, the one that comes back last', () => {
    expect(resting.map((r) => r.window?.id)).toEqual(['five_hour', 'seven_day', 'seven_day', undefined, undefined])
  })

  it('sends an account whose return time is unknown after the ones that have one', () => {
    const r = splitFleet([account('a'), account('b')], { a: snap('a', win('seven_day', 100)), b: snap('b', win('seven_day', 100, 50)) })
    expect(r.resting.map((x) => x.account.id)).toEqual(['b', 'a'])
  })

  it('agrees with the rest of the app about who is out', () => {
    const r = splitFleet([account('x')], { x: snap('x', win('seven_day', 99.6, 5)) })
    expect(r.resting).toHaveLength(1)
  })
})

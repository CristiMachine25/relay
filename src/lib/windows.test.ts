import { describe, expect, it } from 'vitest'
import type { UsageWindow } from '@shared/types'
import { backText, idleBehind, shareText, sortWindows, spentWindow, windowsForList, windowsToShow } from './windows'

const w = (id: string, usedPercent: number, windowMinutes: number | null = 10080, extra: Partial<UsageWindow> = {}): UsageWindow => ({
  id,
  label: id,
  usedPercent,
  windowMinutes,
  resetsAt: null,
  ...extra
})

describe('sortWindows', () => {
  it('puts the short window first, then the longer ones, then the windows that cap one model', () => {
    const list = [w('seven_day_fable', 10), w('seven_day', 40), w('seven_day_opus', 20), w('five_hour', 5, 300)]
    expect(sortWindows(list).map((x) => x.id)).toEqual(['five_hour', 'seven_day', 'seven_day_fable', 'seven_day_opus'])
  })

  it('keeps the given order for windows that tie, and does not change the list it was given', () => {
    const list = [w('b', 1, 1440), w('a', 2, 1440)]
    expect(sortWindows(list).map((x) => x.id)).toEqual(['b', 'a'])
    const mixed = [w('seven_day', 1), w('five_hour', 1, 300)]
    sortWindows(mixed)
    expect(mixed[0]?.id).toBe('seven_day')
  })

  it('puts a window with no length after the ones that have one', () => {
    expect(sortWindows([w('x', 1, null), w('y', 1, 300)]).map((l) => l.id)).toEqual(['y', 'x'])
  })
})

describe('windowsToShow', () => {
  it('shows everything when it fits', () => {
    expect(windowsToShow([w('seven_day_fable', 1), w('five_hour', 1, 300)], 3).map((x) => x.id)).toEqual(['five_hour', 'seven_day_fable'])
  })

  it('keeps the general windows and fills what is left with the model window that has the least left', () => {
    const list = [w('five_hour', 64, 300), w('seven_day', 41), w('seven_day_opus', 77), w('seven_day_fable', 38)]
    expect(windowsToShow(list, 3).map((x) => x.id)).toEqual(['five_hour', 'seven_day', 'seven_day_opus'])
    expect(windowsToShow([...list.slice(0, 3), w('seven_day_fable', 99)], 3).map((x) => x.id)).toEqual(['five_hour', 'seven_day', 'seven_day_fable'])
  })
})

describe('shareText', () => {
  it('says half for 50 and a percent otherwise', () => {
    expect(shareText(50)).toBe('half of the weekly limit')
    expect(shareText(25)).toBe('25% of the weekly limit')
  })

  it('says nothing when the share is missing or not a share', () => {
    expect(shareText(null)).toBeNull()
    expect(shareText(undefined)).toBeNull()
    expect(shareText(0)).toBeNull()
    expect(shareText(100)).toBeNull()
  })
})

const NOW = Date.parse('2026-11-09T12:00:00Z')
const at = (hours: number) => new Date(NOW + hours * 3_600_000).toISOString()

describe('spentWindow', () => {
  it('is the general window that has run out', () => {
    const list = [w('five_hour', 0, 300), w('seven_day', 100, 10080, { resetsAt: at(76) })]
    expect(spentWindow(list)?.id).toBe('seven_day')
  })

  it('is the one that comes back last when several have run out', () => {
    const list = [w('five_hour', 100, 300, { resetsAt: at(2) }), w('seven_day', 100, 10080, { resetsAt: at(76) })]
    expect(spentWindow(list)?.id).toBe('seven_day')
    expect(spentWindow([w('seven_day', 100, 10080, { resetsAt: at(76) }), w('five_hour', 100, 300, { resetsAt: at(2) })])?.id).toBe('seven_day')
  })

  it('treats a window with no known reset as the one that comes back last', () => {
    expect(spentWindow([w('a', 100, 300, { resetsAt: at(2) }), w('b', 100, 10080)])?.id).toBe('b')
  })

  it('does not count a model window: running out of Fable leaves the account usable', () => {
    expect(spentWindow([w('five_hour', 10, 300), w('seven_day', 20), w('seven_day_fable', 100)])).toBeUndefined()
  })

  it('counts a limit within half a percent of used up, like the rest of the app', () => {
    expect(spentWindow([w('seven_day', 99.6)])?.id).toBe('seven_day')
    expect(spentWindow([w('seven_day', 99.4)])).toBeUndefined()
  })

  it('falls back to model windows only when the account has nothing else', () => {
    expect(spentWindow([w('seven_day_opus', 100)])?.id).toBe('seven_day_opus')
    expect(spentWindow([])).toBeUndefined()
  })
})

describe('windowsForList', () => {
  const list = [w('five_hour', 0, 300), w('seven_day', 100, 10080, { resetsAt: at(76) }), w('seven_day_fable', 100, 10080)]

  it('lists only the limit that stopped the account', () => {
    expect(windowsForList(list, 3).map((x) => x.id)).toEqual(['seven_day'])
  })

  it('lists the usual windows while the account can still be used', () => {
    expect(windowsForList([w('five_hour', 10, 300), w('seven_day', 20), w('seven_day_fable', 100)], 3).map((x) => x.id)).toEqual(['five_hour', 'seven_day', 'seven_day_fable'])
  })
})

describe('idleBehind', () => {
  const week = w('seven_day', 100, 10080)
  it('is true for a shorter window and for a model window of the weekly limit that has run out', () => {
    expect(idleBehind(w('five_hour', 0, 300), week)).toBe(true)
    expect(idleBehind(w('seven_day_fable', 38), week)).toBe(true)
  })

  it('is false for the spent window itself, for a window that has run out too, and for longer windows', () => {
    expect(idleBehind(week, week)).toBe(false)
    expect(idleBehind(w('five_hour', 100, 300), week)).toBe(false)
    expect(idleBehind(w('seven_day', 40), w('five_hour', 100, 300))).toBe(false)
    expect(idleBehind(w('seven_day_fable', 38), w('five_hour', 100, 300))).toBe(false)
  })

  it('is false when nothing has run out', () => {
    expect(idleBehind(w('five_hour', 0, 300), undefined)).toBe(false)
  })
})

describe('backText', () => {
  it('counts down when it is less than a day away', () => {
    expect(backText(at(2.25), NOW)).toBe('back in 2h 15m')
    expect(backText(at(0.5), NOW)).toBe('back in 30m')
  })

  it('names the day and time when it is more than a day away', () => {
    const t = Date.parse(at(76))
    const day = new Intl.DateTimeFormat('en-US', { weekday: 'short' }).format(t)
    const time = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(t)
    expect(backText(at(76), NOW)).toBe(`back ${day} ${time}`)
  })

  it('names the date when it is more than a week away', () => {
    expect(backText(at(24 * 10), NOW)).toBe('back Nov 19')
  })

  it('says so when the reset is due or unknown', () => {
    expect(backText(at(-1), NOW)).toBe('reset due')
    expect(backText(null, NOW)).toBeNull()
  })
})

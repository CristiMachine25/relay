import { describe, expect, it } from 'vitest'
import type { UsageWindow } from '@shared/types'
import { shareText, sortWindows, windowsToShow } from './windows'

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

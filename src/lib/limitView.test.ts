import { describe, expect, it } from 'vitest'
import type { UsageSnapshot, UsageWindow } from '@shared/types'
import { hiddenLimit, lowLimits, limitName, nextView, offeredViews, parseLimitView, shortLabel, shownView, viewWindow, windowsTip } from './limitView'

const NOW = Date.parse('2026-11-09T12:00:00Z')
const iso = (h: number) => new Date(NOW + h * 3_600_000).toISOString()
const snap = (windows: UsageWindow[]): UsageSnapshot => ({ accountId: 'a', providerId: 'claude', fetchedAt: iso(0), source: 'api', windows })

const claude = snap([
  { id: 'five_hour', label: '5-hour session', usedPercent: 36, windowMinutes: 300, resetsAt: iso(2) },
  { id: 'seven_day', label: 'Weekly', usedPercent: 59, windowMinutes: 10080, resetsAt: iso(80) },
  { id: 'seven_day_opus', label: 'Weekly Opus', usedPercent: 99, windowMinutes: 10080 },
  { id: 'seven_day_fable', label: 'Weekly Fable', usedPercent: 20, windowMinutes: 10080, shareOfWeekly: 50, resetsAt: iso(80) }
])
const codex = snap([
  { id: 'secondary', label: 'Weekly limit', usedPercent: 58, windowMinutes: 10080 },
  { id: 'primary', label: '5-hour session', usedPercent: 22, windowMinutes: 300 }
])
const copilot = snap([{ id: 'premium', label: 'Premium requests', usedPercent: 40, windowMinutes: 43200 }])
const gemini = snap([
  { id: 'gemini-2.5-pro', label: 'Gemini Pro daily', usedPercent: 35, windowMinutes: 1440 },
  { id: 'gemini-2.5-flash', label: 'Gemini Flash daily', usedPercent: 80, windowMinutes: 1440 }
])

describe('viewWindow', () => {
  it('shows the window with the exact id', () => {
    expect(viewWindow(claude, 'five_hour')?.id).toBe('five_hour')
    expect(viewWindow(claude, 'seven_day')?.id).toBe('seven_day')
    expect(viewWindow(claude, 'seven_day_fable')?.id).toBe('seven_day_fable')
  })

  it('maps 5 hours to the shortest general window and Week to the longest for other providers', () => {
    expect(viewWindow(codex, 'five_hour')?.id).toBe('primary')
    expect(viewWindow(codex, 'seven_day')?.id).toBe('secondary')
    expect(viewWindow(copilot, 'five_hour')?.id).toBe('premium')
    expect(viewWindow(copilot, 'seven_day')?.id).toBe('premium')
  })

  it('takes the one with the least left among windows of the same length', () => {
    expect(viewWindow(gemini, 'five_hour')?.id).toBe('gemini-2.5-flash')
    expect(viewWindow(gemini, 'seven_day')?.id).toBe('gemini-2.5-flash')
  })

  it('does not stand another window in when the account names its windows the usual way', () => {
    const onlySession = snap([{ id: 'five_hour', label: '5-hour session', usedPercent: 10, windowMinutes: 300 }])
    expect(viewWindow(onlySession, 'five_hour')?.id).toBe('five_hour')
    expect(viewWindow(onlySession, 'seven_day')).toBeUndefined()
  })

  it('never stands a model window in for a general one', () => {
    const onlyModel = snap([{ id: 'seven_day_opus', label: 'Weekly Opus', usedPercent: 10, windowMinutes: 10080 }])
    expect(viewWindow(onlyModel, 'five_hour')).toBeUndefined()
    expect(viewWindow(onlyModel, 'seven_day')).toBeUndefined()
  })

  it('has no Fable window unless the account reports one', () => {
    expect(viewWindow(codex, 'seven_day_fable')).toBeUndefined()
    expect(viewWindow(snap([]), 'five_hour')).toBeUndefined()
    expect(viewWindow(undefined, 'seven_day')).toBeUndefined()
  })
})

describe('labels', () => {
  const short = (s: UsageSnapshot) => s.windows.map(shortLabel)
  it('tags a window by what it limits', () => {
    expect(short(claude)).toEqual(['5h', 'Week', 'Weekly Opus', 'Fable'])
    expect(short(codex)).toEqual(['Week', '5h'])
    expect(short(copilot)).toEqual(['Month'])
    expect(short(gemini)).toEqual(['Day', 'Day'])
  })

  it('knows the usual windows without their length, and falls back to the label', () => {
    expect(shortLabel({ id: 'five_hour', label: '5-hour session' })).toBe('5h')
    expect(shortLabel({ id: 'seven_day', label: 'Weekly' })).toBe('Week')
    expect(shortLabel({ id: 'custom', label: 'Requests' })).toBe('Requests')
  })

  it('names the limit in words', () => {
    expect(claude.windows.map(limitName)).toEqual(['5-hour limit', 'weekly limit', 'Weekly Opus limit', 'weekly Fable limit'])
    expect(limitName(copilot.windows[0]!)).toBe('monthly limit')
    expect(limitName(gemini.windows[0]!)).toBe('daily limit')
    expect(limitName({ id: 'custom', label: 'Requests' })).toBe('Requests limit')
    expect(limitName({ id: 'custom', label: 'Weekly limit' })).toBe('Weekly limit')
  })
})

describe('the views on offer', () => {
  it('offers Fable only when an account reports that window', () => {
    expect(offeredViews([codex, undefined])).toEqual(['five_hour', 'seven_day'])
    expect(offeredViews([codex, claude])).toEqual(['five_hour', 'seven_day', 'seven_day_fable'])
  })

  it('shows the weekly limit while a saved Fable choice is not on offer', () => {
    expect(shownView('seven_day_fable', ['five_hour', 'seven_day'])).toBe('seven_day')
    expect(shownView('seven_day_fable', ['five_hour', 'seven_day', 'seven_day_fable'])).toBe('seven_day_fable')
    expect(shownView('five_hour', ['five_hour', 'seven_day'])).toBe('five_hour')
  })

  it('cycles through the views on offer', () => {
    expect(nextView('five_hour', ['five_hour', 'seven_day'])).toBe('seven_day')
    expect(nextView('seven_day', ['five_hour', 'seven_day'])).toBe('five_hour')
    expect(nextView('seven_day', ['five_hour', 'seven_day', 'seven_day_fable'])).toBe('seven_day_fable')
    expect(nextView('seven_day_fable', ['five_hour', 'seven_day', 'seven_day_fable'])).toBe('five_hour')
  })

  it('reads a saved choice, defaulting to 5 hours', () => {
    expect(parseLimitView('seven_day')).toBe('seven_day')
    expect(parseLimitView('seven_day_fable')).toBe('seven_day_fable')
    expect(parseLimitView(null)).toBe('five_hour')
    expect(parseLimitView('monthly')).toBe('five_hour')
  })
})

describe('windowsTip', () => {
  it('lists every window with what is left and when it resets', () => {
    expect(windowsTip(claude, NOW)).toBe(
      [
        '5-hour session: 64% left · resets in 2h',
        'Weekly: 41% left · resets in 3d 8h',
        'Weekly Opus: 1% left',
        'Weekly Fable (50% of the weekly limit): 80% left · resets in 3d 8h'
      ].join('\n')
    )
  })

  it('says a used-up window has reached its limit', () => {
    const out = snap([{ id: 'seven_day', label: 'Weekly', usedPercent: 100, windowMinutes: 10080, resetsAt: iso(30) }])
    expect(windowsTip(out, NOW)).toBe('Weekly: limit reached · resets in 1d 6h')
  })

  it('keeps the month of a far reset capitalized', () => {
    const month = snap([{ id: 'premium', label: 'Premium requests', usedPercent: 40, resetsAt: '2026-12-01T12:00:00Z' }])
    expect(windowsTip(month, NOW)).toBe('Premium requests: 60% left · resets Dec 1')
  })

  it('says when there is nothing to list', () => {
    expect(windowsTip(undefined, NOW)).toBe('No live limits')
    expect(windowsTip(snap([]), NOW)).toBe('No live limits')
  })
})

describe('hiddenLimit', () => {
  const week = { id: 'seven_day', label: 'Weekly', usedPercent: 100, windowMinutes: 10080 }
  const session = { id: 'five_hour', label: '5-hour session', usedPercent: 10, windowMinutes: 300 }
  const out = snap([session, week])

  it('is the used-up general window when another one is shown', () => {
    expect(hiddenLimit(out, session)?.id).toBe('seven_day')
    expect(hiddenLimit(out, undefined)?.id).toBe('seven_day')
  })

  it('is nothing when the used-up window is the one shown, or the account has room', () => {
    expect(hiddenLimit(out, week)).toBeUndefined()
    expect(hiddenLimit(claude, claude.windows[0])).toBeUndefined()
    expect(hiddenLimit(undefined, undefined)).toBeUndefined()
  })

  it('ignores a model window that ran out: the account still works', () => {
    const fableOut = snap([session, { ...week, usedPercent: 40 }, { id: 'seven_day_fable', label: 'Weekly Fable', usedPercent: 100, windowMinutes: 10080 }])
    expect(hiddenLimit(fableOut, session)).toBeUndefined()
  })
})

describe('lowLimits', () => {
  const week = (used: number) => ({ id: 'seven_day', label: 'Weekly', usedPercent: used, windowMinutes: 10080 })
  const five = (used: number) => ({ id: 'five_hour', label: '5-hour session', usedPercent: used, windowMinutes: 300 })

  it('names another limit with under 20% left, so the switch never hides a real constraint', () => {
    const s = snap([five(30), week(92)])
    expect(lowLimits(s, viewWindow(s, 'five_hour')).map((l) => l.text)).toEqual(['Week 8% left'])
  })

  it('says nothing about the limit on screen or about limits with plenty left', () => {
    const s = snap([five(90), week(40)])
    expect(lowLimits(s, viewWindow(s, 'five_hour'))).toEqual([])
    expect(lowLimits(s, viewWindow(s, 'seven_day')).map((l) => l.text)).toEqual(['5h 10% left'])
  })

  it('says when a model limit has run out, and lists the tightest first', () => {
    const s = snap([five(95), week(85), { id: 'seven_day_fable', label: 'Weekly Fable', usedPercent: 100, windowMinutes: 10080 }])
    expect(lowLimits(s, viewWindow(s, 'five_hour')).map((l) => l.text)).toEqual(['Fable limit reached', 'Week 15% left'])
  })

  it('is empty for an account with no windows', () => {
    expect(lowLimits(undefined, undefined)).toEqual([])
  })
})

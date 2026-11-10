import { describe, expect, it } from 'vitest'
import type { Account, Subscription } from '@shared/types'
import { endingSoon, subscriptionDetail, subscriptionFor, subscriptionNote, subscriptionText, subscriptionTip } from './subscription'

// Local times throughout: the billing day is the day the user sees on their own calendar.
const at = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h).getTime()
const iso = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h).toISOString()
const NOW = at(2026, 11, 9)

type Sub = Pick<Account, 'subscription' | 'renewsOn' | 'autoRenew'>
const plan = (startedAt: string | null, extra: Partial<Subscription> = {}): Subscription => ({ status: 'active', startedAt, checkedAt: iso(2026, 11, 9), ...extra })
const of = (a: Sub, now = NOW) => subscriptionFor(a, now)

describe('which day', () => {
  it('estimates the next monthly anniversary of the start day', () => {
    const s = of({ subscription: plan(iso(2026, 10, 16, 19)) })
    expect(s).toMatchObject({ day: '2026-11-16', daysLeft: 7, estimated: true, startedOn: '2026-10-16', rolledFrom: null })
  })

  it('counts an anniversary later today, and moves on once its hour has passed', () => {
    expect(of({ subscription: plan(iso(2026, 10, 9, 19)) })).toMatchObject({ day: '2026-11-09', daysLeft: 0 })
    expect(of({ subscription: plan(iso(2026, 10, 9, 8)) })).toMatchObject({ day: '2026-12-09', daysLeft: 30 })
  })

  it('clamps to the length of the month without drifting off the start day', () => {
    const started = plan(iso(2026, 8, 31))
    expect(of({ subscription: started }, at(2026, 9, 1)).day).toBe('2026-09-30')
    expect(of({ subscription: started }, at(2026, 10, 1)).day).toBe('2026-10-31')
    expect(of({ subscription: started }, at(2026, 11, 9)).day).toBe('2026-11-30')
    expect(of({ subscription: started }, at(2027, 2, 1)).day).toBe('2027-02-28')
    expect(of({ subscription: started }, at(2027, 3, 1)).day).toBe('2027-03-31')
    expect(of({ subscription: plan(iso(2027, 1, 30)) }, at(2028, 2, 1)).day).toBe('2028-02-29')
  })

  it('crosses the year end', () => {
    expect(of({ subscription: plan(iso(2026, 11, 20)) }, at(2026, 12, 25)).day).toBe('2027-01-20')
  })

  it('prefers the exact end the provider reports over the estimate', () => {
    const s = of({ subscription: plan(iso(2026, 10, 16), { endsAt: iso(2026, 11, 28) }) })
    expect(s).toMatchObject({ day: '2026-11-28', daysLeft: 19, estimated: false })
  })

  it('goes back to the estimate when the reported end has passed, unless auto-renew is off', () => {
    const subscription = plan(iso(2026, 10, 16), { endsAt: iso(2026, 11, 5) })
    expect(of({ subscription })).toMatchObject({ day: '2026-11-16', estimated: true })
    expect(of({ subscription, autoRenew: false })).toMatchObject({ state: 'ended', day: '2026-11-05', estimated: false })
  })

  it('lets a day set by hand win over everything', () => {
    const s = of({ renewsOn: '2027-10-16', subscription: plan(iso(2026, 10, 16), { endsAt: iso(2026, 11, 28) }) })
    expect(s).toMatchObject({ day: '2027-10-16', daysLeft: 341, estimated: false })
  })

  it('rolls a past day set by hand forward a month at a time, as an estimate', () => {
    expect(of({ renewsOn: '2026-08-31' })).toMatchObject({ day: '2026-11-30', estimated: true, rolledFrom: '2026-08-31', state: 'unknown-renewal' })
    expect(of({ renewsOn: '2026-10-09', autoRenew: true })).toMatchObject({ day: '2026-11-09', daysLeft: 0, estimated: true, state: 'renews' })
  })

  it('ends a plan on a past day set by hand when auto-renew is off', () => {
    expect(of({ renewsOn: '2026-11-02', autoRenew: false })).toMatchObject({ state: 'ended', day: '2026-11-02', daysLeft: -7, estimated: false, urgency: 'now' })
  })

  it('ignores a hand-set day that is not a date', () => {
    expect(of({ renewsOn: 'soon' }).state).toBe('none')
    expect(of({ renewsOn: '2026-02-31' }).state).toBe('none')
  })
})

describe('auto-renew and state', () => {
  const subscription = plan(iso(2026, 10, 16))

  it('follows what the user said about auto-renew', () => {
    expect(of({ subscription, autoRenew: true })).toMatchObject({ state: 'renews', autoRenew: true })
    expect(of({ subscription, autoRenew: false })).toMatchObject({ state: 'ends', autoRenew: false })
    expect(of({ subscription, autoRenew: null })).toMatchObject({ state: 'unknown-renewal', autoRenew: null })
    expect(of({ subscription })).toMatchObject({ state: 'unknown-renewal', autoRenew: null })
  })

  it('treats a canceled plan as not renewing, whatever was set by hand', () => {
    const s = of({ subscription: plan(iso(2026, 10, 16), { status: 'canceled' }), autoRenew: true, renewsOn: '2026-11-20' })
    expect(s).toMatchObject({ state: 'canceled', autoRenew: false, day: null, daysLeft: null, urgency: 'calm' })
  })

  it('has nothing to say without a day', () => {
    for (const a of [{}, { subscription: null }, { subscription: plan(null) }, { autoRenew: true }, { subscription: plan('not a date') }]) {
      expect(of(a)).toMatchObject({ state: 'none', day: null, daysLeft: null, estimated: false, urgency: 'calm' })
    }
  })
})

describe('urgency', () => {
  const ending = (days: number, autoRenew: boolean | null = false) => of({ renewsOn: new Date(2026, 10, 9 + days).toLocaleDateString('sv'), autoRenew }).urgency

  it('warns only about a plan that ends by itself: soon within a week, now within two days', () => {
    expect(ending(8)).toBe('calm')
    expect(ending(7)).toBe('soon')
    expect(ending(3)).toBe('soon')
    expect(ending(2)).toBe('now')
    expect(ending(0)).toBe('now')
  })

  it('stays calm when the plan renews by itself or nothing says it will end', () => {
    expect(ending(1, true)).toBe('calm')
    expect(ending(1, null)).toBe('calm')
  })
})

describe('wording', () => {
  const subscription = plan(iso(2026, 10, 16))
  const text = (a: Sub) => {
    const s = of(a)
    return [subscriptionText(s), subscriptionDetail(s)]
  }

  it('says what happens on the day and how far off it is', () => {
    expect(text({ renewsOn: '2026-11-16', autoRenew: true })).toEqual(['Renews Nov 16', 'in 7 days'])
    expect(text({ renewsOn: '2026-11-16', autoRenew: false })).toEqual(['Ends Nov 16', 'in 7 days, auto-renew off'])
    expect(text({ renewsOn: '2026-11-16' })).toEqual(['Next billing day Nov 16', 'in 7 days, auto-renew not set'])
  })

  it('marks an estimated day', () => {
    expect(text({ subscription, autoRenew: true })).toEqual(['Renews Nov 16 (est.)', 'in 7 days'])
  })

  it('uses today and tomorrow, and keeps the date in the detail', () => {
    expect(text({ renewsOn: '2026-11-09', autoRenew: false })).toEqual(['Ends today', 'Nov 9, auto-renew off'])
    expect(text({ renewsOn: '2026-11-10', autoRenew: true })).toEqual(['Renews tomorrow', 'Nov 10'])
  })

  it('adds the year to a day far off', () => {
    expect(text({ renewsOn: '2027-10-16', autoRenew: true })).toEqual(['Renews Oct 16, 2027', 'in 341 days'])
  })

  it('words a canceled, an ended and an unknown plan', () => {
    expect(text({ subscription: plan(null, { status: 'canceled' }) })).toEqual(['Subscription canceled', 'will not renew'])
    expect(text({ renewsOn: '2026-11-02', autoRenew: false })).toEqual(['Ended Nov 2', '7 days ago, auto-renew off'])
    expect(text({})).toEqual([null, 'No subscription details yet'])
  })

  it('explains where an estimate comes from', () => {
    expect(subscriptionNote(of({ subscription }))).toBe('Estimated from the day the plan started (Oct 16). Set the day by hand if it is a yearly plan.')
    expect(subscriptionNote(of({ renewsOn: '2026-10-20' }))).toBe('Estimated from the day you set (Oct 20), which has passed. Set the new day if that is wrong.')
    expect(subscriptionNote(of({ renewsOn: '2026-11-16' }))).toBeNull()
  })

  it('puts it all in one tooltip', () => {
    expect(subscriptionTip(of({ subscription, autoRenew: false }))).toBe(
      'Ends Nov 16 (est.), in 7 days, auto-renew off. Estimated from the day the plan started (Oct 16). Set the day by hand if it is a yearly plan.'
    )
    expect(subscriptionTip(of({ renewsOn: '2026-11-10', autoRenew: true }))).toBe('Renews tomorrow, Nov 10.')
    expect(subscriptionTip(of({}))).toBeNull()
  })
})

describe('plans ending within a week', () => {
  it('lists only plans that stop by themselves in the next 7 days, soonest first, with the day in words', () => {
    const accounts = [
      { id: 'later', renewsOn: '2026-11-16', autoRenew: false },
      { id: 'renews', renewsOn: '2026-11-10', autoRenew: true },
      { id: 'tomorrow', renewsOn: '2026-11-10', autoRenew: false },
      { id: 'unsaid', renewsOn: '2026-11-11' },
      { id: 'today', renewsOn: '2026-11-09', autoRenew: false },
      { id: 'far', renewsOn: '2026-11-17', autoRenew: false },
      { id: 'over', renewsOn: '2026-11-07', autoRenew: false }
    ]
    expect(endingSoon(accounts, NOW).map((e) => `${e.account.id} ${e.when}`)).toEqual(['today today', 'tomorrow tomorrow', 'later Nov 16'])
    expect(endingSoon([], NOW)).toEqual([])
  })
})

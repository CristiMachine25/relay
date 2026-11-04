import { describe, expect, it } from 'vitest'
import type { Account, UsageSnapshot, UsageWindow } from '@shared/types'
import { DEFAULT_SHARING } from '@shared/types'
import { CONTINUE_PROMPT, exhaustedUntil, limitHit, permissionArgs, pickAccount, restartPrompt, soonestReset, stripAnsi, taskArg } from './autopilot'

const acc = (id: string, extra: Partial<Account> = {}): Account => ({
  id,
  providerId: 'claude',
  label: id,
  homeDir: `/h/${id}`,
  isDefaultHome: false,
  sharing: { ...DEFAULT_SHARING },
  color: '#3987E5',
  tags: [],
  status: 'ok',
  createdAt: '2026-01-01T00:00:00Z',
  launchCount: 0,
  ...extra
})
const win = (id: string, usedPercent: number, extra: Partial<UsageWindow> = {}): UsageWindow => ({ id, label: id, usedPercent, ...extra })
const snap = (accountId: string, windows: UsageWindow[]): UsageSnapshot => ({
  accountId,
  providerId: 'claude',
  fetchedAt: '2026-10-20T10:00:00Z',
  source: 'api',
  windows
})
/** A Claude snapshot: 5-hour session and weekly window, by percent used. */
const claude = (accountId: string, session: number, weekly = 0, extra: Partial<UsageWindow> = {}) =>
  snap(accountId, [win('five_hour', session, { windowMinutes: 300, ...extra }), win('seven_day', weekly, { windowMinutes: 10080 })])

describe('limitHit', () => {
  it.each([
    "You've hit your limit · resets in 2h",
    'You’ve hit your limit · resets 3pm (Europe/Bucharest)',
    "You've hit your usage limit",
    'Claude AI usage limit reached|1730000000',
    '5-hour limit reached ∙ resets 3pm',
    'Session limit reached ∙ resets 3pm',
    'Weekly limit reached ∙ resets Mon 9am',
    'Your limit will reset at 3pm. New messages wait for your usage limit to reset.',
    '/upgrade to increase your usage limit.'
  ])('sees the drained screen: %s', (text) => {
    expect(limitHit(text)).toBe(true)
  })

  it('reads through color codes and other screen output', () => {
    expect(limitHit('\x1b[38;2;240;104;104m⎿\x1b[0m You\x1b[1m\'ve hit your\x1b[0m limit · resets in 2h\r\n\r\n> ')).toBe(true)
    expect(limitHit('line one\n  \x1b[31mWEEKLY LIMIT REACHED\x1b[39m\nline three')).toBe(true)
  })

  it('reads a message that wrapped onto the next row', () => {
    expect(limitHit("⎿ You've hit your\n limit · resets in 2h")).toBe(true)
  })

  it.each([
    "You've hit your Opus limit · resets Mon 9am",
    'Opus limit reached ∙ now using Sonnet',
    'Opus weekly limit reached ∙ resets Mon 9am',
    'Sonnet weekly limit reached ∙ resets Mon 9am',
    "You're out of extra usage · resets 1 Nov",
    'Usage credit limit reached',
    'Implemented the rate limit reached handler in src/api.ts',
    ''
  ])('ignores model-only, credit and unrelated text: %s', (text) => {
    expect(limitHit(text)).toBe(false)
  })
})

describe('stripAnsi', () => {
  it('removes CSI, OSC and charset sequences', () => {
    expect(stripAnsi('\x1b[1;31mred\x1b[0m \x1b]0;title\x07\x1b]8;;https://x.y\x1b\\link\x1b]8;;\x1b\\ \x1b(Bok\x1b[?25h')).toBe('red link ok')
  })
})

describe('pickAccount', () => {
  const opts = { providerId: 'claude' as const }

  it('picks the account with the most left on its binding window', () => {
    const accounts = [acc('a'), acc('b'), acc('c')]
    const usage = { a: claude('a', 60), b: claude('b', 10), c: claude('c', 30) }
    expect(pickAccount(accounts, usage, opts)?.id).toBe('b')
  })

  it('ranks by the binding window, not the 5-hour window alone', () => {
    // b has more session left but its weekly window is nearly gone.
    const accounts = [acc('a'), acc('b')]
    const usage = { a: claude('a', 50, 20), b: claude('b', 0, 90) }
    expect(pickAccount(accounts, usage, opts)?.id).toBe('a')
  })

  it('ignores model-only windows when ranking', () => {
    const accounts = [acc('a'), acc('b')]
    const usage = {
      a: snap('a', [win('five_hour', 40), win('seven_day_opus', 100)]),
      b: snap('b', [win('five_hour', 50)])
    }
    expect(pickAccount(accounts, usage, opts)?.id).toBe('a')
  })

  it('breaks a tie on the binding window by more left on the long window', () => {
    const accounts = [acc('a'), acc('b')]
    // Both bound by the session (70% used); a has used more of its week.
    const usage = { a: claude('a', 70, 50), b: claude('b', 70, 20) }
    expect(pickAccount(accounts, usage, opts)?.id).toBe('b')
  })

  it('then by label', () => {
    const accounts = [acc('z', { label: 'Work' }), acc('y', { label: 'Home' })]
    const usage = { z: claude('z', 30, 10), y: claude('y', 30, 10) }
    expect(pickAccount(accounts, usage, opts)?.id).toBe('y')
  })

  it('ranks accounts without usage data after ones with data, then by label', () => {
    const accounts = [acc('none', { label: 'A' }), acc('empty', { label: 'B' }), acc('low', { label: 'C' })]
    const usage = { empty: snap('empty', []), low: claude('low', 95) }
    expect(pickAccount(accounts, usage, opts)?.id).toBe('low')
    expect(pickAccount(accounts, usage, { ...opts, exclude: ['low'] })?.id).toBe('none')
  })

  it('only picks usable accounts of the provider', () => {
    const accounts = [
      acc('gpt', { providerId: 'codex' }),
      acc('out', { status: 'needs-login' }),
      acc('blk', { status: 'blocked' }),
      acc('full'),
      acc('ok')
    ]
    const usage = { gpt: claude('gpt', 0), out: claude('out', 0), blk: claude('blk', 0), full: claude('full', 100), ok: claude('ok', 80) }
    expect(pickAccount(accounts, usage, opts)?.id).toBe('ok')
    expect(pickAccount(accounts, usage, { providerId: 'codex' })?.id).toBe('gpt')
    expect(pickAccount(accounts.slice(0, 4), usage, opts)).toBeUndefined()
  })

  it('skips excluded accounts, given as an array or a set', () => {
    const accounts = [acc('a'), acc('b'), acc('c')]
    const usage = { a: claude('a', 0), b: claude('b', 10), c: claude('c', 20) }
    expect(pickAccount(accounts, usage, { ...opts, exclude: ['a'] })?.id).toBe('b')
    expect(pickAccount(accounts, usage, { ...opts, exclude: new Set(['a', 'b']) })?.id).toBe('c')
    expect(pickAccount(accounts, usage, { ...opts, exclude: ['a', 'b', 'c'] })).toBeUndefined()
  })

  it('skips accounts the caller does not accept', () => {
    const accounts = [acc('a', { sharing: { ...DEFAULT_SHARING, history: false } }), acc('b')]
    const usage = { a: claude('a', 0), b: claude('b', 50) }
    expect(pickAccount(accounts, usage, { ...opts, accept: (a) => a.sharing.history })?.id).toBe('b')
  })

  it('returns undefined for no accounts', () => {
    expect(pickAccount([], {}, opts)).toBeUndefined()
  })
})

describe('arguments', () => {
  it('asks the CLI to skip permission prompts only when told to', () => {
    expect(permissionArgs(true)).toEqual(['--permission-mode', 'bypassPermissions'])
    expect(permissionArgs(false)).toEqual([])
  })

  it('has a one-line continue prompt', () => {
    expect(CONTINUE_PROMPT).toBe(
      'Your previous session on another account stopped at a usage limit. Continue the task from exactly where you left off. Do not redo finished steps.'
    )
  })

  it('restarts a task in a new chat with what to watch out for, as one argument', () => {
    expect(restartPrompt('Fix the\nflaky test')).toBe(
      'Continue this task. An earlier session working on it stopped before it was done, so some of the work may already be done in this folder: check the current state first, then finish it. Task: Fix the\nflaky test'
    )
    expect(taskArg(restartPrompt('Fix the\nflaky test'))).toMatch(/^Continue this task\. .*Task: Fix the flaky test$/)
  })

  it('puts a task on one line', () => {
    expect(taskArg('  Fix the login bug\n\n  then run   the tests \r\n and commit  ')).toBe('Fix the login bug then run   the tests and commit')
    expect(taskArg('one\ttwo')).toBe('one\ttwo')
  })

  it('keeps a task that starts with a dash from reading as a flag', () => {
    expect(taskArg('--help me refactor')).toBe(' --help me refactor')
    expect(taskArg('  - list the todos')).toBe(' - list the todos')
  })
})

describe('exhaustedUntil', () => {
  const now = Date.parse('2026-11-04T12:00:00Z')

  it('is the binding window reset when it is ahead', () => {
    const s = claude('a', 100, 30, { resetsAt: '2026-11-04T14:00:00Z' })
    expect(exhaustedUntil(s, now)).toBe(Date.parse('2026-11-04T14:00:00Z'))
  })

  it('is an hour from now when the reset is unknown or already past', () => {
    expect(exhaustedUntil(undefined, now)).toBe(now + 60 * 60_000)
    expect(exhaustedUntil(claude('a', 100), now)).toBe(now + 60 * 60_000)
    expect(exhaustedUntil(claude('a', 100, 0, { resetsAt: '2026-11-04T11:00:00Z' }), now)).toBe(now + 60 * 60_000)
  })
})

describe('soonestReset', () => {
  const now = Date.parse('2026-11-04T12:00:00Z')
  const at = (h: number) => now + h * 3600_000
  const iso = (h: number) => new Date(at(h)).toISOString()

  it('is the earliest time an exhausted or limited account comes back', () => {
    const accounts = [acc('a'), acc('b'), acc('c')]
    const usage = { b: claude('b', 100, 0, { resetsAt: iso(2) }), c: claude('c', 100, 0, { resetsAt: iso(5) }) }
    expect(soonestReset(accounts, usage, { a: at(3) }, now)).toBe(at(2))
    expect(soonestReset(accounts, usage, { a: at(1) }, now)).toBe(at(1))
  })

  it('waits for both the exhausted mark and the usage reset of one account', () => {
    const usage = { a: claude('a', 100, 0, { resetsAt: iso(4) }) }
    expect(soonestReset([acc('a')], usage, { a: at(1) }, now)).toBe(at(4))
    expect(soonestReset([acc('a')], usage, { a: at(6) }, now)).toBe(at(6))
  })

  it('ignores past times, accounts with room and unknown resets', () => {
    const accounts = [acc('a'), acc('b'), acc('c'), acc('d')]
    const usage = {
      b: claude('b', 40, 0, { resetsAt: iso(1) }), // has room: its reset says nothing
      c: claude('c', 100), // at its limit, reset unknown
      d: claude('d', 100, 0, { resetsAt: iso(-1) })
    }
    expect(soonestReset(accounts, usage, { a: at(-2) }, now)).toBeUndefined()
    expect(soonestReset([], {}, {}, now)).toBeUndefined()
  })
})

// Pure helpers for Autopilot: runs a task in the CLI and, when the account's usage runs out mid-task, moves the
// same conversation to the account with the most left. The engine (timers, terminals, stores) lives elsewhere.
import type { Account, ProviderId, UsageSnapshot } from '@shared/types'
import { atLimit, isUsable } from './grid'
import { bindingWindow, leftOf, longWindow } from './quota'

/** Escape sequences: CSI (colors, cursor), OSC (titles, links; ended by BEL or ESC \) and two-byte ones. */
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()#*+][0-9A-Za-z]|\x1b[@-Z\\-_]/g

/** Text without terminal escape sequences. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI, '')
}

// What the CLI prints once the account's usage is gone (wording from the CLI itself and the browser mock).
const DRAINED = [
  /you've hit your (?:usage )?limit/,
  /usage limit reached/,
  /new messages wait for your usage limit to reset/,
  /\/upgrade to increase your usage limit/
]
// "Opus weekly limit reached" only caps one model: the account still works, so it is not a drain.
const WINDOW_REACHED = /(\S+ )?(?:5-hour|session|weekly) limit reached/g
const MODEL = /^(?:opus|sonnet|haiku) $/

/**
 * True when screen text shows the CLI stopped at the account's usage limit. Model-only limits (Opus, Sonnet)
 * and pay-as-you-go credits running out don't count: the account can still carry on.
 */
export function limitHit(text: string): boolean {
  // One space for any run of whitespace, so a message that wrapped onto the next row still reads as one.
  const t = stripAnsi(text).replace(/’/g, "'").replace(/\s+/g, ' ').toLowerCase()
  if (DRAINED.some((re) => re.test(t))) return true
  for (const m of t.matchAll(WINDOW_REACHED)) if (!MODEL.test(m[1] ?? '')) return true
  return false
}

/** Sent to the CLI with the resumed conversation on the next account. */
export const CONTINUE_PROMPT =
  'Your previous session on another account stopped at a usage limit. Continue the task from exactly where you left off. Do not redo finished steps.'

/**
 * A task as one CLI argument: trimmed, on one line (Windows .cmd shims can't carry newlines), and with a
 * leading space when it starts with "-" so the CLI doesn't read it as a flag.
 */
export function taskArg(text: string): string {
  const t = text.trim().replace(/[^\S\r\n]*[\r\n]\s*/g, ' ')
  return t.startsWith('-') ? ` ${t}` : t
}

/** Flags that let the CLI work without stopping at permission prompts; they override the user's setting. */
export function permissionArgs(skip: boolean): string[] {
  return skip ? ['--permission-mode', 'bypassPermissions'] : []
}

/**
 * The best account to run on: usable accounts of the provider, not excluded and accepted by `accept`, with the
 * most left on the binding window, then on the long window. Accounts without usage numbers come after those
 * with numbers; label breaks ties.
 */
export function pickAccount(
  accounts: Account[],
  usage: Record<string, UsageSnapshot>,
  opts: { providerId: ProviderId; exclude?: Iterable<string>; accept?: (a: Account) => boolean }
): Account | undefined {
  const exclude = new Set(opts.exclude ?? [])
  const rank = (a: Account) => {
    const b = bindingWindow(usage[a.id])
    const l = longWindow(usage[a.id])
    return { known: b ? 1 : 0, bind: b ? leftOf(b) : 0, long: l ? leftOf(l) : 0 }
  }
  return accounts
    .filter((a) => a.providerId === opts.providerId && !exclude.has(a.id) && isUsable(a, usage) && (opts.accept?.(a) ?? true))
    .map((a) => ({ a, r: rank(a) }))
    .sort((x, y) => y.r.known - x.r.known || y.r.bind - x.r.bind || y.r.long - x.r.long || x.a.label.localeCompare(y.a.label))[0]?.a
}

const HOUR = 60 * 60_000

/** When a drained account is expected to have room again (epoch ms): its binding window's reset, or an hour from now. */
export function exhaustedUntil(snap: UsageSnapshot | undefined, now: number): number {
  const reset = Date.parse(bindingWindow(snap)?.resetsAt ?? '')
  return reset > now ? reset : now + HOUR
}

/**
 * The earliest time (epoch ms) one of `accounts` is expected to have room again, or undefined when none has a
 * known time ahead. An account counts once both its `exhausted` mark (from `exhaustedUntil`) and, if usage shows it
 * at its limit, its binding window's reset have passed. Accounts with room now or with no known time are skipped:
 * the caller only waits when none of them can be used.
 */
export function soonestReset(
  accounts: Pick<Account, 'id'>[],
  usage: Record<string, UsageSnapshot>,
  exhausted: Record<string, number>,
  now: number
): number | undefined {
  let soonest: number | undefined
  for (const a of accounts) {
    const times: number[] = []
    const mark = exhausted[a.id]
    if (mark !== undefined && mark > now) times.push(mark)
    const snap = usage[a.id]
    const reset = Date.parse(bindingWindow(snap)?.resetsAt ?? '')
    if (atLimit(snap) && reset > now) times.push(reset)
    if (!times.length) continue
    const back = Math.max(...times)
    if (soonest === undefined || back < soonest) soonest = back
  }
  return soonest
}

// Pure helpers for Autopilot: runs a task in the CLI and, when the account's usage runs out mid-task, moves the
// same conversation to the account with the most left. The engine (timers, terminals, stores) lives elsewhere.
import type { Account, ProviderId, UsageSnapshot, UsageWindow } from '@shared/types'
import { historyShared, isUsable } from './grid'
import { bindingWindow, leftOf, longWindow } from './quota'
import type { Platform } from './platform'

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
const MODEL = /^(?:opus|sonnet|haiku|fable) $/

/**
 * True when screen text shows the CLI stopped at the account's usage limit. Model-only limits (Opus, Sonnet)
 * and pay-as-you-go credits running out don't count: the account can still carry on.
 */
export function limitHit(text: string): boolean {
  const t = normalize(text)
  if (DRAINED.some((re) => re.test(t))) return true
  for (const m of t.matchAll(WINDOW_REACHED)) if (!MODEL.test(m[1] ?? '')) return true
  return false
}

// One space for any run of whitespace, so a message that wrapped onto the next row still reads as one.
const normalize = (text: string) => stripAnsi(text).replace(/’/g, "'").replace(/\s+/g, ' ').toLowerCase()

// What the CLI prints when Fable's own allowance is gone; it then carries on with another model.
const FABLE_DRAINED = /you've reached your fable limit|fable (?:weekly )?limit reached/

/** True when screen text shows the CLI ran out of Fable (it carries on with another model unless stopped). */
export function fableLimitHit(text: string): boolean {
  return FABLE_DRAINED.test(normalize(text))
}

/** The model a run can stay on: the CLI's id for it, its name, and the usage window that caps it. */
export const FABLE = { id: 'claude-fable-5-2', name: 'Fable 5.2', window: 'seven_day_fable' } as const

/** Which model a run asks for: the account's default, or Fable only. */
export type RunModel = 'default' | 'fable'

/** Flags that ask the CLI for the run's model. */
export function modelArgs(model: RunModel | undefined): string[] {
  return model === 'fable' ? ['--model', FABLE.id] : []
}

/** The usage window a run's model is capped by, beside the general ones; none for the account's default. */
export function modelWindow(model: RunModel | undefined): string | undefined {
  return model === 'fable' ? FABLE.window : undefined
}

/**
 * The window with the least left for a run: the binding window, or `modelWindow` (the run's model's own window)
 * when that has less left. An account without that window has only its general ones to go by.
 */
export function limitingWindow(snap: UsageSnapshot | undefined, modelWindow?: string): UsageWindow | undefined {
  const b = bindingWindow(snap)
  const m = modelWindow ? snap?.windows.find((x) => x.id === modelWindow) : undefined
  return m && (!b || leftOf(m) < leftOf(b)) ? m : b
}

/** Sent to the CLI with the resumed conversation on the next account. */
export const CONTINUE_PROMPT =
  'Your previous session on another account stopped at a usage limit. Continue the task from exactly where you left off. Do not redo finished steps.'

/**
 * Starts the task over in a new chat when the old one can't be reopened (its id is unknown): resuming "the most
 * recent" chat instead could pick up someone else's. The earlier session may have done part of the work.
 */
export function restartPrompt(task: string): string {
  return `Continue this task. An earlier session working on it stopped before it was done, so some of the work may already be done in this folder: check the current state first, then finish it. Task: ${task}`
}

/**
 * A task as one CLI argument: trimmed, on one line (Windows .cmd shims can't carry newlines), with double quotes
 * turned into single ones (a .cmd shim's argument quoting has no escape for them, so they would be dropped or end
 * the argument early), and with a leading space when it starts with "-" so the CLI doesn't read it as a flag.
 */
export function taskArg(text: string): string {
  const t = text.trim().replace(/[^\S\r\n]*[\r\n]\s*/g, ' ').replace(/"/g, "'")
  return t.startsWith('-') ? ` ${t}` : t
}

/** Flags that let the CLI work without stopping at permission prompts; they override the user's setting. */
export function permissionArgs(skip: boolean): string[] {
  return skip ? ['--permission-mode', 'bypassPermissions'] : []
}

/**
 * The best account to run on: usable accounts of the provider, not excluded and accepted by `accept`, with the
 * most left on the binding window, then on the long window. Accounts without usage numbers come after those
 * with numbers; label breaks ties. With `modelWindow` the model's own window counts too (`limitingWindow`): an
 * account at its limit is left out, and one that doesn't report that window comes after those that do.
 */
export function pickAccount(
  accounts: Account[],
  usage: Record<string, UsageSnapshot>,
  opts: { providerId: ProviderId; exclude?: Iterable<string>; accept?: (a: Account) => boolean; modelWindow?: string }
): Account | undefined {
  const exclude = new Set(opts.exclude ?? [])
  const mw = opts.modelWindow
  const rank = (a: Account) => {
    const snap = usage[a.id]
    const b = limitingWindow(snap, mw)
    const l = longWindow(snap)
    const m = !!mw && !!snap?.windows.some((x) => x.id === mw)
    return { known: (b ? 1 : 0) + (m ? 1 : 0), bind: b ? leftOf(b) : 0, long: l ? leftOf(l) : 0 }
  }
  return accounts
    .filter((a) => a.providerId === opts.providerId && !exclude.has(a.id) && isUsable(a, usage, mw) && (opts.accept?.(a) ?? true))
    .map((a) => ({ a, r: rank(a) }))
    .sort((x, y) => y.r.known - x.r.known || y.r.bind - x.r.bind || y.r.long - x.r.long || x.a.label.localeCompare(y.a.label))[0]?.a
}

const HOUR = 60 * 60_000

/**
 * When a drained account is expected to have room again (epoch ms): its binding window's reset, or an hour from
 * now. When it ran out of a model (`modelWindow`, e.g. Fable), that window's reset instead.
 */
export function exhaustedUntil(snap: UsageSnapshot | undefined, now: number, modelWindow?: string): number {
  const w = modelWindow ? snap?.windows.find((x) => x.id === modelWindow) : bindingWindow(snap)
  const reset = Date.parse(w?.resetsAt ?? '')
  return reset > now ? reset : now + HOUR
}

/**
 * The first of `accounts` expected to have room again, when (epoch ms), and the window whose reset that is (none
 * when only the `exhausted` mark knows); undefined when none has a known time ahead. An account counts once both
 * its `exhausted` mark (from `exhaustedUntil`) and the reset of each window usage shows it at the limit of (the
 * binding one, and `modelWindow` when given) have passed. Accounts with room now or with no known time are
 * skipped: the caller only waits when none of them can be used.
 */
export function nextBack<A extends Pick<Account, 'id'>>(
  accounts: A[],
  usage: Record<string, UsageSnapshot>,
  exhausted: Record<string, number>,
  now: number,
  modelWindow?: string
): { account: A; at: number; window?: UsageWindow } | undefined {
  let soonest: { account: A; at: number; window?: UsageWindow } | undefined
  for (const a of accounts) {
    const times: number[] = []
    const mark = exhausted[a.id]
    if (mark !== undefined && mark > now) times.push(mark)
    const snap = usage[a.id]
    const windows = [bindingWindow(snap), modelWindow ? snap?.windows.find((x) => x.id === modelWindow) : undefined]
    for (const w of windows) {
      const reset = Date.parse(w?.resetsAt ?? '')
      if (w && leftOf(w) <= 0.5 && reset > now) times.push(reset)
    }
    if (!times.length) continue
    const at = Math.max(...times)
    if (!soonest || at < soonest.at) soonest = { account: a, at, window: windows.find((w) => !!w && Date.parse(w.resetsAt ?? '') === at) }
  }
  return soonest
}

/** When the first of `accounts` is expected to have room again (see `nextBack`). */
export function soonestReset(
  accounts: Pick<Account, 'id'>[],
  usage: Record<string, UsageSnapshot>,
  exhausted: Record<string, number>,
  now: number,
  modelWindow?: string
): number | undefined {
  return nextBack(accounts, usage, exhausted, now, modelWindow)?.at
}

/**
 * The account a run continues on: the most left, not drained during this run (`exhausted`: id → epoch ms it is
 * back), and able to open the chat's history. `others` leaves out the current account (to say who is next); the
 * engine keeps it, since a resume on the same account after a reset is fine.
 */
export function nextAccount(
  run: { accountId: string; exhausted: Record<string, number> },
  accounts: Account[],
  usage: Record<string, UsageSnapshot>,
  opts: { now: number; defaultHome: string | undefined; platform: Platform; others?: boolean; modelWindow?: string }
): Account | undefined {
  const current = accounts.find((a) => a.id === run.accountId)
  if (!current) return undefined
  const out = Object.keys(run.exhausted).filter((id) => run.exhausted[id]! > opts.now)
  return pickAccount(accounts, usage, {
    providerId: 'claude',
    exclude: opts.others ? [...out, current.id] : out,
    accept: (a) => a.id === current.id || historyShared(current, a, opts.defaultHome, opts.platform),
    modelWindow: opts.modelWindow
  })
}

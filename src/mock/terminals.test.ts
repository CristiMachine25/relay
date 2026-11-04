import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Account, UsageSnapshot } from '@shared/types'
import { DEFAULT_SHARING } from '@shared/types'
import { createMockTerminals } from './terminals'

const account: Account = {
  id: 'a1',
  providerId: 'claude',
  label: 'Work',
  homeDir: '/h/a1',
  isDefaultHome: false,
  sharing: { ...DEFAULT_SHARING },
  color: '#D97757',
  tags: [],
  status: 'ok',
  createdAt: '2026-01-01T00:00:00Z',
  launchCount: 0
}

function setup() {
  const output: string[] = []
  const usage: Record<string, UsageSnapshot> = {
    a1: { accountId: 'a1', providerId: 'claude', fetchedAt: '', source: 'api', windows: [{ id: 'five_hour', label: '5-hour session', usedPercent: 20 }] }
  }
  const terminals = createMockTerminals({
    account: (id) => (id === account.id ? account : undefined),
    provider: () => undefined,
    defaultCwd: () => '/work',
    usage: () => usage,
    emit: (event, payload) => {
      if (event === 'terminal-output') output.push((payload as { data: string }).data)
    },
    notify: () => {}
  })
  // Screen text without colors.
  const screen = () => output.join('').replace(/\x1b\[[0-9;]*m/g, '')
  return { terminals, usage, screen }
}

async function spawned<T>(p: Promise<T>): Promise<T> {
  await vi.advanceTimersByTimeAsync(180)
  const info = await p
  await vi.advanceTimersByTimeAsync(100)
  return info
}

describe('mock terminals', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('shows the prompt it was started with as typed, and its flags in the command line', async () => {
    const { terminals, screen } = setup()
    const info = await spawned(
      terminals.spawn({ accountId: 'a1', target: 'cli', extraArgs: ['--permission-mode', 'bypassPermissions', 'Fix the login bug'], cols: 80, rows: 24 })
    )
    expect(info.commandLine).toBe('claude --permission-mode bypassPermissions "Fix the login bug"')
    expect(screen()).toContain('> Fix the login bug\r\n')
    expect(screen()).toContain('Working on it…')
  })

  it('continues a resumed conversation with the prompt it was given', async () => {
    const { terminals, screen } = setup()
    const info = await spawned(terminals.spawn({ accountId: 'a1', target: 'cli', resume: true, extraArgs: ['Continue the task.'], cols: 80, rows: 24 }))
    expect(info.commandLine).toBe('claude --continue "Continue the task."')
    expect(screen()).toMatch(/Resuming the most recent conversation[\s\S]*> Continue the task\.\r\n/)
  })

  it('shows no prompt when only flags were passed', async () => {
    const { terminals, screen } = setup()
    const info = await spawned(terminals.spawn({ accountId: 'a1', target: 'cli', extraArgs: ['--permission-mode', 'bypassPermissions'], cols: 80, rows: 24 }))
    expect(info.commandLine).toBe('claude --permission-mode bypassPermissions')
    expect(screen()).not.toContain('Working on it')
    expect(screen()).not.toContain('bypassPermissions')
  })

  it('starts without a prompt as before', async () => {
    const { terminals, screen } = setup()
    const info = await spawned(terminals.spawn({ accountId: 'a1', target: 'cli', cols: 80, rows: 24 }))
    expect(info.commandLine).toBe('claude')
    expect(screen()).not.toContain('Working on it')
  })

  it('still simulates a usage limit with /limit', async () => {
    const { terminals, usage, screen } = setup()
    const info = await spawned(terminals.spawn({ accountId: 'a1', target: 'cli', extraArgs: ['task'], cols: 80, rows: 24 }))
    await terminals.write(info.id, '/limit\r')
    expect(screen()).toContain("You've hit your limit · resets in 2h")
    expect(usage.a1!.windows[0]!.usedPercent).toBe(100)
  })
})

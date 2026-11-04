// Autopilot: runs one task in Claude Code on the account with the most left and, when that account's usage
// runs out mid-task, moves the same conversation to the next account by itself. Built for someone away from
// the keyboard. Pure decisions live in @/lib/autopilot; this store owns the run, its timers and the terminal.
import { create } from 'zustand'

export type AutopilotPhase = 'idle' | 'starting' | 'running' | 'handing-off' | 'waiting' | 'stopped'

export type AutopilotLogKind = 'start' | 'handoff' | 'waiting' | 'resumed' | 'false-alarm' | 'exit' | 'stopped' | 'error'

export interface AutopilotLogEntry {
  /** Epoch ms. */
  t: number
  kind: AutopilotLogKind
  text: string
}

export interface AutopilotRun {
  id: string
  task: string
  cwd?: string
  skipPermissions: boolean
  providerId: 'claude'
  /** The account the run's terminal is on now. */
  accountId: string
  /** Grid pane and session the run owns. */
  paneUid: string
  sessionId: string
  startedAt: number
  handoffs: number
  /** Account id → epoch ms it is expected back after running out during this run. */
  exhausted: Record<string, number>
  /** While waiting: epoch ms the next account is expected to have room. */
  waitingUntil?: number
  /** Why the run stopped on its own. */
  error?: string
}

export interface AutopilotStartInput {
  task: string
  cwd?: string
  skipPermissions: boolean
}

interface AutopilotState {
  phase: AutopilotPhase
  run: AutopilotRun | null
  /** Newest first, at most 50. */
  log: AutopilotLogEntry[]
  /** Restore a saved run and start watching. Safe to call more than once. */
  init(): Promise<void>
  start(input: AutopilotStartInput): Promise<void>
  /** Stop watching; the terminal keeps running. */
  stop(): void
  /** Forget a stopped run and its log, back to idle. */
  dismiss(): void
  /** Show the run's pane in the terminal grid. */
  openTerminal(): void
}

export const useAutopilot = create<AutopilotState>(() => ({
  phase: 'idle',
  run: null,
  log: [],
  async init() {},
  async start() {},
  stop() {},
  dismiss() {},
  openTerminal() {}
}))

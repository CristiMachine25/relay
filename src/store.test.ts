import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppSettings } from '@shared/types'

const remove = vi.fn<(id: string, opts: { deleteHome: boolean }) => Promise<boolean>>()
const refreshes: { id?: string; resolve: () => void; reject: (e: Error) => void }[] = []
const sets: { resolve: (s: AppSettings) => void; reject: (e: Error) => void }[] = []
vi.mock('./api', () => ({
  api: {
    accounts: { remove },
    recommend: async () => [],
    usage: {
      refresh: (id?: string) =>
        new Promise((resolve, reject) => refreshes.push({ id, resolve: () => resolve({}), reject }))
    },
    settings: { set: () => new Promise((resolve, reject) => sets.push({ resolve, reject })) }
  },
  errorText: (e: unknown) => (e instanceof Error ? e.message : String(e))
}))

const { useStore } = await import('./store')

describe('removing an account', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    useStore.setState({ toasts: [], accounts: [{ id: 'a', label: 'Work' } as never] })
  })

  it('says the folder was deleted only when the backend deleted it', async () => {
    remove.mockResolvedValueOnce(true)
    await useStore.getState().removeAccount('a', true)
    expect(useStore.getState().toasts.at(-1)?.body).toBe('Its profile folder was deleted too.')
  })

  it('says the folder was kept when the backend declined to delete it', async () => {
    remove.mockResolvedValueOnce(false)
    await useStore.getState().removeAccount('a', true)
    expect(useStore.getState().toasts.at(-1)?.body).toMatch(/^Its folder was left on disk/)
  })
})

describe('saveSettings', () => {
  beforeEach(() => {
    sets.length = 0
  })

  it("doesn't roll back a newer save when an older one fails", async () => {
    useStore.setState({ settings: { pollIntervalMinutes: 5 } as AppSettings })
    const first = useStore.getState().saveSettings({ pollIntervalMinutes: 10 })
    const second = useStore.getState().saveSettings({ pollIntervalMinutes: 15 })
    sets[1]!.resolve({ pollIntervalMinutes: 15 } as AppSettings)
    await second
    sets[0]!.reject(new Error('disk full'))
    await first
    expect(useStore.getState().settings?.pollIntervalMinutes).toBe(15)
    expect(useStore.getState().toasts.at(-1)?.title).toBe("Couldn't save settings")
  })

  it('rolls back when the latest save fails', async () => {
    useStore.setState({ settings: { pollIntervalMinutes: 5 } as AppSettings })
    const save = useStore.getState().saveSettings({ pollIntervalMinutes: 30 })
    expect(useStore.getState().settings?.pollIntervalMinutes).toBe(30)
    sets[0]!.reject(new Error('nope'))
    await save
    expect(useStore.getState().settings?.pollIntervalMinutes).toBe(5)
  })
})

describe('refresh', () => {
  beforeEach(() => {
    refreshes.length = 0
    useStore.setState({ toasts: [], refreshing: false, refreshingIds: [], accounts: [{ id: 'a' }, { id: 'b' }] as never })
  })

  it('marks only the account being checked, and clears it when the check ends', async () => {
    const done = useStore.getState().refresh('a')
    expect(useStore.getState().refreshing).toBe(true)
    expect(useStore.getState().refreshingIds).toEqual(['a'])
    refreshes[0]!.resolve()
    await done
    expect(useStore.getState().refreshing).toBe(false)
    expect(useStore.getState().refreshingIds).toEqual([])
  })

  it('marks every account when all are checked, and clears them when the check fails', async () => {
    const done = useStore.getState().refresh()
    expect(useStore.getState().refreshingIds).toEqual(['a', 'b'])
    refreshes[0]!.reject(new Error('offline'))
    await done
    expect(useStore.getState().refreshingIds).toEqual([])
    expect(useStore.getState().refreshing).toBe(false)
    expect(useStore.getState().toasts.at(-1)?.title).toBe("Couldn't refresh usage")
  })

  it('stays busy until the last of two overlapping checks ends', async () => {
    const first = useStore.getState().refresh('a')
    const second = useStore.getState().refresh('b')
    refreshes[0]!.resolve()
    await first
    expect(useStore.getState().refreshing).toBe(true)
    expect(useStore.getState().refreshingIds).toEqual(['b'])
    refreshes[1]!.resolve()
    await second
    expect(useStore.getState().refreshing).toBe(false)
  })
})

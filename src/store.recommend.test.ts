import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Recommendation } from '@shared/types'

const pending: { resolve: (value: Recommendation[]) => void; reject: (error: Error) => void }[] = []
vi.mock('./api', () => ({
  api: { recommend: () => new Promise<Recommendation[]>((resolve, reject) => pending.push({ resolve, reject })) },
  errorText: String
}))
const { useStore } = await import('./store')
const result = (id: string): Recommendation[] => [{ accountId: id, score: 50, reason: 'Available' }]

beforeEach(() => {
  pending.length = 0
  useStore.setState({ task: 'coding', recs: [] })
})

describe('recommendation lifecycle', () => {
  it('keeps the newest response when same-task refreshes resolve out of order', async () => {
    const first = useStore.getState().loadRecs()
    const second = useStore.getState().loadRecs()
    pending[1]!.resolve(result('new'))
    await second
    pending[0]!.resolve(result('old'))
    await first
    expect(useStore.getState().recs).toEqual(result('new'))
  })

  it('clears obsolete suggestions and exposes failure and retry state', async () => {
    useStore.setState({ recs: result('old') })
    const failed = useStore.getState().loadRecs()
    expect(useStore.getState().recsLoading).toBe(true)
    expect(useStore.getState().recs).toEqual([])
    pending[0]!.reject(new Error('offline'))
    await failed
    expect(useStore.getState().recsLoading).toBe(false)
    expect(useStore.getState().recsError).toBeTruthy()
    const retry = useStore.getState().loadRecs()
    expect(useStore.getState().recsError).toBeNull()
    pending[1]!.resolve(result('retry'))
    await retry
    expect(useStore.getState().recs).toEqual(result('retry'))
    expect(useStore.getState().recsLoading).toBe(false)
  })

  it('ignores errors from a superseded request', async () => {
    const first = useStore.getState().loadRecs()
    const second = useStore.getState().loadRecs()
    pending[1]!.resolve(result('new'))
    await second
    pending[0]!.reject(new Error('old failure'))
    await first
    expect(useStore.getState().recs).toEqual(result('new'))
    expect(useStore.getState().recsError).toBeNull()
  })
})

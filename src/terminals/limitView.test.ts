import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/store', () => ({ useStore: () => ({}) }))
vi.mock('./store', () => ({ useGrid: () => [] }))

const saved = new Map<string, string>()
const storage = { getItem: (k: string) => saved.get(k) ?? null, setItem: (k: string, v: string) => void saved.set(k, v) }
const load = async () => {
  vi.resetModules()
  return (await import('./limitView')).useLimitView
}

beforeEach(() => {
  saved.clear()
  vi.stubGlobal('localStorage', storage)
})

describe('the limit the panes show', () => {
  it('starts on the 5-hour limit', async () => {
    expect((await load()).getState().view).toBe('five_hour')
  })

  it('is remembered across restarts', async () => {
    ;(await load()).getState().setView('seven_day')
    expect((await load()).getState().view).toBe('seven_day')
  })

  it('ignores a saved value it does not know', async () => {
    saved.set('switchyard.limitView', 'monthly')
    expect((await load()).getState().view).toBe('five_hour')
  })

  it('still works when storage is unavailable', async () => {
    vi.stubGlobal('localStorage', {
      getItem() {
        throw new Error('denied')
      },
      setItem() {
        throw new Error('denied')
      }
    })
    const store = await load()
    expect(store.getState().view).toBe('five_hour')
    store.getState().setView('seven_day')
    expect(store.getState().view).toBe('seven_day')
  })

  it('moves to the next view on offer', async () => {
    const store = await load()
    store.getState().cycle(['five_hour', 'seven_day'])
    expect(store.getState().view).toBe('seven_day')
    store.getState().cycle(['five_hour', 'seven_day'])
    expect(store.getState().view).toBe('five_hour')
    // A saved Fable choice shows as the weekly limit while no pane has a Fable one, so the next is 5 hours.
    store.getState().setView('seven_day_fable')
    store.getState().cycle(['five_hour', 'seven_day'])
    expect(store.getState().view).toBe('five_hour')
  })
})

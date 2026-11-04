import { afterEach, describe, expect, it, vi } from 'vitest'

const handlers: Record<string, (p: never) => void> = {}
const writes = vi.hoisted(() => vi.fn(() => Promise.resolve()))
const resizes = vi.hoisted(() => vi.fn((_id: string, _cols: number, _rows: number) => Promise.resolve()))
vi.mock('@/api', () => ({
  api: { platform: 'darwin', on: (event: string, cb: (p: never) => void) => (handlers[event] = cb), terminals: { write: writes, resize: resizes } }
}))
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    written: string[] = []
    parsed: (() => void)[] = []
    input: (d: string) => void = () => {}
    cols = 80
    rows = 24
    constructor(opts?: { cols?: number; rows?: number }) {
      if (opts?.cols) this.cols = opts.cols
      if (opts?.rows) this.rows = opts.rows
    }
    canvases: unknown[] = []
    /** Rows of the active buffer, scrollback first; `wrapped` continues the row above. */
    screen: { text: string; wrapped?: boolean }[] = []
    get buffer() {
      const rows = this.screen
      const line = (r: { text: string; wrapped?: boolean }) => ({ isWrapped: !!r.wrapped, translateToString: (trim?: boolean) => (trim ? r.text.trimEnd() : r.text) })
      return { active: { length: rows.length, getLine: (i: number) => (rows[i] ? line(rows[i]) : undefined) } }
    }
    element = { querySelectorAll: () => this.canvases }
    // Like xterm: an addon is registered, then activated; activate may throw.
    loadAddon(addon: { activate?: (t: unknown) => void }) {
      addon.activate?.(this)
    }
    attachCustomKeyEventHandler() {}
    onData(cb: (d: string) => void) {
      this.input = cb
    }
    open() {}
    dispose() {}
    /** Like xterm's markers: on the cursor's row (the last one here), following it as rows are trimmed off the top. */
    markers: { line: number }[] = []
    registerMarker(offset = 0) {
      const m = { line: this.screen.length - 1 + offset }
      this.markers.push(m)
      return m
    }
    trim(n: number) {
      this.screen.splice(0, n)
      for (const m of this.markers) m.line = m.line - n < 0 ? -1 : m.line - n
    }
    write(d: string, cb?: () => void) {
      this.written.push(d)
      if (cb) this.parsed.push(cb)
    }
  }
}))
/** Columns the next fit proposes; the DOM and WebGL renderers measure cells differently. */
const fitTo = vi.hoisted(() => ({ cols: 0 }))
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    term?: { cols: number }
    activate(term: { cols: number }) {
      this.term = term
    }
    fit() {
      if (fitTo.cols && this.term) this.term.cols = fitTo.cols
    }
  }
}))
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }))
/** 'early': activate fails before touching the DOM; 'late': it fails after adding its canvas. */
const webgl = vi.hoisted(() => ({ throws: '' as '' | 'early' | 'late', last: undefined as unknown }))
vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: class {
    lost = () => {}
    disposed = false
    /** Whether WEBGL_lose_context.loseContext() ran on this addon's canvas, and if the addon was disposed by then. */
    freed?: { afterDispose: boolean }
    term?: { canvases: unknown[] }
    active = false
    canvas = {
      remove: () => this.term?.canvases.splice(this.term.canvases.indexOf(this.canvas), 1),
      getContext: (type: string) =>
        type === 'webgl2'
          ? { getExtension: (name: string) => (name === 'WEBGL_lose_context' ? { loseContext: () => (this.freed = { afterDispose: this.disposed }) } : null) }
          : null
    }
    constructor() {
      webgl.last = this
    }
    // The real addon reports a missing WebGL2 context from activate, which loadAddon calls.
    activate(term: { canvases: unknown[] }) {
      if (webgl.throws === 'early') throw new Error('WebGL2 not supported')
      this.term = term
      term.canvases.push(this.canvas)
      if (webgl.throws === 'late') throw new Error('could not compile shader')
      this.active = true
    }
    onContextLoss(cb: () => void) {
      this.lost = cb
      return { dispose() {} }
    }
    dispose() {
      this.disposed = true
      // Like the real addon, only a renderer that finished constructing removes its canvas.
      if (this.active) this.canvas.remove()
    }
    clearTextureAtlas() {}
  }
}))
vi.mock('@xterm/xterm/css/xterm.css', () => ({}))
vi.stubGlobal('document', { createElement: () => ({ isConnected: false, clientWidth: 960, clientHeight: 620, remove() {} }), documentElement: {} })
vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
/** The listener for the current pixel ratio's media query. */
const dpr = vi.hoisted(() => ({ change: undefined as undefined | (() => void) }))
vi.stubGlobal('devicePixelRatio', 2)
vi.stubGlobal('matchMedia', () => ({ addEventListener: (_type: string, cb: () => void) => (dpr.change = cb) }))
vi.stubGlobal('requestAnimationFrame', (cb: () => void) => cb())

const { MAX_WEBGL, acquireWebgl, disposeTerm, getTerm, markEnd, prepare, tailText } = await import('./registry')
const { api } = await import('@/api')
const output = (id: string, data: string) => handlers['terminal-output']!({ id, data } as never)
const written = (id: string) => (getTerm(id, 'dark').term as unknown as { written: string[] }).written

interface FakeAddon {
  lost(): void
  disposed: boolean
  freed?: { afterDispose: boolean }
}
const addonOf = (id: string) => getTerm(id, 'dark').webgl as unknown as FakeAddon | undefined
/** Creates a terminal, puts its host on screen as a pane would, and asks for WebGL. */
function show(id: string) {
  const e = getTerm(id, 'dark')
  ;(e.host as { isConnected: boolean }).isConnected = true
  acquireWebgl(id)
  return e
}
const hide = (id: string) => ((getTerm(id, 'dark').host as { isConnected: boolean }).isConnected = false)

describe('terminal output buffering', () => {
  it('replays output that arrived before the terminal was created', () => {
    prepare()
    output('early', 'hello')
    expect(written('early')).toEqual(['hello'])
  })

  it('drops output that arrives after the terminal was disposed', () => {
    prepare()
    disposeTerm('closed')
    output('closed', 'trailing chunk')
    expect(written('closed')).toEqual([])
  })
})

describe('terminal size', () => {
  it('starts at the size its process was spawned with, so an off-screen terminal reads the screen the CLI drew', () => {
    const e = getTerm('sized', 'dark', undefined, { cols: 100, rows: 30 })
    expect([e.term.cols, e.term.rows, e.cols, e.rows]).toEqual([100, 30, 100, 30])
    disposeTerm('sized')
  })
})

describe('tailText', () => {
  const screen = (id: string, rows: { text: string; wrapped?: boolean }[]) => ((getTerm(id, 'dark').term as unknown as { screen: typeof rows }).screen = rows)

  it('is empty for a terminal that does not exist', () => {
    expect(tailText('nobody')).toBe('')
  })

  it('reads the last lines of the buffer, without the blank rows below the output', () => {
    screen('tail', [...Array.from({ length: 50 }, (_, i) => ({ text: `line ${i}   ` })), { text: '' }, { text: '   ' }])
    expect(tailText('tail', 3)).toBe('line 47\nline 48\nline 49')
    expect(tailText('tail').split('\n')).toHaveLength(40)
    disposeTerm('tail')
  })

  it('reads only the rows after a mark, even once older rows were trimmed off the top', () => {
    const rows = screen('mark', [{ text: "⎿ You've hit your limit · resets 2pm" }, { text: '> continue' }])
    const mark = markEnd('mark')!
    expect(tailText('mark', 40, mark.line + 1)).toBe('')
    rows.push({ text: 'Working on it' }, { text: 'Done with ' }, { text: 'step 1', wrapped: true })
    expect(tailText('mark', 40, mark.line + 1)).toBe('Working on it\nDone with step 1')
    ;(getTerm('mark', 'dark').term as unknown as { trim(n: number): void }).trim(1)
    expect(tailText('mark', 40, mark.line + 1)).toBe('Working on it\nDone with step 1')
    expect(tailText('mark', 2, mark.line + 1)).toBe('Done with step 1')
    // Once the marked row itself is gone (line -1), every row left came after it.
    ;(getTerm('mark', 'dark').term as unknown as { trim(n: number): void }).trim(1)
    expect(mark.line).toBe(-1)
    expect(tailText('mark', 40, mark.line + 1)).toBe('Working on it\nDone with step 1')
    disposeTerm('mark')
  })

  it('has no mark for a terminal that does not exist', () => {
    expect(markEnd('nobody')).toBeUndefined()
  })

  it('joins a row that wrapped onto the next one back into one line', () => {
    screen('wrap', [{ text: 'prompt' }, { text: "⎿ You've hit your " }, { text: 'limit · resets in 2h', wrapped: true }])
    expect(tailText('wrap')).toBe("prompt\n⎿ You've hit your limit · resets in 2h")
    disposeTerm('wrap')
  })
})

describe('restored scrollback', () => {
  it('does not send replies to queries in the replayed scrollback, but sends typing after it', async () => {
    const term = getTerm('restored', 'dark', 'old\x1b[6n').term as unknown as { input: (d: string) => void; parsed: (() => void)[] }
    term.input('\x1b[1;1R') // xterm answering the stale query while it parses the seed
    expect(writes).not.toHaveBeenCalled()
    for (const done of term.parsed) done()
    term.input('x')
    await Promise.resolve()
    expect(writes).toHaveBeenCalledWith('restored', 'x')
    expect(writes).toHaveBeenCalledTimes(1)
  })
})

describe('WebGL renderer', () => {
  const ids: string[] = []
  const shown = (id: string) => {
    ids.push(id)
    return show(id)
  }
  afterEach(() => {
    webgl.throws = ''
    fitTo.cols = 0
    for (const id of ids.splice(0)) disposeTerm(id)
  })

  it('keeps the DOM renderer when the addon fails to activate, and unregisters it', () => {
    webgl.throws = 'early'
    expect(() => shown('no-gl')).not.toThrow()
    expect(addonOf('no-gl')).toBeUndefined()
    expect((webgl.last as FakeAddon).disposed).toBe(true)
  })

  it('removes a canvas the failed addon left over the DOM renderer', () => {
    webgl.throws = 'late'
    const term = shown('half-gl').term as unknown as { canvases: unknown[] }
    expect(addonOf('half-gl')).toBeUndefined()
    expect(term.canvases).toEqual([])
  })

  it('keeps the DOM renderer on Linux', () => {
    api.platform = 'linux'
    try {
      shown('linux')
      expect(addonOf('linux')).toBeUndefined()
    } finally {
      api.platform = 'darwin'
    }
  })

  it('renders at most MAX_WEBGL terminals with WebGL', () => {
    for (let i = 0; i <= MAX_WEBGL; i++) shown(`cap-${i}`)
    expect(ids.filter((id) => addonOf(id)).length).toBe(MAX_WEBGL)
    expect(addonOf(`cap-${MAX_WEBGL}`)).toBeUndefined()
  })

  it('moves WebGL from a terminal that is off screen to one being shown', () => {
    for (let i = 0; i < MAX_WEBGL; i++) shown(`move-${i}`)
    const hidden = addonOf('move-0')!
    hide('move-0')
    shown('move-new')
    expect(hidden.disposed).toBe(true)
    expect(hidden.freed).toEqual({ afterDispose: true })
    expect(addonOf('move-0')).toBeUndefined()
    expect(addonOf('move-new')).toBeDefined()
  })

  it('leaves an off-screen terminal its WebGL when the one being shown cannot load it', () => {
    for (let i = 0; i < MAX_WEBGL; i++) shown(`keep-${i}`)
    const hidden = addonOf('keep-0')!
    hide('keep-0')
    webgl.throws = 'early'
    shown('keep-new')
    expect(addonOf('keep-new')).toBeUndefined()
    expect(hidden.disposed).toBe(false)
    expect(addonOf('keep-0')).toBe(hidden)
  })

  it('falls back to the DOM renderer when the context is lost, and retries once on the next show', () => {
    shown('lost')
    const addon = addonOf('lost')!
    addon.lost()
    expect(addon.disposed).toBe(true)
    expect(addonOf('lost')).toBeUndefined()
    acquireWebgl('lost')
    const retry = addonOf('lost')!
    expect(retry).toBeDefined()
    expect(retry).not.toBe(addon)
    // A second loss means WebGL is not reliable here; the terminal stays on the DOM renderer.
    retry.lost()
    acquireWebgl('lost')
    expect(addonOf('lost')).toBeUndefined()
  })

  it('refits after a context loss so the backend gets the DOM renderer column count', () => {
    shown('refit')
    resizes.mockClear()
    fitTo.cols = 121
    addonOf('refit')!.lost()
    expect(resizes).toHaveBeenCalledWith('refit', 121, 24)
  })

  it('refits WebGL terminals when the display pixel ratio changes', () => {
    shown('dpr')
    ids.push('dpr-dom')
    ;(getTerm('dpr-dom', 'dark').host as { isConnected: boolean }).isConnected = true
    resizes.mockClear()
    fitTo.cols = 135
    dpr.change!()
    expect(resizes).toHaveBeenCalledWith('dpr', 135, 24)
    expect(resizes).toHaveBeenCalledTimes(1)
  })

  it('releases the addon when the terminal is disposed', () => {
    shown('gone')
    const addon = addonOf('gone')!
    disposeTerm('gone')
    expect(addon.disposed).toBe(true)
    // The context is freed at once instead of counting against the browser's limit until garbage collection.
    expect(addon.freed).toEqual({ afterDispose: true })
  })
})

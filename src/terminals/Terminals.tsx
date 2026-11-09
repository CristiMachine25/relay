import { useEffect } from 'react'
import clsx from 'clsx'
import { Gauge, Loader2 } from 'lucide-react'
import { api } from '@/api'
import { useStore } from '@/store'
import { LAYOUTS, LAYOUT_IDS, type Dir, type LayoutId } from '@/lib/grid'
import { modKey } from '@/lib/platform'
import type { LimitView } from '@/lib/limitView'
import { restyleAll } from './registry'
import { useGrid } from './store'
import { useLimitView, useLimitViews } from './limitView'
import { Pane } from './Pane'
import { SessionsPanel } from './Sessions'
import { onRadioArrows } from '@/components/ui'

/** Tiny picture of a layout preset, drawn from the same rects the grid uses. */
function LayoutIcon({ id }: { id: LayoutId }) {
  const l = LAYOUTS[id]
  const W = 18
  const H = 13
  const cw = W / l.cols
  const rh = H / l.rows
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden>
      {l.rects.map((r, i) => (
        <rect key={i} x={r.col * cw + 0.75} y={r.row * rh + 0.75} width={r.colSpan * cw - 1.5} height={r.rowSpan * rh - 1.5} rx={1.2} fill="currentColor" />
      ))}
    </svg>
  )
}

const LIMIT_OPTIONS: Record<LimitView, { label: string; tip: string }> = {
  five_hour: { label: '5 hours', tip: "Show each pane's 5-hour limit" },
  seven_day: { label: 'Week', tip: "Show each pane's weekly limit" },
  seven_day_fable: { label: 'Fable', tip: "Show each pane's weekly Fable limit — half of the weekly one" }
}

/** Chooses which limit every pane's header shows, so two panes never show different limits unannounced. */
export function LimitSwitch() {
  const { view, views } = useLimitViews()
  const setView = useLimitView((s) => s.setView)
  return (
    <div className="ml-auto flex shrink-0 items-center gap-1.5">
      <span id="limit-switch-label" className="flex items-center gap-1 text-xs text-muted">
        <Gauge size={13} aria-hidden />
        Limits
      </span>
      <div className="inline-flex rounded border border-rivet bg-deck p-0.5" role="radiogroup" aria-labelledby="limit-switch-label" onKeyDown={onRadioArrows}>
        {views.map((v) => (
          <button
            key={v}
            role="radio"
            aria-checked={view === v}
            tabIndex={view === v ? 0 : -1}
            data-tip={LIMIT_OPTIONS[v].tip}
            onClick={() => setView(v)}
            className={clsx(
              'flex h-7 items-center whitespace-nowrap rounded-[4px] px-2 text-xs transition-colors',
              view === v ? 'bg-raised font-semibold text-hop' : 'text-faint hover:text-ink'
            )}
          >
            {LIMIT_OPTIONS[v].label}
          </button>
        ))}
      </div>
    </div>
  )
}

const ARROWS: Record<string, Dir> = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' }

function useGridKeys() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = api.platform === 'darwin' ? e.metaKey : e.ctrlKey
      if (!mod || !e.shiftKey) return
      const g = useGrid.getState()
      const dir = ARROWS[e.key]
      if (dir) {
        e.preventDefault()
        g.move(dir)
      } else if (e.key === 'Enter') {
        e.preventDefault()
        g.toggleMax()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}

export function Terminals() {
  const ws = useGrid((s) => s.ws)
  const restored = useGrid((s) => s.restored)
  const restore = useGrid((s) => s.restore)
  const setLayout = useGrid((s) => s.setLayout)
  const mode = useStore((s) => s.resolvedTheme)
  const layout = LAYOUTS[ws.layout]
  const mod = modKey(api.platform)

  useGridKeys()
  useEffect(() => {
    void restore()
  }, [restore])
  useEffect(() => {
    // Wait a frame so the new theme's CSS variables are in place before reading them.
    requestAnimationFrame(() => restyleAll(mode))
  }, [mode])

  return (
    <div className="flex h-full">
      <SessionsPanel />
      <div className="flex min-w-0 flex-1 flex-col">
        <header data-tauri-drag-region="deep" className="flex h-14 shrink-0 items-center gap-3 border-b border-rivet px-4 min-[1100px]:gap-4 min-[1100px]:px-5">
          <h1 className="font-sans text-lg font-semibold">Terminals</h1>
          <p className="hidden text-xs text-muted min-[1100px]:block">
            Each pane runs on its own account. {mod}+Shift+arrows move between panes, {mod}+Shift+Enter maximizes.
          </p>
          <LimitSwitch />
          <div className="inline-flex shrink-0 rounded border border-rivet bg-deck p-0.5" role="radiogroup" aria-label="Layout" onKeyDown={onRadioArrows}>
            {LAYOUT_IDS.map((id) => (
              <button
                key={id}
                role="radio"
                aria-checked={ws.layout === id}
                tabIndex={ws.layout === id ? 0 : -1}
                data-tip={LAYOUTS[id].label}
                aria-label={LAYOUTS[id].label}
                onClick={() => setLayout(id)}
                className={clsx(
                  'flex h-7 w-9 items-center justify-center rounded-[4px] transition-colors',
                  ws.layout === id ? 'bg-raised text-hop' : 'text-faint hover:text-ink'
                )}
              >
                <LayoutIcon id={id} />
              </button>
            ))}
          </div>
        </header>
        {!restored ? (
          <div className="flex flex-1 items-center justify-center gap-2 text-muted" role="status">
            <Loader2 size={16} className="animate-spin" /> Reconnecting to running terminals…
          </div>
        ) : (
          <div
            className="grid min-h-0 flex-1 gap-2 p-2"
            style={
              ws.maximized !== null
                ? { gridTemplateColumns: '1fr', gridTemplateRows: '1fr' }
                : { gridTemplateColumns: `repeat(${layout.cols}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${layout.rows}, minmax(0, 1fr))` }
            }
          >
            {ws.panes.map((p, i) => {
              const r = layout.rects[i]
              const hidden = ws.maximized !== null && ws.maximized !== i
              return (
                <div
                  key={p.uid}
                  className={clsx('flex min-h-0 min-w-0 [&>section]:flex-1', hidden && 'hidden')}
                  style={
                    ws.maximized === i || !r
                      ? undefined
                      : { gridColumn: `${r.col + 1} / span ${r.colSpan}`, gridRow: `${r.row + 1} / span ${r.rowSpan}` }
                  }
                >
                  <Pane index={i} pane={p} />
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

import { useMemo, useState } from 'react'
import type { Account, UsageHistoryPoint, UsageSnapshot, UsageWindow } from '@shared/types'
import { USE_IT_MIN_WINDOW_MINUTES, longWindow } from '@/lib/quota'
import { formatDay, windowName } from '@/lib/format'
import { tipTime, useChartColors } from './theme'

/**
 * Weekly/monthly used % per account over time, as small multiples: one strip per account on a shared time axis.
 * Overlaid sawtooth lines for 6+ accounts are unreadable; aligned strips make "who resets full vs empty" obvious.
 */
export function UsageOverTime({
  accounts,
  usage,
  history,
  days
}: {
  accounts: Account[]
  usage: Record<string, UsageSnapshot>
  history: UsageHistoryPoint[]
  days: number
}) {
  const c = useChartColors()
  const end = useMemo(() => Date.now(), [history, days]) // eslint-disable-line react-hooks/exhaustive-deps
  const start = end - days * 86_400_000

  const rows = useMemo(() => {
    const step = (days > 10 ? 2 : 1) * 3_600_000
    return accounts
      .map((a) => ({ a, w: longWindow(usage[a.id]) }))
      .filter((x): x is { a: Account; w: UsageWindow } => !!x.w && (x.w.windowMinutes ?? 0) >= USE_IT_MIN_WINDOW_MINUTES)
      .map(({ a, w }) => {
        const seen = new Set<number>()
        const data: { t: number; v: number }[] = []
        for (const p of history) {
          if (p.accountId !== a.id || !(w.id in p.windows)) continue
          const t = Date.parse(p.t)
          if (t < start) continue
          const b = Math.floor(t / step)
          if (seen.has(b)) continue
          seen.add(b)
          data.push({ t, v: p.windows[w.id]! }) // present: checked with `in` above
        }
        data.sort((x, y) => x.t - y.t)
        return { a, w, data }
      })
      .filter((r) => r.data.length > 1)
  }, [accounts, usage, history, days, start])

  if (!rows.length) return <p className="py-10 text-center text-muted">No history yet. It fills in as Relay checks usage.</p>

  const ticks = [0, 1, 2, 3].map((i) => start + ((end - start) * i) / 3)
  return (
    <div role="group" aria-label="Weekly and monthly limits used over time, one strip per account">
      <ul className="space-y-1">
        {rows.map(({ a, w, data }) => {
          const last = data[data.length - 1]!.v // rows keep two or more points
          return (
            <li key={a.id} className="grid grid-cols-[minmax(0,8.5rem)_1fr_3.25rem] items-center gap-3">
              <span className="min-w-0">
                <span className="block truncate">{a.label}</span>
                <span className="block truncate text-[11px] leading-4 text-muted">{windowName(w.label)}</span>
              </span>
              <Strip data={data} start={start} end={end} color={a.color} fillOpacity={c.theme === 'dark' ? 0.22 : 0.16} cursor={c.axis} ring={c.surface} />
              <span className="text-right text-xs tabular-nums text-muted" data-tip="Used now">
                {Math.round(last)}%<span className="sr-only"> used now</span>
              </span>
            </li>
          )
        })}
      </ul>
      <div className="mt-1 grid grid-cols-[minmax(0,8.5rem)_1fr_3.25rem] gap-3 text-[11px] text-muted">
        <span>Strip height = % used</span>
        <span className="flex justify-between tabular-nums">
          {ticks.map((t) => (
            <span key={t}>{formatDay(t)}</span>
          ))}
        </span>
        <span className="text-right">Now</span>
      </div>
    </div>
  )
}

/**
 * One account's strip: a plain SVG area, since a chart library instance per account made Start work slow to show.
 * Hovering shows the nearest point's time and value, like the other charts' tooltips.
 */
function Strip({ data, start, end, color, fillOpacity, cursor, ring }: { data: { t: number; v: number }[]; start: number; end: number; color: string; fillOpacity: number; cursor: string; ring: string }) {
  const [hover, setHover] = useState<number | null>(null)
  const x = (t: number) => ((t - start) / (end - start)) * 100
  // Two points of headroom at the top, as the chart had.
  const y = (v: number) => 2 + (1 - v / 100) * 34
  const line = data.map((p) => `${x(p.t).toFixed(2)},${y(p.v).toFixed(2)}`).join(' L')
  const area = `M${x(data[0]!.t).toFixed(2)},36 L${line} L${x(data[data.length - 1]!.t).toFixed(2)},36 Z`
  const p = hover === null ? null : data[hover]!
  return (
    <div
      className="relative h-9 border-b border-rivet"
      onMouseMove={(e) => {
        const r = e.currentTarget.getBoundingClientRect()
        const t = start + ((e.clientX - r.left) / r.width) * (end - start)
        let best = 0
        for (let i = 1; i < data.length; i++) if (Math.abs(data[i]!.t - t) < Math.abs(data[best]!.t - t)) best = i
        setHover(best)
      }}
      onMouseLeave={() => setHover(null)}
    >
      <svg className="absolute inset-0 h-full w-full overflow-visible" viewBox="0 0 100 36" preserveAspectRatio="none" aria-hidden>
        <path d={area} fill={color} fillOpacity={fillOpacity} />
        <path d={`M${line}`} fill="none" stroke={color} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
        {p && <line x1={x(p.t)} x2={x(p.t)} y1={0} y2={36} stroke={cursor} strokeWidth={1} vectorEffect="non-scaling-stroke" />}
      </svg>
      {p && (
        <>
          <span
            className="pointer-events-none absolute h-[7px] w-[7px] -translate-x-1/2 -translate-y-1/2 rounded-full"
            style={{ left: `${x(p.t)}%`, top: `${(y(p.v) / 36) * 100}%`, background: color, boxShadow: `0 0 0 2px ${ring}` }}
          />
          <div
            className="pointer-events-none absolute bottom-full z-10 mb-1 whitespace-nowrap rounded border border-rivet bg-deck px-2.5 py-1.5 text-xs shadow-lg"
            style={{ left: `${x(p.t)}%`, transform: `translateX(${x(p.t) > 70 ? '-100%' : '0'})` }}
          >
            <span className="text-muted">{tipTime.format(p.t)}: </span>
            <span className="tabular-nums">{Math.round(p.v)}% used</span>
          </div>
        </>
      )}
    </div>
  )
}

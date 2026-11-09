import clsx from 'clsx'
import { Gauge } from 'lucide-react'
import type { LimitView } from '@/lib/limitView'
import { onRadioArrows } from '@/components/ui'

const OPTIONS: Record<LimitView, { label: string; tip: (subject: string) => string }> = {
  five_hour: { label: '5 hours', tip: (s) => `Show each ${s}'s 5-hour limit` },
  seven_day: { label: 'Week', tip: (s) => `Show each ${s}'s weekly limit` },
  seven_day_fable: { label: 'Fable', tip: (s) => `Show each ${s}'s weekly Fable limit — half of the weekly one` }
}

/**
 * Chooses which limit every account in a view shows, so two accounts never show different limits unannounced.
 * `subject` is what the limit is shown on ("pane", "account"); one choice is saved for every screen that has the switch.
 */
export function LimitSwitch({
  view,
  views,
  onChange,
  subject,
  className
}: {
  view: LimitView
  views: LimitView[]
  onChange: (view: LimitView) => void
  subject: string
  className?: string
}) {
  return (
    <div className={clsx('flex shrink-0 items-center gap-1.5', className)}>
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
            data-tip={OPTIONS[v].tip(subject)}
            onClick={() => onChange(v)}
            className={clsx(
              'flex h-7 items-center whitespace-nowrap rounded-[4px] px-2 text-xs transition-colors',
              view === v ? 'bg-raised font-semibold text-hop' : 'text-faint hover:text-ink'
            )}
          >
            {OPTIONS[v].label}
          </button>
        ))}
      </div>
    </div>
  )
}

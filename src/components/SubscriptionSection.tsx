import { useId } from 'react'
import clsx from 'clsx'
import type { Account } from '@shared/types'
import { useStore } from '@/store'
import { formatDay, plural } from '@/lib/format'
import { subscriptionFor, subscriptionNote, type SubscriptionInfo } from '@/lib/subscription'
import { Segmented } from '@/components/ui'
import { URGENCY_TEXT, subscriptionIcon } from '@/components/SubscriptionBadge'

type AutoRenew = 'on' | 'off' | 'unset'
const toChoice = (v: boolean | null | undefined): AutoRenew => (v === true ? 'on' : v === false ? 'off' : 'unset')
const fromChoice = (c: AutoRenew): boolean | null => (c === 'on' ? true : c === 'off' ? false : null)

const DAY_LABEL: Record<SubscriptionInfo['state'], string> = {
  renews: 'Renews on',
  ends: 'Ends on',
  'unknown-renewal': 'Next billing day',
  canceled: 'Ends on',
  ended: 'Ended on',
  none: 'Next billing day'
}

function statusText(a: Account): string {
  const status = a.subscription?.status
  if (!status) return a.subscription ? 'Not reported' : 'Not checked yet'
  return status.charAt(0).toUpperCase() + status.slice(1).replace(/_/g, ' ')
}

function daysText(days: number): string {
  return days === 0 ? 'Today' : days === 1 ? 'Tomorrow' : days > 0 ? `In ${plural(days, 'day')}` : `${plural(-days, 'day')} ago`
}

function Fact({ label, children, tone }: { label: string; children: React.ReactNode; tone?: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className={clsx('truncate font-semibold tabular-nums', tone)}>{children}</dd>
    </div>
  )
}

/** The plan behind an account: what the provider reports, the day it renews or ends, and the two notes only the owner can make. */
export function SubscriptionSection({ account: a }: { account: Account }) {
  const now = useStore((s) => s.now)
  const updateAccount = useStore((s) => s.updateAccount)
  const s = subscriptionFor(a, now)
  const note = subscriptionNote(s)
  const labelId = useId()
  const dayId = useId()
  const Icon = subscriptionIcon(s)

  return (
    <div>
      {s.state === 'none' && !a.subscription ? (
        <p className="text-muted">No subscription details yet. Relay reads them the next time it checks this account.</p>
      ) : (
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 min-[1100px]:grid-cols-4">
          <Fact label="Status">{statusText(a)}</Fact>
          <Fact label="Started on">{s.startedOn ? formatDay(s.startedOn, true) : 'Unknown'}</Fact>
          <Fact label={DAY_LABEL[s.state]} tone={URGENCY_TEXT[s.urgency]}>
            {s.day ? (
              <span className="inline-flex items-center gap-1.5">
                <Icon size={13} className="shrink-0" aria-hidden />
                {formatDay(s.day, true)}
                {s.estimated && <span className="text-xs font-normal text-muted">estimated</span>}
              </span>
            ) : (
              'Unknown'
            )}
          </Fact>
          <Fact label="Time left">{s.daysLeft === null ? 'Unknown' : daysText(s.daysLeft)}</Fact>
        </dl>
      )}
      {note && <p className="mt-2 text-xs text-muted">{note}</p>}

      <div className="mt-4 flex flex-wrap items-end gap-x-8 gap-y-3">
        <div>
          <div id={labelId} className="mb-1 text-xs text-muted">
            Auto-renew
          </div>
          <Segmented
            size="sm"
            aria-labelledby={labelId}
            value={toChoice(s.state === 'canceled' ? false : a.autoRenew)}
            onChange={(c) => void updateAccount(a.id, { autoRenew: fromChoice(c) }, { quiet: true })}
            options={[
              { id: 'on', label: 'On' },
              { id: 'off', label: 'Off' },
              { id: 'unset', label: 'Not set' }
            ]}
          />
        </div>
        <div>
          <label htmlFor={dayId} className="mb-1 block text-xs text-muted">
            Renewal day
          </label>
          <div className="flex items-center gap-2">
            <input
              id={dayId}
              type="date"
              className="h-7 text-xs"
              value={a.renewsOn ?? ''}
              onChange={(e) => void updateAccount(a.id, { renewsOn: e.target.value || null }, { quiet: true })}
            />
            <button className="btn btn-sm btn-ghost" disabled={!a.renewsOn} onClick={() => void updateAccount(a.id, { renewsOn: null }, { quiet: true })}>
              Use estimate
            </button>
          </div>
        </div>
      </div>
      <p className="mt-2 text-xs text-muted">The provider doesn't tell Relay the billing day or whether auto-renew is on, so these are your own notes.</p>
    </div>
  )
}

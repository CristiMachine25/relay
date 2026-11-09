import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { SubscriptionBadge } from './SubscriptionBadge'

const now = new Date(2026, 10, 9, 12).getTime()
const subscription = { status: 'active', startedAt: new Date(2026, 9, 16, 12).toISOString(), checkedAt: new Date(now).toISOString() }
const render = (account: Parameters<typeof SubscriptionBadge>[0]['account']) => renderToStaticMarkup(<SubscriptionBadge account={account} now={now} />)

describe('SubscriptionBadge', () => {
  it('says when a plan renews, quietly, and explains an estimate in its tooltip', () => {
    const html = render({ subscription, autoRenew: true })
    expect(html).toContain('Renews Nov 16 (est.)')
    expect(html).toContain('text-muted')
    expect(html).toContain('lucide-calendar-sync')
    expect(html).toContain('data-tip="Renews Nov 16 (est.), in 7 days. Estimated from the day the plan started (Oct 16). Set the day by hand if it is a yearly plan."')
  })

  it('warns in words and color when a plan ends soon without auto-renew', () => {
    const html = render({ renewsOn: '2026-11-11', autoRenew: false })
    expect(html).toContain('Ends Nov 11')
    expect(html).toContain('text-empty')
    expect(html).toContain('lucide-calendar-x')
    expect(html).toContain('data-tip="Ends Nov 11, in 2 days, auto-renew off."')
    expect(render({ renewsOn: '2026-11-15', autoRenew: false })).toContain('text-low')
  })

  it('shows the billing day when auto-renew is not set, and a canceled plan', () => {
    expect(render({ subscription })).toMatch(/lucide-calendar-clock.*Next billing day Nov 16 \(est\.\)/)
    expect(render({ subscription: { ...subscription, status: 'canceled' } })).toContain('Subscription canceled')
  })

  it('renders nothing when nothing is known', () => {
    expect(render({})).toBe('')
    expect(render({ subscription: null, autoRenew: true })).toBe('')
  })
})

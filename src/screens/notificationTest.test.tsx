import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

const platform = vi.hoisted(() => ({ name: 'darwin' }))
vi.mock('@/api', () => ({
  api: {
    get platform() {
      return platform.name
    },
    on: () => () => {}
  },
  errorText: String
}))
const { TestNote } = await import('./Settings')

const note = (state: Parameters<typeof TestNote>[0]['state']) => renderToStaticMarkup(<TestNote state={state} />)

describe('the test notification note', () => {
  it('on macOS says plainly when notifications are blocked and offers the settings pane', () => {
    platform.name = 'darwin'
    const html = note('blocked')
    expect(html).toContain('macOS is blocking Relay&#x27;s notifications')
    expect(html).toContain('System Settings → Notifications → Relay')
    expect(html).toContain('Open System Settings')
  })

  it('tells what to do about the permission prompt while waiting', () => {
    platform.name = 'darwin'
    expect(note('sending')).toContain('choose Allow')
  })

  it('elsewhere offers no macOS settings button', () => {
    platform.name = 'windows'
    expect(note('sent')).toContain('Sent.')
    expect(note('sent')).not.toContain('System Settings')
    expect(note('blocked')).not.toContain('Open System Settings')
  })

  it('reports a failure and explains the button before any test', () => {
    expect(note('failed')).toContain('could not be sent')
    expect(note('idle')).toContain('Shows one system notification')
  })
})

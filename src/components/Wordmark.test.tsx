import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { Wordmark } from './Wordmark'

describe('Wordmark', () => {
  it('is named Relay for assistive tech and follows the theme colors', () => {
    const html = renderToStaticMarkup(<Wordmark className="x" />)
    expect(html).toContain('role="img"')
    expect(html).toContain('aria-label="Relay"')
    expect(html).toContain('stroke="currentColor"')
    expect(html).toContain('class="x"')
  })
})

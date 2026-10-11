import { describe, expect, it } from 'vitest'
import { hasLink, safeHref, segmentText } from './linkify'

/** The invariant the caret depends on: segments reproduce the input exactly. */
function reassemble(text: string): string {
  return segmentText(text)
    .map((segment) => segment.text)
    .join('')
}

describe('segmentText', () => {
  it('leaves plain prose alone', () => {
    expect(segmentText('buy milk')).toEqual([{ kind: 'text', text: 'buy milk' }])
  })

  it('finds an http URL', () => {
    expect(segmentText('see https://example.com now')).toEqual([
      { kind: 'text', text: 'see ' },
      { kind: 'link', text: 'https://example.com', href: 'https://example.com/' },
      { kind: 'text', text: ' now' },
    ])
  })

  it('finds several links in one row', () => {
    const segments = segmentText('https://a.test and https://b.test')
    expect(segments.filter((s) => s.kind === 'link')).toHaveLength(2)
  })

  it('treats a www prefix as https', () => {
    const [link] = segmentText('www.example.com')
    expect(link).toEqual({
      kind: 'link',
      text: 'www.example.com',
      href: 'https://www.example.com/',
    })
  })

  it('turns an email address into a mailto link', () => {
    const [link] = segmentText('me@example.com')
    expect(link).toEqual({
      kind: 'link',
      text: 'me@example.com',
      href: 'mailto:me@example.com',
    })
  })

  it('does not guess at bare domains', () => {
    // Otherwise ordinary prose like "node.js" becomes a link.
    expect(segmentText('upgrade node.js today')).toEqual([
      { kind: 'text', text: 'upgrade node.js today' },
    ])
  })

  it('leaves sentence punctuation out of the URL', () => {
    const [, link] = segmentText('go to https://example.com.')
    expect(link).toMatchObject({ kind: 'link', text: 'https://example.com' })
  })

  it('keeps a closing bracket the URL itself opened', () => {
    const [link] = segmentText('https://example.com/a_(b)')
    expect(link).toMatchObject({ text: 'https://example.com/a_(b)' })
  })

  it('drops a closing bracket that wraps the URL', () => {
    // Markdown link syntax survives import as literal text; the URL inside it
    // should still be clickable without swallowing the bracket.
    const segments = segmentText('[label](https://example.com)')
    expect(segments.map((s) => s.text).join('')).toBe(
      '[label](https://example.com)',
    )
    expect(segments.find((s) => s.kind === 'link')).toMatchObject({
      text: 'https://example.com',
    })
  })

  it('reproduces the input exactly, whatever it contains', () => {
    for (const sample of [
      'plain',
      'https://a.test',
      'a https://b.test c',
      'trailing https://c.test.',
      '(https://d.test)',
      'mail me@x.test ok',
      'https://e.test/path?q=1&r=2#frag',
      '',
      'javascript:alert(1)',
    ]) {
      expect(reassemble(sample)).toBe(sample)
    }
  })
})

describe('safeHref', () => {
  it('accepts http, https and mailto', () => {
    expect(safeHref('https://a.test')).toBe('https://a.test/')
    expect(safeHref('http://a.test')).toBe('http://a.test/')
    expect(safeHref('me@a.test')).toBe('mailto:me@a.test')
  })

  it('rejects javascript and other schemes outright', () => {
    // This is the one that matters: a javascript: href inside the document
    // would run whatever a pasted item said.
    expect(safeHref('javascript:alert(1)')).toBeNull()
    expect(safeHref('data:text/html,<script>')).toBeNull()
    expect(safeHref('file:///etc/passwd')).toBeNull()
    expect(safeHref('vbscript:x')).toBeNull()
  })

  it('rejects unparseable input', () => {
    expect(safeHref('https://')).toBeNull()
    expect(safeHref('   ')).toBeNull()
  })
})

describe('hasLink', () => {
  it('reports whether a row contains anything clickable', () => {
    expect(hasLink('nothing here')).toBe(false)
    expect(hasLink('look: https://a.test')).toBe(true)
    expect(hasLink('javascript:alert(1)')).toBe(false)
  })
})

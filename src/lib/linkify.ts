/**
 * Finding links in a row's plain text.
 *
 * Only *bare* URLs are recognised, and the displayed text is always byte-for-
 * byte the model's text. That invariant is load-bearing: every caret offset in
 * this app is a character offset into `item.text`, so a rendering that
 * shortened `[label](url)` to `label` would silently desynchronise the caret
 * from the model. Links are decoration over the same characters, never a
 * substitution for them.
 */

export type Segment =
  { kind: 'text'; text: string } | { kind: 'link'; text: string; href: string }

/**
 * Deliberately conservative: an explicit scheme, a `www.` prefix, or something
 * shaped like an email address. Guessing at bare domains turns ordinary prose
 * like "node.js" into links.
 */
const CANDIDATE =
  /(https?:\/\/[^\s]+|www\.[^\s]+|[^\s@<>]+@[^\s@<>]+\.[A-Za-z]{2,})/g

/** Sentence punctuation that follows a URL far more often than it belongs to one. */
const TRAILING_PUNCTUATION = /[.,;:!?'"»”’]+$/

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])

/**
 * Resolve matched text to a safe absolute URL, or `null` to leave it as plain
 * text. Anything that is not http, https or mailto is rejected — `javascript:`
 * in particular must never reach an `href`.
 */
export function safeHref(raw: string): string | null {
  const candidate = raw.includes('://')
    ? raw
    : raw.includes('@')
      ? `mailto:${raw}`
      : `https://${raw}`

  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    return null
  }
  if (!ALLOWED_PROTOCOLS.has(url.protocol)) return null
  if (url.protocol !== 'mailto:' && url.hostname === '') return null
  return url.href
}

/**
 * Split text into plain runs and links. Concatenating every segment's `text`
 * reproduces the input exactly.
 */
export function segmentText(text: string): Segment[] {
  const segments: Segment[] = []
  let cursor = 0

  for (const match of text.matchAll(CANDIDATE)) {
    const start = match.index
    const matched = match[0]

    // Trailing punctuation usually belongs to the sentence, not the URL. A
    // closing bracket is kept only when the URL opened one, so that
    // `[label](https://x.test/a)` and `https://x.test/a_(b)` both work.
    let body = matched.replace(TRAILING_PUNCTUATION, '')
    while (body.endsWith(')') && countOf(body, ')') > countOf(body, '(')) {
      body = body.slice(0, -1)
    }
    while (body.endsWith(']') && countOf(body, ']') > countOf(body, '[')) {
      body = body.slice(0, -1)
    }
    body = body.replace(TRAILING_PUNCTUATION, '')

    const href = body === '' ? null : safeHref(body)
    if (href === null) continue

    if (start > cursor) {
      segments.push({ kind: 'text', text: text.slice(cursor, start) })
    }
    segments.push({ kind: 'link', text: body, href })
    cursor = start + body.length
  }

  if (cursor < text.length) {
    segments.push({ kind: 'text', text: text.slice(cursor) })
  }
  return segments
}

function countOf(text: string, character: string): number {
  let total = 0
  for (const letter of text) if (letter === character) total += 1
  return total
}

/** True if the text contains anything that would render as a link. */
export function hasLink(text: string): boolean {
  return segmentText(text).some((segment) => segment.kind === 'link')
}

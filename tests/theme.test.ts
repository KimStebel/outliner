import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * The dark background is declared in three places that cannot see each other:
 * the stylesheet, the scheme-aware `theme-color` meta, and the manifest. The
 * manifest is the awkward one — it is static, so it cannot follow the system
 * scheme, and it is what Android reads for system chrome on an installed app.
 * Leaving it white there is what put a white navigation bar under a dark app.
 */

const css = readFileSync('src/app.css', 'utf8')
const html = readFileSync('index.html', 'utf8')
const manifest = JSON.parse(
  readFileSync('public/manifest.webmanifest', 'utf8'),
) as { background_color: string; theme_color: string }

function darkBackgroundFromCss(): string {
  const block = /@media \(prefers-color-scheme: dark\)([\s\S]*?)\n\}/.exec(css)?.[1]
  const value =
    block === undefined ? undefined : /--bg:\s*(#[0-9a-fA-F]+)/.exec(block)?.[1]
  if (value === undefined) throw new Error('no dark --bg found in app.css')
  return value.toLowerCase()
}

function darkThemeColorFromHtml(): string {
  // Matched one tag at a time: a pattern spanning the whole document reads
  // the content of the light tag and the media of the dark one.
  for (const fragment of html.split('<meta').slice(1)) {
    const tag = fragment.slice(0, fragment.indexOf('>'))
    if (!/name="theme-color"/.test(tag)) continue
    if (!/media="\(prefers-color-scheme: dark\)"/.test(tag)) continue
    const value = /content="(#[0-9a-fA-F]+)"/.exec(tag)?.[1]
    if (value !== undefined) return value.toLowerCase()
  }
  throw new Error('no dark theme-color meta found')
}

describe('the dark background is declared consistently', () => {
  it('the stylesheet and the theme-color meta agree', () => {
    expect(darkThemeColorFromHtml()).toBe(darkBackgroundFromCss())
  })

  it('the manifest uses it too, since it cannot follow the system scheme', () => {
    // Android reads these for an installed app's system chrome and splash.
    expect(manifest.theme_color.toLowerCase()).toBe(darkBackgroundFromCss())
    expect(manifest.background_color.toLowerCase()).toBe(darkBackgroundFromCss())
  })
})

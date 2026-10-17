/**
 * Generate the app icons into `public/`.
 *
 * Rasterises an inline SVG with the Chromium that Playwright already provides,
 * so icon generation needs no image library. Run it again whenever the mark
 * changes; the output is committed, so a normal build does not need Chromium.
 *
 * Usage: node scripts/make-icons.mjs
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'

// The mark's own colour, deliberately not the UI accent: the icon is red and
// the interface is blue. White glyphs sit on it at about 5:1.
const LOGO = '#d32f2f'
const OUT = new URL('../public/', import.meta.url)

/**
 * The mark: three outline rows, the middle one indented, so the icon says
 * "nested list" at a glance even at 32px.
 *
 * `inset` is the fraction of the canvas kept clear around the artwork.
 * Maskable icons are cropped to a circle by some launchers, so their artwork
 * has to sit inside the middle 80%.
 */
function markup({ inset, rounded }) {
  const size = 512
  const pad = size * inset
  const span = size - pad * 2
  const rowGap = span / 3
  const dot = span * 0.075
  const barHeight = span * 0.105
  const indent = span * 0.22

  const rows = [0, 1, 2]
    .map((index) => {
      const y = pad + rowGap * index + rowGap / 2
      const x = pad + (index === 1 ? indent : 0)
      const barStart = x + dot * 2.6
      const barEnd = pad + span
      return `
        <circle cx="${x + dot}" cy="${y}" r="${dot}" fill="white" opacity="0.95" />
        <rect x="${barStart}" y="${y - barHeight / 2}" width="${barEnd - barStart}"
              height="${barHeight}" rx="${barHeight / 2}" fill="white" opacity="0.95" />`
    })
    .join('')

  const radius = rounded ? size * 0.22 : 0
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">
  <rect width="${size}" height="${size}" rx="${radius}" fill="${LOGO}" />
  ${rows}
</svg>`
}

const VARIANTS = [
  // Regular icons are drawn with their own rounded corners.
  { file: 'icon-192.png', size: 192, inset: 0.18, rounded: true },
  { file: 'icon-512.png', size: 512, inset: 0.18, rounded: true },
  // Maskable artwork stays inside the safe zone and bleeds to the edges,
  // because the launcher supplies the shape.
  { file: 'icon-maskable-512.png', size: 512, inset: 0.28, rounded: false },
  // iOS does not read the manifest for its home-screen icon.
  { file: 'apple-touch-icon.png', size: 180, inset: 0.16, rounded: true },
]

await mkdir(OUT, { recursive: true })

const browser = await chromium.launch()
const page = await browser.newPage()

for (const variant of VARIANTS) {
  const svg = markup({ inset: variant.inset, rounded: variant.rounded })
  await page.setViewportSize({ width: variant.size, height: variant.size })
  await page.setContent(
    `<style>html,body{margin:0;padding:0;background:transparent}svg{display:block;width:100%;height:100%}</style>${svg}`,
  )
  const png = await page.screenshot({ omitBackground: true })
  await writeFile(new URL(variant.file, OUT), png)
  console.log(`wrote public/${variant.file} (${variant.size}px)`)
}

await writeFile(
  new URL('favicon.svg', OUT),
  `${markup({ inset: 0.16, rounded: true })}\n`,
)
console.log('wrote public/favicon.svg')

await browser.close()

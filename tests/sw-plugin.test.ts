import { describe, expect, it } from 'vitest'
import { precacheVersion } from '../build/sw-plugin.ts'

/**
 * The service worker's cache name identifies the precached set. If it is
 * derived from filenames alone, a build that only changes the *contents* of a
 * stably-named file — the manifest, an icon, the app shell — emits a
 * byte-identical worker. The browser then sees no update, never installs it,
 * and serves the previous cache indefinitely. That is how a white manifest
 * survived a deploy, taking a white splash screen and navigation bar with it.
 */

describe('precacheVersion', () => {
  it('changes when a file changes but keeps its name', () => {
    const before = precacheVersion([
      { url: '/manifest.webmanifest', content: '{"a":1}' },
    ])
    const after = precacheVersion([
      { url: '/manifest.webmanifest', content: '{"a":2}' },
    ])
    expect(after).not.toBe(before)
  })

  it('changes when a file is added or removed', () => {
    const one = precacheVersion([{ url: '/a.js', content: 'x' }])
    const two = precacheVersion([
      { url: '/a.js', content: 'x' },
      { url: '/b.js', content: 'y' },
    ])
    expect(two).not.toBe(one)
  })

  it('changes when a file is renamed', () => {
    expect(precacheVersion([{ url: '/a.js', content: 'x' }])).not.toBe(
      precacheVersion([{ url: '/b.js', content: 'x' }]),
    )
  })

  it('does not depend on the order entries arrive in', () => {
    const forwards = precacheVersion([
      { url: '/a.js', content: 'x' },
      { url: '/b.js', content: 'y' },
    ])
    const backwards = precacheVersion([
      { url: '/b.js', content: 'y' },
      { url: '/a.js', content: 'x' },
    ])
    expect(backwards).toBe(forwards)
  })

  it('cannot be fooled by content shifting between files', () => {
    // Hashing name and content run together without separators would make
    // these two collide.
    const split = precacheVersion([
      { url: '/a', content: 'xy' },
      { url: '/b', content: 'z' },
    ])
    const shifted = precacheVersion([
      { url: '/a', content: 'x' },
      { url: '/b', content: 'yz' },
    ])
    expect(shifted).not.toBe(split)
  })

  it('handles binary content, which icons are', () => {
    const one = precacheVersion([
      { url: '/i.png', content: new Uint8Array([1, 2, 3]) },
    ])
    const two = precacheVersion([
      { url: '/i.png', content: new Uint8Array([1, 2, 4]) },
    ])
    expect(two).not.toBe(one)
  })
})

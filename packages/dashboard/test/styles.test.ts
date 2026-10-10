import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// Contracts of the stylesheet that no runtime test reaches, checked on its source.
const css = readFileSync(new URL('../src/react/dashboard.css', import.meta.url), 'utf8')

/** Every rule as [selector, body], with comments removed; nested blocks are flattened. */
function rules(source: string): Array<[string, string]> {
  const text = source.replace(/\/\*[\s\S]*?\*\//g, '')
  const out: Array<[string, string]> = []
  for (const m of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    out.push([(m[1] ?? '').trim(), m[2] ?? ''])
  }
  return out
}

function block(start: string): string {
  const at = css.indexOf(start)
  expect(at).toBeGreaterThanOrEqual(0)
  let depth = 0
  for (let i = css.indexOf('{', at); i < css.length; i++) {
    if (css[i] === '{') depth++
    if (css[i] === '}' && --depth === 0) return css.slice(at, i + 1)
  }
  throw new Error(`unclosed block: ${start}`)
}

const tokens = (text: string) =>
  new Set([...text.matchAll(/(--cmd-[a-z0-9-]+):/g)].map((m) => m[1] as string))

describe('dashboard.css', () => {
  it('defines every light color token in both dark scopes', () => {
    const light = tokens(block('  .cmd-root {'))
    const media = tokens(block('  @media (prefers-color-scheme: dark)'))
    const toggle = tokens(block('  :root[data-theme="dark"] .cmd-root'))
    for (const t of ['--cmd-font', '--cmd-font-sans', '--cmd-radius']) light.delete(t)
    expect([...light].filter((t) => !media.has(t))).toEqual([])
    expect([...light].filter((t) => !toggle.has(t))).toEqual([])
  })

  it('colors state marks through custom properties, so forced colors can override them', () => {
    // A state selector that sets `background` on a mark outranks the forced-colors rule for it,
    // and the mark is then painted Canvas: a full bar looks empty.
    // Anywhere in the file outside the forced-colors block, in any form of the property.
    const forced = block('  @media (forced-colors: active)')
    const marks = /\.cmd-runway-used|::before|\.cmd-pool-fill|&/
    const offenders = rules(css.replace(forced, ''))
      .filter(([selector]) => /\[data-/.test(selector) && marks.test(selector))
      .filter(([, body]) => /(^|;|\s)background(-color)?\s*:/.test(body))
      .map(([selector]) => selector)
    expect(offenders).toEqual([])
    const canvasText = rules(forced)
      .filter(([, body]) => /background:\s*CanvasText/.test(body))
      .flatMap(([selector]) => selector.split(',').map((x) => x.trim()))
    for (const mark of ['.cmd-runway-used', '.cmd-row::before', '.cmd-pulse']) {
      expect(canvasText).toContain(mark)
    }
  })

  it('keeps pressed controls readable in forced colors', () => {
    const forced = block('  @media (forced-colors: active)')
    const pressed = rules(forced).find(([selector]) =>
      selector.includes('.cmd-tabs button[aria-pressed="true"]'),
    )
    expect(pressed?.[1]).toMatch(/forced-color-adjust:\s*none/)
    expect(pressed?.[0]).toContain('.cmd-segmented button[aria-pressed="true"]')
  })

  it('leaves the side padding of empty and error lines to their container', () => {
    const rule = rules(css).find(([selector]) => /^\.cmd-empty,\s*\.cmd-error$/.test(selector))
    expect(rule?.[1]).toBeDefined()
    expect(rule?.[1]).not.toMatch(/(^|\s)padding\s*:/)
  })

  it('draws the banner link in the stronger accent (4.5:1 on the tinted banner)', () => {
    const rule = rules(css).find(([selector]) => selector === '.cmd-banner a')
    expect(rule?.[1]).toMatch(/color:\s*var\(--cmd-accent-strong\)/)
  })
})

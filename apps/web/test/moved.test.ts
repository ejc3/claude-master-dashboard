import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { movedTo } from '../lib/moved'

const NEW = 'https://claw-master-dashboard.example.workers.dev'

describe('movedTo', () => {
  it('sends the page to the same path at the new origin', () => {
    expect(movedTo(NEW, '/claw-master')).toBe(`${NEW}/claw-master`)
    expect(movedTo(NEW, '/claw-master/try-reset')).toBe(`${NEW}/claw-master/try-reset`)
  })

  it('keeps only the origin of the setting', () => {
    expect(movedTo(`${NEW}/elsewhere?x=1`, '/claw-master')).toBe(`${NEW}/claw-master`)
  })

  it('leaves the page where it is without an https origin', () => {
    expect(movedTo(undefined, '/claw-master')).toBeNull()
    expect(movedTo('', '/claw-master')).toBeNull()
    expect(movedTo('/claw-master', '/claw-master')).toBeNull()
    expect(movedTo('http://claw-master-dashboard.example.workers.dev', '/claw-master')).toBeNull()
    expect(movedTo('javascript:alert(1)', '/claw-master')).toBeNull()
  })

  it('takes only a path of this site', () => {
    expect(movedTo(NEW, '//evil.example/x')).toBeNull()
    expect(movedTo(NEW, 'https://evil.example/x')).toBeNull()
  })
})

describe('the move, wired', () => {
  const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

  it('sends every page on before it renders', () => {
    for (const page of [
      'app/page.tsx',
      'app/claw-master/[[...slug]]/page.tsx',
      'app/claude-master/[[...slug]]/page.tsx',
    ]) {
      expect(read(page), page).toMatch(/redirectIfMoved\(/)
    }
  })

  it('moves only the old Worker', () => {
    // JSONC: drop the comments before parsing.
    const config = JSON.parse(read('wrangler.jsonc').replace(/^\s*\/\/.*$/gm, ''))
    expect(config.name).toBe('claude-master-dashboard')
    expect(config.vars.DASHBOARD_MOVED_TO).toBe(
      'https://claw-master-dashboard.cc-games.workers.dev',
    )
    expect(config.env.claw.name).toBe('claw-master-dashboard')
    expect(config.env.claw.vars).toEqual({})
  })
})

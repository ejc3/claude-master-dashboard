import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

describe('the deployed Worker', () => {
  it('is claw-master-dashboard only, with its URL on', () => {
    // JSONC: drop the comments before parsing.
    const config = JSON.parse(read('wrangler.jsonc').replace(/^\s*\/\/.*$/gm, ''))
    expect(config.name).toBe('claw-master-dashboard')
    expect(config.workers_dev).toBe(true)
    expect(config.preview_urls).toBe(false)
    // One Worker: no environment deploys another name, and nothing redirects elsewhere.
    expect(config.env).toBeUndefined()
    expect(config.vars).toBeUndefined()
  })

  it('deletes the retired Worker only once its URL is off', () => {
    const deploy = read('../../.github/workflows/deploy.yml')
    expect(deploy).not.toMatch(/wrangler deploy --env/)
    const step = deploy.slice(deploy.indexOf('- name: Delete the retired claude-master-dashboard'))
    expect(step.indexOf('.result.enabled or .result.previews_enabled')).toBeGreaterThan(-1)
    expect(step.indexOf('.result.enabled or .result.previews_enabled')).toBeLessThan(
      step.indexOf('-X DELETE'),
    )
  })
})

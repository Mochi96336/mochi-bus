import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { compileInstanceConfig, loadInstanceConfig } from './config.mjs'

const TRACE_POLICY = Object.freeze({ enabled: true, head_sampling_rate: 0.05 })

describe('operator observability tracing contract', () => {
  it('enables bounded automatic tracing only for the operator profile', async () => {
    const production = await loadInstanceConfig('instances/mochi-production.json')
    const starter = await loadInstanceConfig('instances/starter-chiayi.example.json')

    const productionWrangler = compileInstanceConfig(production).wrangler
    const starterWrangler = compileInstanceConfig(starter).wrangler

    expect(productionWrangler.observability).toEqual({
      enabled: true,
      logs: { invocation_logs: false },
      traces: TRACE_POLICY,
    })
    expect(starterWrangler.observability).toEqual({
      enabled: true,
      logs: { invocation_logs: false },
    })
    expect(starterWrangler.observability).not.toHaveProperty('traces')
  })

  it('keeps the checked-in production Wrangler config aligned with the compiler', async () => {
    const production = await loadInstanceConfig('instances/mochi-production.json')
    const compiled = compileInstanceConfig(production).wrangler
    const checkedIn = readFileSync('wrangler.jsonc', 'utf8')

    expect(compiled.observability.traces).toEqual(TRACE_POLICY)
    expect(checkedIn).toContain('"traces": {')
    expect(checkedIn).toContain('"enabled": true,\n      "head_sampling_rate": 0.05')
    expect(checkedIn).not.toContain('"head_sampling_rate": 1')
  })
})

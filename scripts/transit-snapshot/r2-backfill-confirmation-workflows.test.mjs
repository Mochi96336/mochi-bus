import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const workflows = [
  'backfill-pattern-stops.yml',
  'backfill-place-routing.yml',
  'backfill-transfer-routing.yml',
  'backfill-stop-lookup.yml',
]

function readWorkflow(name) {
  return readFileSync(new URL(`../../.github/workflows/${name}`, import.meta.url), 'utf8')
}

describe('production R2 backfill confirmation boundary', () => {
  for (const name of workflows) {
    it(`${name} requires an exact city/target confirmation before secrets reach the exporter`, () => {
      const workflow = readWorkflow(name)
      expect(workflow).toContain('confirmation:')
      expect(workflow).toContain('description: Type BACKFILL_<City>_<target> for the selected production R2 target')
      expect(workflow).toContain('required: true')
      expect(workflow).toContain('CONFIRMATION: ${{ inputs.confirmation }}')
      expect(workflow).toContain('TARGET: ${{ inputs.target }}')
      expect(workflow).toContain('test "$CONFIRMATION" = "BACKFILL_${CITY}_${TARGET}"')

      const confirmationGate = workflow.indexOf('test "$CONFIRMATION" = "BACKFILL_${CITY}_${TARGET}"')
      const cloudflareSecret = workflow.indexOf('CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}')
      const r2Secret = workflow.indexOf('R2_SECRET_ACCESS_KEY: ${{ secrets.R2_SECRET_ACCESS_KEY }}')
      expect(confirmationGate).toBeGreaterThanOrEqual(0)
      expect(cloudflareSecret).toBeGreaterThan(confirmationGate)
      expect(r2Secret).toBeGreaterThan(confirmationGate)
    })
  }

  it('keeps all four backfills manual-only and read-scoped at the GitHub token boundary', () => {
    for (const name of workflows) {
      const workflow = readWorkflow(name)
      expect(workflow).toContain('workflow_dispatch:')
      expect(workflow).not.toContain('schedule:')
      expect(workflow).not.toContain('push:')
      expect(workflow).toContain('permissions:\n      contents: read')
    }
  })
})

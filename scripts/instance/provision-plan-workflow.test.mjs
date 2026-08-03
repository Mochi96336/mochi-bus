import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const workflow = readFileSync(
  new URL('../../.github/workflows/instance-provisioning-plan.yml', import.meta.url),
  'utf8',
)

describe('instance provisioning plan workflow', () => {
  it('is manually triggered, read-only and keeps secrets on the planning step only', () => {
    expect(workflow).toContain('workflow_dispatch:')
    expect(workflow).toContain('remote:')
    expect(workflow).toContain('contents: read')
    expect(workflow).toContain('persist-credentials: false')

    const planIndex = workflow.indexOf('Generate non-destructive provisioning plan')
    const tokenIndex = workflow.indexOf('CLOUDFLARE_DEPLOY_API_TOKEN:')
    expect(planIndex).toBeGreaterThan(-1)
    expect(tokenIndex).toBeGreaterThan(planIndex)
    expect(workflow.slice(0, planIndex)).not.toContain('secrets.')
  })

  it('writes a summary, makes remote verification opt-in and never runs generated commands', () => {
    expect(workflow).toContain('args=(--github-summary)')
    expect(workflow).toContain('if [[ "${{ inputs.remote }}" == "true" ]]')
    expect(workflow).toContain('args+=(--remote)')
    expect(workflow).toContain('npm run instance:provision-plan -- "${args[@]}"')

    for (const mutation of [
      'wrangler d1 create',
      'wrangler r2 bucket create',
      'wrangler secret put',
      'gh secret set',
      'gh variable set',
    ]) {
      expect(workflow).not.toContain(mutation)
    }
  })

  it('selects a fork manifest before the planner runs without npm lifecycle scripts', () => {
    const manifestIndex = workflow.indexOf('MOCHI_BUS_INSTANCE_CONFIG:')
    const planIndex = workflow.indexOf('Generate non-destructive provisioning plan')
    expect(manifestIndex).toBeGreaterThan(-1)
    expect(manifestIndex).toBeLessThan(planIndex)
    expect(workflow).toContain('${{ vars.MOCHI_BUS_INSTANCE_CONFIG }}')
    expect(workflow).not.toContain('npm ci')
    expect(workflow).not.toContain('instance:compile')
  })
})

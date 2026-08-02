import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const workflow = readFileSync(new URL('../../.github/workflows/instance-doctor.yml', import.meta.url), 'utf8')

describe('instance doctor workflow', () => {
  it('is manually triggered and keeps secrets on the diagnostic step only', () => {
    expect(workflow).toContain('workflow_dispatch:')
    expect(workflow).toContain('remote:')
    expect(workflow).toContain('persist-credentials: false')

    const installIndex = workflow.indexOf('Install dependencies and compile instance')
    const doctorIndex = workflow.indexOf('Diagnose instance readiness')
    const tokenIndex = workflow.indexOf('CLOUDFLARE_API_TOKEN:')
    expect(installIndex).toBeGreaterThan(-1)
    expect(doctorIndex).toBeGreaterThan(installIndex)
    expect(tokenIndex).toBeGreaterThan(doctorIndex)
    expect(workflow.slice(0, doctorIndex)).not.toContain('secrets.')
  })

  it('runs protected code from the default branch before exposing secrets', () => {
    expect(workflow).toContain("if: github.ref == format('refs/heads/{0}', github.event.repository.default_branch)")
    expect(workflow).toContain('environment: instance-doctor')
    expect(workflow).toContain('ref: ${{ github.event.repository.default_branch }}')

    const checkoutIndex = workflow.indexOf('Check out default branch')
    const doctorIndex = workflow.indexOf('Diagnose instance readiness')
    expect(checkoutIndex).toBeGreaterThan(-1)
    expect(doctorIndex).toBeGreaterThan(checkoutIndex)
  })

  it('always writes the GitHub summary and makes remote verification opt-in', () => {
    expect(workflow).toContain('args=(--github-summary)')
    expect(workflow).toContain('if [[ "${{ inputs.remote }}" == "true" ]]')
    expect(workflow).toContain('args+=(--remote)')
    expect(workflow).toContain('npm run instance:doctor -- "${args[@]}"')
  })

  it('allows a repository variable to select the fork manifest before npm prepare runs', () => {
    const jobEnvironmentIndex = workflow.indexOf('MOCHI_BUS_INSTANCE_CONFIG:')
    const installIndex = workflow.indexOf('Install dependencies and compile instance')
    expect(jobEnvironmentIndex).toBeGreaterThan(-1)
    expect(jobEnvironmentIndex).toBeLessThan(installIndex)
    expect(workflow).toContain('${{ vars.MOCHI_BUS_INSTANCE_CONFIG }}')
  })
})

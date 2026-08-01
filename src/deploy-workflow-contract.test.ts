/// <reference types="vite/client" />
import { describe, expect, it } from 'vitest'
import workflowSource from '../.github/workflows/deploy.yml?raw'

function stepPosition(name: string): number {
  const index = workflowSource.indexOf(`      - name: ${name}`)
  expect(index, `missing workflow step: ${name}`).toBeGreaterThanOrEqual(0)
  return index
}

function stepSource(name: string, nextName?: string): string {
  const start = stepPosition(name)
  const end = nextName ? stepPosition(nextName) : workflowSource.length
  return workflowSource.slice(start, end)
}

describe('Deploy workflow post-deploy smoke contract', () => {
  it('resolves the instance before deploy and gates post-deploy verification', () => {
    const resolve = stepPosition('Resolve release verification scope')
    const deploy = stepPosition('Deploy Worker')
    const install = stepPosition('Install Chromium for post-deploy smoke')
    const smoke = stepPosition('Run true post-deploy release smoke')
    const upload = stepPosition('Upload post-deploy smoke evidence')

    expect(resolve).toBeLessThan(deploy)
    expect(deploy).toBeLessThan(install)
    expect(install).toBeLessThan(smoke)
    expect(smoke).toBeLessThan(upload)
    expect(workflowSource).toContain('node scripts/instance/operation-scope.mjs releaseSmoke')
    expect(stepSource('Install Chromium for post-deploy smoke', 'Run true post-deploy release smoke'))
      .toContain("if: steps.operation.outputs.enabled == 'true'")
    expect(stepSource('Run true post-deploy release smoke', 'Upload post-deploy smoke evidence'))
      .toContain("if: steps.operation.outputs.enabled == 'true'")
  })

  it('uses the generated instance origin for exact-release smoke', () => {
    expect(workflowSource).toContain('run: npm run release:smoke')
    expect(workflowSource).toContain('EXPECTED_RELEASE_SHA: ${{ github.sha }}')
    expect(workflowSource).toContain('RELEASE_SMOKE_ORIGIN: ${{ steps.operation.outputs.public_origin }}')
    expect(workflowSource).not.toContain('RELEASE_SMOKE_ORIGIN: https://bus.moc96336.com')
    expect(workflowSource).toContain('release-smoke-report.json')
  })

  it('uploads evidence after an attempted smoke but stays skipped after pre-deploy failure', () => {
    const smoke = stepSource('Run true post-deploy release smoke', 'Upload post-deploy smoke evidence')
    const upload = stepSource('Upload post-deploy smoke evidence')

    expect(smoke).toContain('id: release_smoke')
    expect(upload).toContain("if: ${{ always() && steps.release_smoke.outcome != 'skipped' }}")
    expect(upload).toContain('if-no-files-found: error')
    expect(upload).not.toMatch(/^\s*if:\s*always\(\)\s*$/m)
  })

  it('does not disguise pre-deploy checks or automatic rollback as post-deploy evidence', () => {
    const verify = stepPosition('Verify release candidate')
    const deploy = stepPosition('Deploy Worker')
    const smoke = stepPosition('Run true post-deploy release smoke')

    expect(verify).toBeLessThan(deploy)
    expect(deploy).toBeLessThan(smoke)
    expect(workflowSource).not.toMatch(/rollback|versions deploy|deployments rollback/i)
  })
})

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const workflow = readFileSync('.github/workflows/release-routes-diagnostic.yml', 'utf8')
const diagnostic = readFileSync('scripts/release-smoke/diagnose-routes.mjs', 'utf8')
const d1Diagnostic = readFileSync('scripts/release-smoke/diagnose-routes-d1.mjs', 'utf8')

describe('release routes diagnostic workflow', () => {
  it('compiles the production instance before loading operational resources', () => {
    const compile = workflow.indexOf('node scripts/instance/compile-config.mjs')
    const d1Diagnose = workflow.indexOf('node scripts/release-smoke/diagnose-routes-d1.mjs')
    const diagnose = workflow.indexOf('node scripts/release-smoke/diagnose-routes.mjs')

    expect(compile).toBeGreaterThan(-1)
    expect(d1Diagnose).toBeGreaterThan(compile)
    expect(diagnose).toBeGreaterThan(d1Diagnose)
    expect(diagnostic).toContain("import { loadOperationalResources } from '../instance/operational-resources.mjs'")
    expect(diagnostic).toContain('resolveDiagnosticTargets(loadOperationalResources({ env }))')
    expect(diagnostic).not.toContain("readFile(configPath, 'utf8')")
    expect(d1Diagnostic).toContain("import { loadOperationalResources } from '../instance/operational-resources.mjs'")
    expect(d1Diagnostic).toContain('resolveDiagnosticTargets(resources)')
  })

  it('keeps production credentials scoped to the fixed read-only D1 evidence step', () => {
    expect(workflow).toContain('permissions:\n  contents: read')
    expect(workflow).toContain("- 'scripts/release-smoke/diagnose-routes-d1.mjs'")
    expect((workflow.match(/CLOUDFLARE_API_TOKEN/g) ?? [])).toHaveLength(2)
    expect((workflow.match(/CLOUDFLARE_ACCOUNT_ID/g) ?? [])).toHaveLength(2)
    expect(workflow).not.toMatch(/TDX_CLIENT|R2_ACCESS_KEY|wrangler|deploy|migrations apply/i)

    const d1StepStart = workflow.indexOf('- name: Diagnose read-only D1 route catalogue state')
    const httpStepStart = workflow.indexOf('- name: Diagnose bounded production route metadata')
    const d1Step = workflow.slice(d1StepStart, httpStepStart)
    expect(d1Step).toContain('CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}')
    expect(d1Step).toContain('CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}')
    expect(workflow.slice(httpStepStart)).not.toMatch(/CLOUDFLARE_API_TOKEN|CLOUDFLARE_ACCOUNT_ID/)
  })
})

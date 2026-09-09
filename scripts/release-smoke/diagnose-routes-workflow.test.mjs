import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const workflow = readFileSync('.github/workflows/release-routes-diagnostic.yml', 'utf8')
const diagnostic = readFileSync('scripts/release-smoke/diagnose-routes.mjs', 'utf8')

describe('release routes diagnostic workflow', () => {
  it('compiles the production instance before loading operational resources', () => {
    const compile = workflow.indexOf('node scripts/instance/compile-config.mjs')
    const diagnose = workflow.indexOf('node scripts/release-smoke/diagnose-routes.mjs')

    expect(compile).toBeGreaterThan(-1)
    expect(diagnose).toBeGreaterThan(compile)
    expect(diagnostic).toContain("import { loadOperationalResources } from '../instance/operational-resources.mjs'")
    expect(diagnostic).toContain('resolveDiagnosticTargets(loadOperationalResources({ env }))')
    expect(diagnostic).not.toContain("readFile(configPath, 'utf8')")
  })

  it('keeps the diagnostic read-only and credential-free', () => {
    expect(workflow).toContain('permissions:\n  contents: read')
    expect(workflow).not.toMatch(/TDX_CLIENT|CLOUDFLARE_API_TOKEN|R2_ACCESS_KEY|wrangler|deploy|migrations apply/i)
  })
})

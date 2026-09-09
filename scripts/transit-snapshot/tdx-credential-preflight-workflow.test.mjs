import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const workflow = readFileSync(
  new URL('../../.github/workflows/tdx-credential-preflight.yml', import.meta.url),
  'utf8',
)

describe('TDX credential preflight workflow', () => {
  it('is manual-only and runs only from the default branch', () => {
    expect(workflow).toContain('workflow_dispatch:')
    expect(workflow).toContain("if: github.ref == format('refs/heads/{0}', github.event.repository.default_branch)")
    expect(workflow).toContain('ref: ${{ github.event.repository.default_branch }}')
    expect(workflow).not.toMatch(/\n\s+push:/)
    expect(workflow).not.toMatch(/\n\s+pull_request:/)
    expect(workflow).not.toContain('schedule:')
  })

  it('uses only the configured TDX client secrets and no Cloudflare authority', () => {
    expect(workflow).toContain('TDX_CLIENT_ID: ${{ secrets.TDX_CLIENT_ID }}')
    expect(workflow).toContain('TDX_CLIENT_SECRET: ${{ secrets.TDX_CLIENT_SECRET }}')
    expect(workflow).not.toContain('CLOUDFLARE_')
    expect(workflow).not.toContain('R2_ACCESS_KEY_ID')
    expect(workflow).not.toContain('R2_SECRET_ACCESS_KEY')
    expect(workflow).not.toContain('TRANSIT_DATABASE_ID')
    expect(workflow).not.toContain('TRANSIT_R2_BUCKET_NAME')
  })

  it('only runs the credential-only command and does not publish or persist evidence artifacts', () => {
    expect(workflow).toContain('npm run snapshot:tdx-preflight')
    expect(workflow).not.toContain('snapshot:city')
    expect(workflow).not.toContain('snapshot:window')
    expect(workflow).not.toContain('wrangler')
    expect(workflow).not.toContain('upload-artifact')
    expect(workflow).not.toContain('download-artifact')
  })
})

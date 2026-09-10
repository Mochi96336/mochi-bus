import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const workflow = readFileSync(
  new URL('../../.github/workflows/snapshot-worker-resource-measurement.yml', import.meta.url),
  'utf8',
)

describe('snapshot Worker resource measurement workflow', () => {
  it('is manual-only, main-only, and requires explicit confirmation', () => {
    expect(workflow).toContain('workflow_dispatch:')
    expect(workflow).toContain('confirmation:')
    expect(workflow).toContain("test \"${GITHUB_REF}\" = 'refs/heads/main'")
    expect(workflow).toContain("test \"${INPUT_CONFIRMATION}\" = 'MEASURE_RESOURCES'")
    expect(workflow).not.toMatch(/\n\s+push:/)
    expect(workflow).not.toContain('schedule:')
  })

  it('serializes with snapshot mutation and fixes the three acceptance cities', () => {
    expect(workflow).toContain('group: transit-snapshot')
    expect(workflow).toContain('assert-operation-city.mjs Taipei')
    expect(workflow).toContain('assert-operation-city.mjs NewTaipei')
    expect(workflow).toContain('assert-operation-city.mjs Taichung')
  })

  it('fails before build or deployment when the dedicated Analytics token is missing', () => {
    const validate = workflow.indexOf('name: Validate manual measurement scope')
    const build = workflow.indexOf('name: Build production bundle')
    const measure = workflow.indexOf('name: Measure direct and transfer Worker resources')
    expect(validate).toBeGreaterThan(0)
    expect(build).toBeGreaterThan(validate)
    expect(measure).toBeGreaterThan(build)
    expect(workflow.slice(validate, build)).toContain('CLOUDFLARE_ANALYTICS_API_TOKEN: ${{ secrets.CLOUDFLARE_ANALYTICS_API_TOKEN }}')
    expect(workflow.slice(validate, build)).toContain('test -n "${CLOUDFLARE_ANALYTICS_API_TOKEN}"')
  })

  it('builds the production bundle and uses production D1/R2 resources without TDX credentials', () => {
    expect(workflow).toContain('npm run build:map')
    expect(workflow).toContain('TRANSIT_DATABASE_ID: ${{ steps.operation.outputs.d1_database_id }}')
    expect(workflow).toContain('TRANSIT_R2_BUCKET_NAME: ${{ steps.operation.outputs.r2_bucket_name }}')
    expect(workflow).toContain('CLOUDFLARE_DEPLOY_API_TOKEN: ${{ secrets.CLOUDFLARE_DEPLOY_API_TOKEN }}')
    expect(workflow).toContain('CLOUDFLARE_ANALYTICS_API_TOKEN: ${{ secrets.CLOUDFLARE_ANALYTICS_API_TOKEN }}')
    expect(workflow).toContain('R2_ACCESS_KEY_ID: ${{ secrets.R2_ACCESS_KEY_ID }}')
    expect(workflow).toContain('R2_SECRET_ACCESS_KEY: ${{ secrets.R2_SECRET_ACCESS_KEY }}')
    expect(workflow).not.toContain('TDX_CLIENT_ID')
    expect(workflow).not.toContain('TDX_CLIENT_SECRET')
  })

  it('has an always-run fallback Worker cleanup before artifact upload', () => {
    const cleanup = workflow.indexOf('name: Cleanup temporary measurement Workers')
    const upload = workflow.indexOf('name: Upload Worker resource evidence')
    expect(cleanup).toBeGreaterThan(0)
    expect(upload).toBeGreaterThan(cleanup)
    expect(workflow.slice(cleanup, upload)).toContain('if: always()')
    expect(workflow.slice(cleanup, upload)).toContain('--cleanup-registry')
  })

  it('uploads only bounded report evidence and then removes the workspace', () => {
    expect(workflow).toContain('worker-resource-measurement.json')
    expect(workflow).toContain('actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02')
    expect(workflow).toContain('retention-days: 14')
    expect(workflow).toContain('if-no-files-found: warn')
    expect(workflow).toContain('rm -rf "${RESOURCE_MEASUREMENT_ROOT}"')
  })
})

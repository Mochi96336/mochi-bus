import { readFile } from 'node:fs/promises'
import { describe, expect, test } from 'vitest'

const workflowUrl = new URL('../../.github/workflows/review-instance-bundle.yml', import.meta.url)
const runnerUrl = new URL('./review-bundle-workflow.mjs', import.meta.url)
const documentationUrl = new URL('../../docs/INSTANCE_BUNDLE_REVIEW_WORKFLOW.md', import.meta.url)

async function source(url) {
  return readFile(url, 'utf8')
}

describe('manual instance bundle review workflow contracts', () => {
  test('is manual-only with read-only repository permissions', async () => {
    const workflow = await source(workflowUrl)
    expect(workflow).toMatch(/\bon:\n  workflow_dispatch:/)
    expect(workflow).not.toMatch(/^  (push|pull_request|pull_request_target|schedule|issue_comment|workflow_run):/m)
    expect(workflow).toMatch(/permissions:\n  contents: read\n/)
    expect(workflow).not.toMatch(/permissions:[\s\S]*\bwrite\b/)
    expect(workflow).toContain('Type REVIEW')
  })

  test('pins actions and uploads only the verified evidence directory', async () => {
    const workflow = await source(workflowUrl)
    expect(workflow).toContain('actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0')
    expect(workflow).toContain('actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e')
    expect(workflow).toContain('actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02')
    expect(workflow).toContain('path: ${{ steps.review.outputs.artifact_directory }}')
    expect(workflow).toContain('if-no-files-found: error')
    expect(workflow).toContain('retention-days: 14')
    expect(workflow).toContain('compression-level: 9')
    expect(workflow).toContain('include-hidden-files: true')
  })

  test('does not expose secrets, install hooks or deployment commands', async () => {
    const workflow = await source(workflowUrl)
    expect(workflow).not.toContain('secrets.')
    expect(workflow).not.toMatch(/\bnpm\s+(ci|install)\b/)
    expect(workflow).not.toMatch(/\b(wrangler|curl|wget|gh|git push)\b/)
    expect(workflow).not.toContain('--write')
    expect(workflow).toContain('node scripts/instance/review-bundle-workflow.mjs')
  })

  test('runner constructs argv without subprocess or network access', async () => {
    const runner = await source(runnerUrl)
    expect(runner).not.toMatch(/node:child_process|\bexec(File|Sync)?\b|\bspawn(Sync)?\b/)
    expect(runner).not.toMatch(/node:https|node:http|undici|\bfetch\s*\(/)
    expect(runner).toContain("'--write'")
    expect(runner).toContain("'--config'")
    expect(runner).toContain("'--output'")
    expect(runner).toContain('parseStrictJson')
    expect(runner).toContain('writeInstanceBundleArtifact')
    expect(runner).toContain('verifyInstanceBundleFile')
    expect(runner).toContain("open(path, 'wx', 0o600)")
  })

  test('documentation keeps review evidence separate from apply and deploy', async () => {
    const documentation = await source(documentationUrl)
    expect(documentation).toContain('workflow_dispatch')
    expect(documentation).toContain('changes_json')
    expect(documentation).toContain('bundle.json')
    expect(documentation).toContain('verification.json')
    expect(documentation).toContain('does not apply')
    expect(documentation).toContain('instance:update --write')
    expect(documentation).toContain('No repository secret')
  })
})

import { readFile } from 'node:fs/promises'
import { describe, expect, test } from 'vitest'

const workflowUrl = new URL('../../.github/workflows/apply-instance-bundle-pr.yml', import.meta.url)

describe('apply target policy workflow contract', () => {
  test('runs after exact artifact download and before any manifest write', async () => {
    const workflow = await readFile(workflowUrl, 'utf8')
    const download = workflow.indexOf('      - name: Download exact review evidence')
    const policy = workflow.indexOf('      - name: Enforce default-branch apply policy')
    const apply = workflow.indexOf('      - name: Atomically apply and verify reviewed manifest')

    expect(download).toBeGreaterThan(-1)
    expect(policy).toBeGreaterThan(download)
    expect(apply).toBeGreaterThan(policy)

    const policyStep = workflow.slice(policy, apply)
    expect(policyStep).toContain('GITHUB_DEFAULT_BRANCH: ${{ github.event.repository.default_branch }}')
    expect(policyStep).toContain('node scripts/instance/check-apply-target-policy.mjs')
  })
})

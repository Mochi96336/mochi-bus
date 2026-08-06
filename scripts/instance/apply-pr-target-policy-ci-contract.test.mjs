import { readFile } from 'node:fs/promises'
import { describe, expect, test } from 'vitest'

const ciWorkflowUrl = new URL('../../.github/workflows/ci.yml', import.meta.url)
const policyWorkflowUrl = new URL('../../.github/workflows/instance-apply-target-policy.yml', import.meta.url)

describe('generated apply PR target policy workflow contract', () => {
  test('uses a dedicated PR-only workflow that cannot be replaced by a skipped manual CI check', async () => {
    const [ciWorkflow, policyWorkflow] = await Promise.all([
      readFile(ciWorkflowUrl, 'utf8'),
      readFile(policyWorkflowUrl, 'utf8'),
    ])

    expect(ciWorkflow).toContain('  workflow_dispatch:')
    expect(ciWorkflow).not.toContain('Instance apply target policy')
    expect(policyWorkflow).toContain('name: Instance apply target policy')
    expect(policyWorkflow).toContain('types: [opened, reopened, synchronize, edited, ready_for_review]')
    expect(policyWorkflow).toContain('pull-requests: read')
    expect(policyWorkflow).not.toContain('workflow_dispatch')
    expect(policyWorkflow).not.toContain('if: github.event_name')
  })

  test('reads only API metadata and fails closed on repository, rename, status and path drift', async () => {
    const workflow = await readFile(policyWorkflowUrl, 'utf8')
    expect(workflow).toContain('actions/github-script@3a2844b7e9c422d3c10d287c895573f7108da1b3')
    expect(workflow).toContain('pr.head.repo.full_name !== repository.full_name')
    expect(workflow).toContain("file.status !== 'modified'")
    expect(workflow).toContain('file.previous_filename')
    expect(workflow).toContain("configPath === 'instance.json'")
    expect(workflow).toContain("configPath.startsWith('instances/') && configPath.endsWith('.json')")
    expect(workflow).toContain('const generatedHead = /^agent')
    expect(workflow).toContain('instance-bundle-apply-')
    expect(workflow).toContain('const e2eBase = /^e2e')
    expect(workflow).toContain('instances/starter-chiayi.example.json')
    expect(workflow).not.toContain('actions/checkout')
    expect(workflow).not.toContain('run:')
  })
})

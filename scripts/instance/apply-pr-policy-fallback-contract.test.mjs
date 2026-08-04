import { readFile } from 'node:fs/promises'
import { describe, expect, test } from 'vitest'

const workflowUrl = new URL('../../.github/workflows/apply-instance-bundle-pr.yml', import.meta.url)

describe('apply Draft PR creation policy fallback', () => {
  test('accepts only the exact repository-policy denial and preserves other failures', async () => {
    const workflow = await readFile(workflowUrl, 'utf8')
    const stepStart = workflow.indexOf('      - name: Open Draft PR against the selected source branch')
    expect(stepStart).toBeGreaterThan(-1)
    const step = workflow.slice(stepStart)

    expect(step).toContain("GitHub Actions is not permitted to create or approve pull requests")
    expect(step).toContain('pr_creation_status=external_required')
    expect(step).toContain('pr_creation_status=created')
    expect(step).toContain('exit "${pr_status}"')
    expect(step).not.toContain('continue-on-error: true')
  })
})

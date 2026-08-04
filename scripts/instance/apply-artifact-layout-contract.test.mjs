import { readFile } from 'node:fs/promises'
import { describe, expect, test } from 'vitest'

const workflowUrl = new URL('../../.github/workflows/apply-instance-bundle-pr.yml', import.meta.url)

describe('apply evidence artifact layout', () => {
  test('matches the exact root consumed by verify and reconcile', async () => {
    const workflow = await readFile(workflowUrl, 'utf8')
    const uploadStart = workflow.indexOf('      - name: Upload apply evidence')
    const uploadEnd = workflow.indexOf('      - name: Commit only the reviewed manifest', uploadStart)
    expect(uploadStart).toBeGreaterThan(-1)
    expect(uploadEnd).toBeGreaterThan(uploadStart)

    const upload = workflow.slice(uploadStart, uploadEnd)
    expect(upload).toContain('.generated/apply-input')
    expect(upload).toContain('.generated/apply-pr')
    expect(upload).not.toContain('.generated/apply-review-run.json')
  })
})

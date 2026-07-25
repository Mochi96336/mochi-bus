import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const workflowPath = '.github/workflows/inspect-shape-pattern-ambiguity.yml'

describe('credentialed Shape ambiguity viewer workflow', () => {
  it('is manual, main-only, bounded, and uploads no raw TDX cache', async () => {
    const workflow = await readFile(workflowPath, 'utf8')
    const runner = 'scripts/shape-pattern-measurement/run-ambiguity-viewer.mjs'

    expect(workflow).toContain('workflow_dispatch:')
    expect(workflow).not.toMatch(/^\s*(?:push|pull_request|schedule):/m)
    expect(workflow).toContain("[[ \"${GITHUB_REF}\" == \"refs/heads/main\" ]]")
    expect(workflow).toContain("[[ \"${INPUT_CONFIRMATION}\" == \"INSPECT\" ]]")
    expect(workflow).toContain('TDX_CLIENT_ID: ${{ secrets.TDX_CLIENT_ID }}')
    expect(workflow).toContain('TDX_CLIENT_SECRET: ${{ secrets.TDX_CLIENT_SECRET }}')
    expect(workflow).toContain('scripts/shape-pattern-measurement/acquire-raw.mjs')
    expect(workflow).toContain('unset TDX_CLIENT_ID TDX_CLIENT_SECRET')
    expect(workflow).toContain(runner)
    expect(workflow.indexOf('unset TDX_CLIENT_ID TDX_CLIENT_SECRET'))
      .toBeLessThan(workflow.indexOf(runner))
    expect(workflow).toContain('test ! -e "${artifact_dir}/raw"')
    expect(workflow).toContain('rm -rf "${raw_dir}"')
    expect(workflow).toContain('retention-days: 14')
    expect(workflow).toContain('if: always()')
    expect(workflow).not.toContain('shape-pattern-matcher.ts')
    expect(workflow).not.toContain('scripts/shape-pattern-measurement/run.mjs')
  })
})

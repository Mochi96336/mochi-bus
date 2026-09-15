import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const workflow = readFileSync('.github/workflows/snapshot-full-week-d1-acceptance.yml', 'utf8')

describe('full-week observed D1 acceptance workflow', () => {
  it('is manual-only and read-only', () => {
    expect(workflow).toContain('workflow_dispatch:')
    expect(workflow).not.toContain('\n  schedule:')
    expect(workflow).not.toContain('\n  push:')
    expect(workflow).not.toContain('\n  pull_request:')
    expect(workflow).toContain('actions: read')
    expect(workflow).toContain('contents: read')
    expect(workflow).not.toMatch(/(?:actions|contents|deployments|id-token|issues|packages|pull-requests|security-events|statuses): write/)
  })

  it('requires exactly seven unique numeric scheduled Sync run IDs', () => {
    expect(workflow).toContain("if [ \"${#run_ids[@]}\" -ne 7 ]; then")
    expect(workflow).toContain('Duplicate workflow run ID: $run_id')
    expect(workflow).toContain('[[ "$run_id" =~ ^[1-9][0-9]*$ ]]')
    expect(workflow).toContain('test "$event" = \'schedule\'')
    expect(workflow).toContain('test "$head_branch" = \'main\'')
    expect(workflow).toContain('test "$workflow_path" = \'.github/workflows/sync-transit.yml\'')
    expect(workflow).toContain('test "$status" = \'completed\'')
    expect(workflow).toContain('test "$conclusion" = \'success\'')
  })

  it('binds each download to the exact latest-attempt live daily evidence artifact', () => {
    expect(workflow).toContain("head_sha=\"$(jq -r '.head_sha' <<< \"$metadata\")\"")
    expect(workflow).toContain("run_attempt=\"$(jq -r '.run_attempt' <<< \"$metadata\")\"")
    expect(workflow).toContain('[[ "$head_sha" =~ ^[a-f0-9]{40}$ ]]')
    expect(workflow).toContain('artifact_name="snapshot-scheduled-d1-write-${run_id}-${run_attempt}"')
    expect(workflow).toContain('select(.expired == false)')
    expect(workflow).toContain('Expected exactly one live $artifact_name artifact')
    expect(workflow).toContain('gh run download "$run_id" --repo "$GITHUB_REPOSITORY" --name "$artifact_name"')
    expect(workflow).toContain('snapshot-scheduled-d1-write-evidence.json')
  })

  it('rejects a daily artifact whose embedded provenance disagrees with GitHub run metadata', () => {
    expect(workflow).toContain("evidence_run_id=\"$(jq -r '.workflowRunId' \"$evidence_file\")\"")
    expect(workflow).toContain("evidence_run_attempt=\"$(jq -r '.workflowRunAttempt' \"$evidence_file\")\"")
    expect(workflow).toContain("evidence_git_sha=\"$(jq -r '.scriptGitSha' \"$evidence_file\")\"")
    expect(workflow).toContain('[ "$evidence_run_id" != "$run_id" ]')
    expect(workflow).toContain('[ "$evidence_run_attempt" != "$run_attempt" ]')
    expect(workflow).toContain('[ "$evidence_git_sha" != "$head_sha" ]')
    expect(workflow).toContain('Scheduled D1 evidence provenance mismatch for run $run_id')
  })

  it('uses the offline validator and fails closed unless the real weekly gate is true', () => {
    expect(workflow).toContain('summarize-full-weekly-d1-write-acceptance.mjs')
    expect(workflow).toContain('evidence.fullWeeklyShardAcceptance !== true')
    expect(workflow).toContain('process.exit(1)')
    expect(workflow).toContain('snapshot-full-week-d1-acceptance-${{ github.run_id }}-${{ github.run_attempt }}')
    expect(workflow).toContain('retention-days: 14')
  })

  it('has no production credential, dispatch, or mutation surface', () => {
    for (const forbidden of [
      'secrets.',
      'TDX_CLIENT_ID',
      'TDX_CLIENT_SECRET',
      'CLOUDFLARE_API_TOKEN',
      'CLOUDFLARE_ACCOUNT_ID',
      'R2_ACCESS_KEY_ID',
      'R2_SECRET_ACCESS_KEY',
      'wrangler',
      'snapshot:window',
      'force_publish',
      'gh workflow run',
      '--method',
    ]) {
      expect(workflow).not.toContain(forbidden)
    }
  })
})

import { readFile } from 'node:fs/promises'
import { describe, expect, test } from 'vitest'

const workflowUrl = new URL('../../.github/workflows/reconcile-instance-bundle-apply-merge.yml', import.meta.url)
const runnerUrl = new URL('./reconcile-apply-merge.mjs', import.meta.url)
const testsUrl = new URL('./reconcile-apply-merge.test.mjs', import.meta.url)
const packageUrl = new URL('../../package.json', import.meta.url)
const documentationUrl = new URL('../../docs/INSTANCE_BUNDLE_APPLY_MERGE_RECONCILIATION.md', import.meta.url)

async function source(url) {
  return readFile(url, 'utf8')
}

describe('merged reviewed bundle reconciliation contracts', () => {
  test('exposes one explicit package command and manual workflow', async () => {
    const [packageSource, workflow] = await Promise.all([source(packageUrl), source(workflowUrl)])
    expect(packageSource).toContain('"instance:reconcile-apply-merge": "node scripts/instance/reconcile-apply-merge.mjs"')
    expect(workflow).toContain('name: Reconcile merged reviewed instance bundle PR')
    expect(workflow).toContain('workflow_dispatch:')
    expect(workflow).toContain('Type RECONCILE')
    expect(workflow).not.toContain('schedule:')
    expect(workflow).not.toContain('pull_request:')
  })

  test('keeps repository and GitHub permissions read-only', async () => {
    const workflow = await source(workflowUrl)
    expect(workflow).toContain('permissions:\n  actions: read\n  contents: read\n  pull-requests: read')
    expect(workflow).not.toMatch(/contents:\s*write|pull-requests:\s*write|actions:\s*write|checks:\s*write|statuses:\s*write/)
    expect(workflow).not.toMatch(/issues:\s*write|deployments:\s*write|id-token:\s*write/)
    expect(workflow).toContain('persist-credentials: false')
  })

  test('pins every external action and preserves the trust ordering', async () => {
    const workflow = await source(workflowUrl)
    expect(workflow).toContain('actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0')
    expect(workflow).toContain('actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e')
    expect(workflow).toContain('actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c')
    expect(workflow).toContain('actions/github-script@3a2844b7e9c422d3c10d287c895573f7108da1b3')
    expect(workflow).toContain('actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02')
    const preflight = workflow.indexOf('--preflight')
    const download = workflow.indexOf('Download exact apply evidence')
    const prepare = workflow.indexOf('--prepare')
    const collect = workflow.indexOf('Collect immutable merged-PR')
    const compile = workflow.indexOf('Compile current manifest into isolated evidence')
    const reconcile = workflow.indexOf('--reconcile')
    expect(preflight).toBeGreaterThan(0)
    expect(download).toBeGreaterThan(preflight)
    expect(prepare).toBeGreaterThan(download)
    expect(collect).toBeGreaterThan(prepare)
    expect(compile).toBeGreaterThan(collect)
    expect(reconcile).toBeGreaterThan(compile)
  })

  test('allows only read APIs and never changes PR, branch, workflow or deployment state', async () => {
    const workflow = await source(workflowUrl)
    expect(workflow).toContain('github.rest.pulls.get')
    expect(workflow).toContain('github.rest.pulls.listFiles')
    expect(workflow).toContain('github.rest.pulls.listCommits')
    expect(workflow).toContain('github.rest.repos.getCommit')
    expect(workflow).toContain('github.rest.repos.getBranch')
    expect(workflow).toContain('github.rest.repos.compareCommitsWithBasehead')
    expect(workflow).toContain('github.rest.repos.getContent')
    expect(workflow).toContain('github.rest.actions.getWorkflowRun')
    expect(workflow).not.toMatch(/pulls\.(?:create|update|merge)|git\.updateRef|repos\.createCommit|issues\.createComment|actions\.createWorkflowDispatch/)
    expect(workflow).not.toMatch(/markPullRequestReadyForReview|enablePullRequestAutoMerge|createDeployment/)
  })

  test('confines all writes to generated evidence and never runs deployment tooling', async () => {
    const [workflow, runner] = await Promise.all([source(workflowUrl), source(runnerUrl)])
    expect(workflow).toContain('.generated/reconcile-apply-merge/download')
    expect(workflow).toContain('.generated/reconcile-apply-merge/github')
    expect(workflow).toContain('.generated/reconcile-apply-merge/compiled')
    expect(workflow).toContain('.generated/reconcile-apply-merge/result')
    expect(workflow).not.toMatch(/\bwrangler\b|npm run deploy|npm run release:smoke|--remote/)
    expect(workflow).not.toContain('secrets.')
    expect(runner).toContain("const RESULT_DIRECTORY = '.generated/reconcile-apply-merge/result'")
    expect(runner).toContain('Reconciliation output must stay inside .generated')
    expect(runner).not.toContain('node:child_process')
    expect(runner).not.toMatch(/node:https|node:http|undici/)
    expect(runner).toContain("throw new Error('Remote access is disabled during apply-merge reconciliation')")
  })

  test('binds artifact, merged PR, branch ancestry, exact target bytes and generated hashes', async () => {
    const runner = await source(runnerUrl)
    expect(runner).toContain('prepareInstanceBundleApplyPrVerification')
    expect(runner).toContain("check('pr-merged'")
    expect(runner).toContain("check('merge-ancestry'")
    expect(runner).toContain("check('merge-preserved-target-bytes'")
    expect(runner).toContain("check('current-preserved-target-bytes'")
    expect(runner).toContain("check('generated-manifest-hash'")
    expect(runner).toContain("check('generated-set-hash'")
    expect(runner).toContain('hashCanonical(config)')
    expect(runner).toContain('rebaseWranglerConfig')
  })

  test('keeps content reconciliation, local doctor and deployment readiness separate', async () => {
    const [runner, tests] = await Promise.all([source(runnerUrl), source(testsUrl)])
    expect(runner).toContain("'locally_blocked'")
    expect(runner).toContain('contentReconciled')
    expect(runner).toContain('localDoctorReady')
    expect(runner).toContain('remoteVerified: false')
    expect(runner).toContain('deploymentReady: false')
    expect(runner).toContain("doctor?.remote?.requested === false && doctor?.remote?.status === 'not_checked'")
    expect(tests).toContain("expect(report.status).toBe('locally_blocked')")
    expect(tests).toContain('expect(report.deploymentReady).toBe(false)')
  })

  test('documents branch advancement, local blockers and the no-deployment boundary', async () => {
    const documentation = await source(documentationUrl)
    expect(documentation).toContain('reconciled')
    expect(documentation).toContain('locally_blocked')
    expect(documentation).toContain('blocked')
    expect(documentation).toContain('commits after merge')
    expect(documentation).toContain('exact manifest bytes')
    expect(documentation).toContain('does not contact Cloudflare')
    expect(documentation).toContain('does not claim deployment readiness')
  })
})

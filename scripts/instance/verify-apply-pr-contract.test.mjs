import { readFile } from 'node:fs/promises'
import { describe, expect, test } from 'vitest'

const workflowPath = new URL('../../.github/workflows/verify-instance-bundle-apply-pr.yml', import.meta.url)
const runnerPath = new URL('./verify-apply-pr.mjs', import.meta.url)
const testPath = new URL('./verify-apply-pr.test.mjs', import.meta.url)
const docPath = new URL('../../docs/INSTANCE_BUNDLE_APPLY_PR_VERIFICATION.md', import.meta.url)
const applyDocPath = new URL('../../docs/INSTANCE_BUNDLE_APPLY_PR_WORKFLOW.md', import.meta.url)
const packagePath = new URL('../../package.json', import.meta.url)

async function sources() {
  const [workflow, runner, behavior, docs, applyDocs, packageSource] = await Promise.all([
    readFile(workflowPath, 'utf8'),
    readFile(runnerPath, 'utf8'),
    readFile(testPath, 'utf8'),
    readFile(docPath, 'utf8'),
    readFile(applyDocPath, 'utf8'),
    readFile(packagePath, 'utf8'),
  ])
  return { workflow, runner, behavior, docs, applyDocs, packageSource }
}

describe('generated apply PR verification repository contracts', () => {
  test('is manual-only with exact read permissions and no write permission', async () => {
    const { workflow } = await sources()
    expect(workflow).toContain('workflow_dispatch:')
    expect(workflow).not.toMatch(/^\s*(pull_request|push|schedule):/m)
    expect(workflow).toContain('actions: read')
    expect(workflow).toContain('contents: read')
    expect(workflow).toContain('pull-requests: read')
    expect(workflow).not.toContain('checks: read')
    expect(workflow).not.toContain('statuses: read')
    expect(workflow).not.toMatch(/^\s+[a-z-]+:\s*write\s*$/m)
  })

  test('validates before download, validates evidence before API reads and verifies last', async () => {
    const { workflow } = await sources()
    const preflight = workflow.indexOf('Validate immutable verification inputs')
    const download = workflow.indexOf('Download exact apply evidence')
    const prepare = workflow.indexOf('Verify persisted apply evidence before GitHub API reads')
    const collect = workflow.indexOf('Collect immutable PR, run, commit, manifest and CI evidence')
    const verify = workflow.indexOf('Cross-check generated Draft PR against reviewed evidence')
    expect(preflight).toBeGreaterThan(0)
    expect(preflight).toBeLessThan(download)
    expect(download).toBeLessThan(prepare)
    expect(prepare).toBeLessThan(collect)
    expect(collect).toBeLessThan(verify)
    expect(workflow).toContain('digest-mismatch: error')
  })

  test('pins every external action to a full commit SHA', async () => {
    const { workflow } = await sources()
    const uses = [...workflow.matchAll(/^\s*-?\s*uses:\s*([^\s#]+)/gm)].map((match) => match[1])
    expect(uses.length).toBeGreaterThanOrEqual(5)
    for (const value of uses) expect(value).toMatch(/^[^@]+@[a-f0-9]{40}$/)
    expect(workflow).toContain('actions/github-script@3a2844b7e9c422d3c10d287c895573f7108da1b3')
  })

  test('uses only read-oriented GitHub API methods and never mutates PR or CI state', async () => {
    const { workflow } = await sources()
    expect(workflow).toContain('github.rest.pulls.get')
    expect(workflow).toContain('github.rest.pulls.listFiles')
    expect(workflow).toContain('github.rest.pulls.listCommits')
    expect(workflow).toContain('github.rest.actions.getWorkflow')
    expect(workflow).toContain('github.rest.actions.getWorkflowRun')
    expect(workflow).toContain('github.rest.actions.listWorkflowRuns')
    expect(workflow).toContain('github.rest.repos.getContent')
    expect(workflow).not.toContain('github.rest.checks.listForRef')
    expect(workflow).not.toContain('github.rest.repos.listCommitStatusesForRef')
    for (const forbidden of [
      'createComment',
      'createReview',
      'createDispatch',
      'merge(',
      'pulls.update',
      'issues.update',
      'git.updateRef',
      'gh pr',
      'git push',
    ]) expect(workflow).not.toContain(forbidden)
  })

  test('binds review, apply and formal CI observations to exact workflow identities', async () => {
    const { workflow, docs } = await sources()
    expect(workflow).toContain("const applyWorkflowPath = '.github/workflows/apply-instance-bundle-pr.yml'")
    expect(workflow).toContain("const reviewWorkflowPath = '.github/workflows/review-instance-bundle.yml'")
    expect(workflow).toContain("const ciWorkflowPath = '.github/workflows/ci.yml'")
    expect(workflow).toContain('run.workflow_id !== workflow.id || workflowFilePath(run) !== workflowPath')
    expect(workflow).toContain('run.head_repository?.full_name !== repository')
    expect(workflow).toContain('run.workflow_id === ciWorkflow.id && workflowFilePath(run) === ciWorkflowPath && run.head_sha === prStart.head.sha')
    expect(workflow).toContain("name: `workflow:${ciWorkflowPath}`")
    expect(workflow).not.toContain("item?.name !== 'verify-apply-pr'")
    expect(docs).toContain('exact `.github/workflows/ci.yml` workflow')
    expect(docs).toContain('workflow ID and path')
  })

  test('does not treat asynchronous mergeability calculation as PR metadata mutation', async () => {
    const { workflow, docs } = await sources()
    expect(workflow).toContain('const normalizePrIdentity = (pr) => {')
    expect(workflow).toContain('const { mergeable: _mergeable, ...identity } = normalizePr(pr)')
    expect(workflow).toContain("'pull-request.json': normalizePr(prEnd)")
    expect(docs).toContain('Mergeability is sampled after the immutable identity comparison')
  })

  test('keeps the offline runner free of subprocess and network clients', async () => {
    const { runner } = await sources()
    for (const forbidden of [
      "node:child_process",
      "'child_process'",
      'spawn(',
      'execFile(',
      'execSync(',
      "node:http",
      "node:https",
      'fetch(',
      'undici',
      'octokit',
    ]) expect(runner).not.toContain(forbidden)
    expect(runner).toContain("verifyInstanceBundleArtifact")
    expect(runner).toContain("readGithubEvidence")
  })

  test('locks Draft state, base and head SHAs, one commit and one modified manifest', async () => {
    const { runner, behavior } = await sources()
    for (const contract of [
      "check('pr-draft'",
      "check('base-sha'",
      "check('head-sha'",
      "check('single-changed-file-count'",
      "check('single-commit-count'",
      "check('single-modified-manifest'",
      "check('head-parent'",
      "check('head-manifest-target'",
    ]) expect(runner).toContain(contract)
    expect(behavior).toContain("['advanced base'")
    expect(behavior).toContain("['extra changed file'")
    expect(behavior).toContain("['extra commit'")
    expect(behavior).toContain('head manifest whose canonical target hash differs')
  })

  test('keeps CI observation separate from identity verification and does not claim automatic readiness', async () => {
    const { runner, workflow, docs } = await sources()
    expect(runner).toContain("total === 0 ? 'missing'")
    expect(runner).toContain('readyForReviewTransition')
    expect(runner).toContain('Dispatch the existing CI workflow')
    expect(workflow).toContain("const formalCiState = formalCiRun === null")
    expect(workflow).toContain("formalCiRun.conclusion === 'success'")
    expect(docs).toContain('Identity verification and CI readiness are separate')
    expect(docs).toContain('never dispatches CI or changes Draft state')
    expect(docs).toContain('may not automatically trigger `pull_request` workflows')
  })

  test('registers the command and cross-links operator documentation', async () => {
    const { packageSource, docs, applyDocs } = await sources()
    const pkg = JSON.parse(packageSource)
    expect(pkg.scripts['instance:verify-apply-pr']).toBe('node scripts/instance/verify-apply-pr.mjs')
    expect(docs).toContain('Verify a generated reviewed-bundle Draft PR')
    expect(applyDocs).toContain('INSTANCE_BUNDLE_APPLY_PR_VERIFICATION.md')
    expect(applyDocs).toContain('instance:verify-apply-pr')
  })
})

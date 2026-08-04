import { readFile } from 'node:fs/promises'
import { describe, expect, test } from 'vitest'

const workflowUrl = new URL('../../.github/workflows/gate-reconciled-instance-release.yml', import.meta.url)
const runnerUrl = new URL('./release-attestation.mjs', import.meta.url)
const testsUrl = new URL('./release-attestation.test.mjs', import.meta.url)
const packageUrl = new URL('../../package.json', import.meta.url)
const documentationUrl = new URL('../../docs/INSTANCE_RELEASE_ATTESTATION.md', import.meta.url)

async function source(url) {
  return readFile(url, 'utf8')
}

describe('reconciled instance release attestation contracts', () => {
  test('exposes one package command and both manual and reusable workflow entrypoints', async () => {
    const [packageSource, workflow] = await Promise.all([source(packageUrl), source(workflowUrl)])
    expect(packageSource).toContain('"instance:release-attestation": "node scripts/instance/release-attestation.mjs"')
    expect(workflow).toContain('name: Gate reconciled instance release')
    expect(workflow).toContain('workflow_dispatch:')
    expect(workflow).toContain('workflow_call:')
    expect(workflow).toContain('Type ATTEST')
    expect(workflow).not.toContain('schedule:')
    expect(workflow).not.toContain('pull_request:')
  })

  test('keeps the reusable release content gate read-only', async () => {
    const workflow = await source(workflowUrl)
    expect(workflow).toContain('permissions:\n  actions: read\n  contents: read')
    expect(workflow).not.toMatch(/contents:\s*write|actions:\s*write|pull-requests:\s*write|checks:\s*write|statuses:\s*write/)
    expect(workflow).not.toMatch(/deployments:\s*write|id-token:\s*write|packages:\s*write/)
    expect(workflow).toContain('persist-credentials: false')
    expect(workflow).not.toContain('secrets.')
  })

  test('pins actions and preserves preflight, download, run proof, attest and verify ordering', async () => {
    const workflow = await source(workflowUrl)
    expect(workflow).toContain('actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0')
    expect(workflow).toContain('actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e')
    expect(workflow).toContain('actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c')
    expect(workflow).toContain('actions/github-script@3a2844b7e9c422d3c10d287c895573f7108da1b3')
    expect(workflow).toContain('actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02')
    const preflight = workflow.indexOf('--preflight')
    const download = workflow.indexOf('Download exact reconciliation evidence')
    const collect = workflow.indexOf('Collect immutable reconciliation-run')
    const attest = workflow.indexOf('--attest')
    const verify = workflow.indexOf('--verify')
    const upload = workflow.indexOf('Upload release attestation evidence')
    expect(preflight).toBeGreaterThan(0)
    expect(download).toBeGreaterThan(preflight)
    expect(collect).toBeGreaterThan(download)
    expect(attest).toBeGreaterThan(collect)
    expect(verify).toBeGreaterThan(attest)
    expect(upload).toBeGreaterThan(verify)
  })

  test('uses only read APIs and proves the branch stayed on the release SHA', async () => {
    const workflow = await source(workflowUrl)
    expect(workflow).toContain('github.rest.actions.getWorkflowRun')
    expect(workflow).toContain('github.rest.repos.getBranch')
    expect(workflow).toContain('Release branch moved before gate evidence collection')
    expect(workflow).toContain('Release branch moved while gate evidence was collected')
    expect(workflow).not.toMatch(/pulls\.(?:create|update|merge)|git\.updateRef|repos\.createCommit|issues\.createComment|actions\.createWorkflowDispatch/)
    expect(workflow).not.toMatch(/createDeployment|markPullRequestReadyForReview|enablePullRequestAutoMerge/)
  })

  test('confines writes to generated evidence and excludes deploy or remote tooling', async () => {
    const [workflow, runner] = await Promise.all([source(workflowUrl), source(runnerUrl)])
    expect(workflow).toContain('.generated/release-attestation/reconciliation')
    expect(workflow).toContain('.generated/release-attestation/run')
    expect(workflow).toContain('.generated/release-attestation/result')
    expect(workflow).not.toMatch(/\bwrangler\b|npm run deploy|npm run release:smoke|--remote/)
    expect(runner).toContain("const RESULT_DIRECTORY = '.generated/release-attestation/result'")
    expect(runner).toContain('Release attestation output must stay inside .generated')
    expect(runner).not.toContain('node:child_process')
    expect(runner).not.toMatch(/node:https|node:http|undici|fetch\s*\(/)
  })

  test('requires reconciled local-doctor-ready evidence and preserves the no-deployment boundary', async () => {
    const [runner, tests] = await Promise.all([source(runnerUrl), source(testsUrl)])
    expect(runner).toContain("reconciliation?.status === 'reconciled'")
    expect(runner).toContain('reconciliation?.localDoctorReady === true')
    expect(runner).toContain('releaseContentGatePassed: true')
    expect(runner).toContain('remoteVerified: false')
    expect(runner).toContain('deploymentReady: false')
    expect(runner).toContain("authorizes: 'release-content-gate-only'")
    expect(tests).toContain("status: 'locally_blocked'")
    expect(tests).toContain('expect(evaluation.attestation).toBe(null)')
  })

  test('binds exact release, manifest bytes, deterministic generated hashes and attestation integrity', async () => {
    const runner = await source(runnerUrl)
    expect(runner).toContain('expected_release_sha must equal the exact workflow release SHA')
    expect(runner).toContain("check('current-manifest-bytes'")
    expect(runner).toContain("check('current-generated-set'")
    expect(runner).toContain('manifestSourceHash')
    expect(runner).toContain('generatedSetHash')
    expect(runner).toContain('attestationHash: hashCanonical(payload)')
    expect(runner).toContain("check('trusted-attestation-hash'")
    expect(runner).toContain('current.source === attestation.evidence.manifestSource')
  })

  test('documents trusted-hash limits and the remaining live deployment checks', async () => {
    const documentation = await source(documentationUrl)
    expect(documentation).toContain('SHA-256 hash proves integrity, not signer identity')
    expect(documentation).toContain('workflow_call')
    expect(documentation).toContain('locally_blocked')
    expect(documentation).toContain('release-content-gate-only')
    expect(documentation).toContain('remote Cloudflare resource identity')
    expect(documentation).toContain('does not authorize deployment by itself')
  })
})

import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { hashCanonical } from './bundle-integrity.mjs'
import {
  parseInstanceBundleApplyPrWorkflowInputs,
  renderApplyPullRequestBody,
  runInstanceBundleApplyPrPreflight,
  runInstanceBundleApplyPrWorkflow,
} from './apply-bundle-pr-workflow.mjs'

const BUNDLE_HASH = 'a'.repeat(64)
const ARTIFACT_HASH = 'b'.repeat(64)
const SOURCE_SHA = 'c'.repeat(40)

function workflowEnv({ summaryPath = '/tmp/summary', outputPath = '/tmp/output', overrides = {} } = {}) {
  return {
    GITHUB_ACTIONS: 'true',
    GITHUB_REPOSITORY: 'Mochi96336/mochi-bus',
    GITHUB_REF: 'refs/heads/agent/source-stack',
    GITHUB_SHA: SOURCE_SHA,
    GITHUB_RUN_ID: '987654321',
    GITHUB_RUN_ATTEMPT: '2',
    GITHUB_STEP_SUMMARY: summaryPath,
    GITHUB_OUTPUT: outputPath,
    INPUT_CONFIRMATION: 'APPLY',
    INPUT_REVIEW_RUN_ID: '123456789',
    INPUT_ARTIFACT_NAME: 'instance-bundle-review-island-test-123456789-3',
    INPUT_EXPECTED_BUNDLE_HASH: BUNDLE_HASH,
    INPUT_EXPECTED_ARTIFACT_HASH: ARTIFACT_HASH,
    ...overrides,
  }
}

async function withWorkspace(run) {
  const cwd = await mkdtemp(join(tmpdir(), 'mochi-apply-pr-'))
  const evidenceDirectory = join(cwd, '.generated', 'apply-input')
  await mkdir(evidenceDirectory, { recursive: true })
  const summaryPath = join(cwd, 'summary.md')
  const outputPath = join(cwd, 'outputs.txt')
  await writeFile(summaryPath, '', 'utf8')
  await writeFile(outputPath, '', 'utf8')
  try {
    return await run({ cwd, evidenceDirectory, summaryPath, outputPath })
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
}

function targetFixture() {
  const manifest = { instanceId: 'island-test', site: { name: 'Island Transit' } }
  return { manifest, source: `${JSON.stringify(manifest, null, 2)}\n`, hash: hashCanonical(manifest) }
}

async function writeEvidence(directory, { verification = {}, freshness = {} } = {}) {
  const target = targetFixture()
  const verificationReport = {
    schemaVersion: 1,
    ok: true,
    instanceId: 'island-test',
    bundleHash: BUNDLE_HASH,
    artifactHash: ARTIFACT_HASH,
    expectedBundleHash: BUNDLE_HASH,
    expectedArtifactHash: ARTIFACT_HASH,
    summary: { passed: 20, failed: 0, total: 20 },
    checks: [],
    errors: [],
    ...verification,
  }
  const freshnessReport = {
    schemaVersion: 1,
    ok: true,
    status: 'fresh',
    currentState: 'baseline',
    staleKind: null,
    applyAllowed: true,
    deploymentReady: true,
    configPath: 'instance.json',
    instanceId: 'island-test',
    bundleHash: BUNDLE_HASH,
    artifactHash: ARTIFACT_HASH,
    expectedBundleHash: BUNDLE_HASH,
    expectedArtifactHash: ARTIFACT_HASH,
    source: { matched: true },
    baseline: { matched: true },
    target: { hash: target.hash, currentMatched: false },
    proposal: { changed: true },
    summary: { passed: 25, failed: 0, total: 25 },
    checks: [],
    errors: [],
    ...freshness,
  }
  await writeFile(join(directory, 'bundle.json'), '{}\n', 'utf8')
  await writeFile(join(directory, 'verification.json'), `${JSON.stringify(verificationReport)}\n`, 'utf8')
  await writeFile(join(directory, 'freshness.json'), `${JSON.stringify(freshnessReport)}\n`, 'utf8')
  return target
}

function readyPlan(target = targetFixture()) {
  return {
    schemaVersion: 1,
    ready: true,
    reason: null,
    artifactPath: '.generated/apply-input/bundle.json',
    configPath: 'instance.json',
    instanceId: 'island-test',
    bundleHash: BUNDLE_HASH,
    artifactHash: ARTIFACT_HASH,
    targetManifestHash: target.hash,
    changed: true,
    changeCount: 1,
    changes: [{ path: 'site.name', before: 'Island Bus', after: 'Island Transit' }],
    warnings: [],
    provisioningDraft: false,
    cutoverReady: true,
    deploymentReady: true,
    freshness: { status: 'fresh' },
    write: { targetSource: target.source },
  }
}

describe('manual reviewed bundle apply-to-PR workflow', () => {
  test('requires GitHub Actions, exact APPLY and a branch ref', () => {
    expect(() => parseInstanceBundleApplyPrWorkflowInputs(workflowEnv({
      overrides: { GITHUB_ACTIONS: 'false' },
    }))).toThrow('only inside GitHub Actions')
    expect(() => parseInstanceBundleApplyPrWorkflowInputs(workflowEnv({
      overrides: { INPUT_CONFIRMATION: 'apply' },
    }))).toThrow('confirmation APPLY')
    expect(() => parseInstanceBundleApplyPrWorkflowInputs(workflowEnv({
      overrides: { GITHUB_REF: 'refs/tags/v1' },
    }))).toThrow('branch ref')
  })

  test('binds the artifact name to the review run and derives immutable PR metadata', () => {
    const inputs = parseInstanceBundleApplyPrWorkflowInputs(workflowEnv())
    expect(inputs.reviewRunId).toBe('123456789')
    expect(inputs.artifactInstanceId).toBe('island-test')
    expect(inputs.baseBranch).toBe('agent/source-stack')
    expect(inputs.branchName).toBe('agent/instance-bundle-apply-987654321-2')
    expect(() => parseInstanceBundleApplyPrWorkflowInputs(workflowEnv({
      overrides: { INPUT_REVIEW_RUN_ID: '123456788' },
    }))).toThrow('must match review_run_id')
    expect(() => parseInstanceBundleApplyPrWorkflowInputs(workflowEnv({
      overrides: { INPUT_ARTIFACT_NAME: 'other-artifact' },
    }))).toThrow('instance-bundle-review')
    expect(() => parseInstanceBundleApplyPrWorkflowInputs(workflowEnv({
      overrides: { INPUT_REVIEW_RUN_ID: '1'.repeat(21) },
    }))).toThrow('20-byte limit')
    expect(() => parseInstanceBundleApplyPrWorkflowInputs(workflowEnv({
      overrides: { INPUT_ARTIFACT_NAME: `instance-bundle-review-${'x'.repeat(240)}-123456789-3` },
    }))).toThrow('256-byte limit')
  })

  test('preflight emits only validated single-line workflow values', async () => {
    await withWorkspace(async ({ summaryPath, outputPath }) => {
      const inputs = parseInstanceBundleApplyPrWorkflowInputs(workflowEnv({ summaryPath, outputPath }))
      let stdout = ''
      await runInstanceBundleApplyPrPreflight(inputs, { stdout: { write(value) { stdout += value } } })
      expect(JSON.parse(stdout).message).toBe('instance_bundle_apply_pr_preflight')
      const outputs = await readFile(outputPath, 'utf8')
      expect(outputs).toContain('review_run_id=123456789')
      expect(outputs).toContain('artifact_name=instance-bundle-review-island-test-123456789-3')
      expect(outputs).toContain('branch_name=agent/instance-bundle-apply-987654321-2')
      expect(await readFile(summaryPath, 'utf8')).toContain('No artifact was downloaded and no file was changed')
    })
  })

  test('requires exactly the three regular review evidence files', async () => {
    await withWorkspace(async ({ cwd, evidenceDirectory, summaryPath, outputPath }) => {
      const target = await writeEvidence(evidenceDirectory)
      await writeFile(join(evidenceDirectory, 'extra.txt'), 'unexpected', 'utf8')
      const inputs = parseInstanceBundleApplyPrWorkflowInputs(workflowEnv({ summaryPath, outputPath }))
      await expect(runInstanceBundleApplyPrWorkflow(inputs, {
        cwd,
        dependencies: {
          buildApply: async () => readyPlan(target),
          writeApply: async () => true,
          readManifest: async () => ({ displayPath: 'instance.json', source: target.source, manifest: target.manifest }),
        },
      })).rejects.toThrow('exactly bundle.json, freshness.json, verification.json')
    })

    await withWorkspace(async ({ cwd, evidenceDirectory, summaryPath, outputPath }) => {
      await writeEvidence(evidenceDirectory)
      await rm(join(evidenceDirectory, 'verification.json'))
      await symlink(join(evidenceDirectory, 'bundle.json'), join(evidenceDirectory, 'verification.json'))
      const inputs = parseInstanceBundleApplyPrWorkflowInputs(workflowEnv({ summaryPath, outputPath }))
      await expect(runInstanceBundleApplyPrWorkflow(inputs, { cwd })).rejects.toThrow('regular file')
    })
  })

  test('atomically applies, re-verifies and writes inert PR evidence', async () => {
    await withWorkspace(async ({ cwd, evidenceDirectory, summaryPath, outputPath }) => {
      const target = await writeEvidence(evidenceDirectory)
      const plan = readyPlan(target)
      let writes = 0
      const inputs = parseInstanceBundleApplyPrWorkflowInputs(workflowEnv({ summaryPath, outputPath }))
      const result = await runInstanceBundleApplyPrWorkflow(inputs, {
        cwd,
        dependencies: {
          buildApply: async () => plan,
          writeApply: async () => { writes += 1; return true },
          readManifest: async () => ({ displayPath: 'instance.json', source: target.source, manifest: target.manifest }),
        },
      })

      expect(writes).toBe(1)
      expect(result.outputs.config_path).toBe('instance.json')
      expect(result.outputs.pr_title).toBe('chore(instance): apply reviewed bundle for island-test')
      expect(result.provenance.reviewRunId).toBe('123456789')
      expect(result.applyResult.written).toBe(true)
      expect(result.prBody).toContain('The workflow changed only the reviewed instance manifest')
      expect(result.prBody).toContain('may not automatically trigger `pull_request` workflows')
      expect(JSON.parse(await readFile(join(cwd, result.outputs.result_path), 'utf8')).written).toBe(true)
      expect(JSON.parse(await readFile(join(cwd, result.outputs.provenance_path), 'utf8')).targetManifestHash).toBe(target.hash)
      expect(await readFile(outputPath, 'utf8')).toContain(`target_manifest_hash=${target.hash}`)
      expect(await readFile(summaryPath, 'utf8')).toContain('post-write target verification succeeded')
    })
  })

  test('rejects inconsistent persisted review reports before applying', async () => {
    await withWorkspace(async ({ cwd, evidenceDirectory, summaryPath, outputPath }) => {
      const target = await writeEvidence(evidenceDirectory, {
        freshness: { expectedArtifactHash: 'f'.repeat(64) },
      })
      let builds = 0
      let writes = 0
      const inputs = parseInstanceBundleApplyPrWorkflowInputs(workflowEnv({ summaryPath, outputPath }))
      await expect(runInstanceBundleApplyPrWorkflow(inputs, {
        cwd,
        dependencies: {
          buildApply: async () => { builds += 1; return readyPlan(target) },
          writeApply: async () => { writes += 1; return true },
        },
      })).rejects.toThrow('Persisted review evidence is inconsistent')
      expect(builds).toBe(0)
      expect(writes).toBe(0)
    })
  })

  test('rejects a changed apply plan identity before the write', async () => {
    await withWorkspace(async ({ cwd, evidenceDirectory, summaryPath, outputPath }) => {
      const target = await writeEvidence(evidenceDirectory)
      let writes = 0
      const plan = { ...readyPlan(target), targetManifestHash: 'd'.repeat(64) }
      const inputs = parseInstanceBundleApplyPrWorkflowInputs(workflowEnv({ summaryPath, outputPath }))
      await expect(runInstanceBundleApplyPrWorkflow(inputs, {
        cwd,
        dependencies: {
          buildApply: async () => plan,
          writeApply: async () => { writes += 1; return true },
        },
      })).rejects.toThrow('target hash differs')
      expect(writes).toBe(0)
    })
  })

  test('fails closed when post-write bytes or canonical target do not match', async () => {
    await withWorkspace(async ({ cwd, evidenceDirectory, summaryPath, outputPath }) => {
      const target = await writeEvidence(evidenceDirectory)
      const inputs = parseInstanceBundleApplyPrWorkflowInputs(workflowEnv({ summaryPath, outputPath }))
      await expect(runInstanceBundleApplyPrWorkflow(inputs, {
        cwd,
        dependencies: {
          buildApply: async () => readyPlan(target),
          writeApply: async () => true,
          readManifest: async () => ({
            displayPath: 'instance.json',
            source: '{"instanceId":"island-test"}\n',
            manifest: { instanceId: 'island-test' },
          }),
        },
      })).rejects.toThrow('Post-write manifest verification failed')
      expect(await readFile(outputPath, 'utf8')).toBe('')
    })
  })

  test('renders artifact warnings as inert indented evidence', () => {
    const inputs = parseInstanceBundleApplyPrWorkflowInputs(workflowEnv())
    const plan = {
      ...readyPlan(),
      warnings: ['warning\n## injected heading\n- not a list'],
    }
    const body = renderApplyPullRequestBody(inputs, plan, {
      reviewRunUrl: 'https://github.com/Mochi96336/mochi-bus/actions/runs/123456789',
    })
    expect(body).toContain('    ## injected heading')
    expect(body).not.toMatch(/^## injected heading$/m)
    expect(body).toContain('    - not a list')
  })
})

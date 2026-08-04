import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { hashCanonical } from './bundle-integrity.mjs'
import {
  evaluateInstanceBundleApplyMerge,
  parseInstanceBundleApplyMergeReconciliationInputs,
  parseInstanceBundleApplyMergeReconciliationMode,
  prepareInstanceBundleApplyMergeReconciliation,
  renderApplyMergeReconciliationMarkdown,
  runApplyMergeReconciliation,
  runApplyMergeReconciliationPreflight,
} from './reconcile-apply-merge.mjs'

const BUNDLE_HASH = 'a'.repeat(64)
const ARTIFACT_HASH = 'b'.repeat(64)
const SOURCE_SHA = 'c'.repeat(40)
const HEAD_SHA = 'd'.repeat(40)
const MERGE_SHA = 'e'.repeat(40)
const CURRENT_SHA = 'f'.repeat(40)
const HEAD_BLOB_SHA = '1'.repeat(40)
const MERGE_BLOB_SHA = '2'.repeat(40)
const CURRENT_BLOB_SHA = '3'.repeat(40)
const TREE_SHA = '4'.repeat(40)
const MANIFEST = Object.freeze({
  $schema: '../config/instance.schema.json',
  schemaVersion: 1,
  instanceId: 'island-test',
  site: { name: 'Island Transit', canonicalOrigin: 'https://bus.example.com' },
  transit: { enabledCities: ['Taipei'], defaultCity: 'Taipei', demoQuery: null },
  cloudflare: {
    workerName: 'island-bus',
    workersDev: false,
    d1: { databaseName: 'island-transit', databaseId: '123e4567-e89b-42d3-a456-426614174000' },
    r2: { bucketName: 'island-shapes' },
    rateLimits: { standardNamespaceId: '42001', expensiveNamespaceId: '42002' },
  },
  operations: {
    profile: 'operator',
    snapshotSchedule: 'daily',
    releaseSmoke: true,
    publicProbe: true,
    windowWatchdog: true,
  },
})
const MANIFEST_SOURCE = `${JSON.stringify(MANIFEST, null, 2)}\n`
const TARGET_HASH = hashCanonical(MANIFEST)

async function withWorkspace(run) {
  const cwd = await mkdtemp(join(tmpdir(), 'mochi-merge-reconcile-'))
  const summaryPath = join(cwd, 'summary.md')
  const outputPath = join(cwd, 'outputs.txt')
  await writeFile(summaryPath, '', 'utf8')
  await writeFile(outputPath, '', 'utf8')
  try {
    return await run({ cwd, summaryPath, outputPath })
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
}

function workflowEnv({ summaryPath = '/tmp/summary', outputPath = '/tmp/output', overrides = {} } = {}) {
  return {
    GITHUB_ACTIONS: 'true',
    GITHUB_REPOSITORY: 'Mochi96336/mochi-bus',
    GITHUB_REF: 'refs/heads/integration/instance-rollout',
    GITHUB_SHA: CURRENT_SHA,
    GITHUB_RUN_ID: '789',
    GITHUB_RUN_ATTEMPT: '3',
    GITHUB_STEP_SUMMARY: summaryPath,
    GITHUB_OUTPUT: outputPath,
    INPUT_CONFIRMATION: 'RECONCILE',
    INPUT_PULL_REQUEST_NUMBER: '321',
    INPUT_APPLY_RUN_ID: '123',
    INPUT_ARTIFACT_NAME: 'instance-bundle-apply-island-test-123-2',
    INPUT_EXPECTED_BUNDLE_HASH: BUNDLE_HASH,
    INPUT_EXPECTED_ARTIFACT_HASH: ARTIFACT_HASH,
    INPUT_EXPECTED_TARGET_MANIFEST_HASH: TARGET_HASH,
    ...overrides,
  }
}

function inputsFixture(overrides = {}) {
  return Object.freeze({
    ...parseInstanceBundleApplyMergeReconciliationInputs(workflowEnv()),
    ...overrides,
  })
}

function preparedFixture(overrides = {}) {
  return Object.freeze({
    baseBranch: 'integration/instance-rollout',
    sourceSha: SOURCE_SHA,
    headBranch: 'agent/instance-bundle-apply-123-2',
    instanceId: 'island-test',
    configPath: 'instances/island-test.json',
    reviewRunId: '456',
    reviewRunAttempt: '1',
    expectedPrTitle: 'chore(instance): apply reviewed bundle for island-test',
    expectedCommitMessage: 'chore(instance): apply reviewed bundle for island-test',
    evidence: {
      prBody: 'deterministic reviewed PR body\n',
      provenance: {
        artifactName: 'instance-bundle-review-island-test-456-1',
      },
    },
    ...overrides,
  })
}

function manifestSnapshot({ sha, source = MANIFEST_SOURCE } = {}) {
  const bytes = Buffer.from(source, 'utf8')
  return {
    schemaVersion: 1,
    type: 'file',
    path: 'instances/island-test.json',
    sha,
    size: bytes.length,
    encoding: 'base64',
    content: bytes.toString('base64'),
  }
}

function runSnapshot({ id, attempt, name, branch = 'integration/instance-rollout' }) {
  return {
    schemaVersion: 1,
    repository: 'Mochi96336/mochi-bus',
    id,
    runAttempt: attempt,
    name,
    event: 'workflow_dispatch',
    status: 'completed',
    conclusion: 'success',
    headBranch: branch,
    headSha: SOURCE_SHA,
    htmlUrl: `https://github.com/Mochi96336/mochi-bus/actions/runs/${id}`,
  }
}

function githubEvidenceFixture(overrides = {}) {
  return structuredClone({
    pullRequest: {
      schemaVersion: 1,
      repository: 'Mochi96336/mochi-bus',
      number: 321,
      state: 'closed',
      draft: false,
      merged: true,
      mergedAt: '2026-08-03T00:00:00Z',
      mergedBy: 'Mochi96336',
      mergeCommitSha: MERGE_SHA,
      title: 'chore(instance): apply reviewed bundle for island-test',
      body: 'deterministic reviewed PR body\n',
      htmlUrl: 'https://github.com/Mochi96336/mochi-bus/pull/321',
      base: { ref: 'integration/instance-rollout', sha: SOURCE_SHA, repository: 'Mochi96336/mochi-bus' },
      head: { ref: 'agent/instance-bundle-apply-123-2', sha: HEAD_SHA, repository: 'Mochi96336/mochi-bus' },
      changedFiles: 1,
      commits: 1,
      additions: 1,
      deletions: 1,
    },
    branch: {
      schemaVersion: 1,
      repository: 'Mochi96336/mochi-bus',
      name: 'integration/instance-rollout',
      sha: CURRENT_SHA,
      protected: false,
    },
    files: {
      schemaVersion: 1,
      files: [{
        filename: 'instances/island-test.json',
        status: 'modified',
        sha: HEAD_BLOB_SHA,
        additions: 1,
        deletions: 1,
        changes: 2,
        previousFilename: null,
      }],
    },
    commits: { schemaVersion: 1, commits: [{ sha: HEAD_SHA }] },
    headCommit: {
      schemaVersion: 1,
      sha: HEAD_SHA,
      message: 'chore(instance): apply reviewed bundle for island-test',
      treeSha: TREE_SHA,
      parents: [SOURCE_SHA],
    },
    mergeCommit: {
      schemaVersion: 1,
      sha: MERGE_SHA,
      message: 'chore(instance): apply reviewed bundle for island-test (#321)',
      treeSha: TREE_SHA,
      parents: [SOURCE_SHA],
    },
    compare: {
      schemaVersion: 1,
      baseSha: MERGE_SHA,
      headSha: CURRENT_SHA,
      status: 'ahead',
      aheadBy: 2,
      behindBy: 0,
      totalCommits: 2,
      mergeBaseSha: MERGE_SHA,
    },
    headManifest: manifestSnapshot({ sha: HEAD_BLOB_SHA }),
    mergeManifest: manifestSnapshot({ sha: MERGE_BLOB_SHA }),
    currentManifest: manifestSnapshot({ sha: CURRENT_BLOB_SHA }),
    applyRun: runSnapshot({
      id: 123,
      attempt: 2,
      name: 'Apply reviewed instance bundle to Draft PR',
    }),
    reviewRun: runSnapshot({
      id: 456,
      attempt: 1,
      name: 'Review instance change bundle',
      branch: 'feature/review-source',
    }),
    ...overrides,
  })
}

function generatedFixture(overrides = {}) {
  return structuredClone({
    schemaVersion: 1,
    manifestHash: TARGET_HASH,
    generatedSetHash: '5'.repeat(64),
    artifacts: {
      runtime: { matched: true, canonicalHash: '6'.repeat(64), detail: 'matches deterministic compiler output' },
      wrangler: { matched: true, canonicalHash: '7'.repeat(64), detail: 'matches deterministic compiler output' },
      operations: { matched: true, canonicalHash: '8'.repeat(64), detail: 'matches deterministic compiler output' },
    },
    ...overrides,
  })
}

function doctorFixture(overrides = {}) {
  return structuredClone({
    schemaVersion: 1,
    ok: true,
    manifest: {
      status: 'ready',
      path: 'instances/island-test.json',
      blockers: [],
      instanceId: 'island-test',
    },
    generated: [
      { key: 'runtime', status: 'ready', blockers: [] },
      { key: 'wrangler', status: 'ready', blockers: [] },
      { key: 'operations', status: 'ready', blockers: [] },
    ],
    environment: { status: 'ready', blockers: [] },
    operations: [
      { name: 'deploy', status: 'ready', blockers: [] },
      { name: 'snapshot', status: 'ready', blockers: [] },
      { name: 'publicProbe', status: 'ready', blockers: [] },
      { name: 'windowWatchdog', status: 'ready', blockers: [] },
    ],
    remote: { requested: false, status: 'not_checked', blockers: [], checkedResources: [] },
    ...overrides,
  })
}

function evaluate({ inputs = inputsFixture(), prepared = preparedFixture(), github = githubEvidenceFixture(), generated = generatedFixture(), doctor = doctorFixture() } = {}) {
  return evaluateInstanceBundleApplyMerge({
    inputs,
    prepared,
    githubEvidence: github,
    generated,
    doctor,
  })
}

describe('merged reviewed bundle reconciliation', () => {
  test('requires GitHub Actions, exact RECONCILE and a branch ref', () => {
    expect(() => parseInstanceBundleApplyMergeReconciliationInputs(workflowEnv({
      overrides: { GITHUB_ACTIONS: 'false' },
    }))).toThrow('only inside GitHub Actions')
    expect(() => parseInstanceBundleApplyMergeReconciliationInputs(workflowEnv({
      overrides: { INPUT_CONFIRMATION: 'reconcile' },
    }))).toThrow('confirmation RECONCILE')
    expect(() => parseInstanceBundleApplyMergeReconciliationInputs(workflowEnv({
      overrides: { GITHUB_REF: 'refs/tags/v1' },
    }))).toThrow('branch ref')
  })

  test('binds the artifact run and accepts only the three explicit modes', () => {
    const parsed = parseInstanceBundleApplyMergeReconciliationInputs(workflowEnv())
    expect(parsed.applyRunId).toBe('123')
    expect(parsed.applyRunAttempt).toBe('2')
    expect(parsed.artifactInstanceId).toBe('island-test')
    expect(parsed.currentBranch).toBe('integration/instance-rollout')
    expect(() => parseInstanceBundleApplyMergeReconciliationInputs(workflowEnv({
      overrides: { INPUT_APPLY_RUN_ID: '124' },
    }))).toThrow('must match apply_run_id')
    expect(parseInstanceBundleApplyMergeReconciliationMode(['--preflight'])).toBe('preflight')
    expect(parseInstanceBundleApplyMergeReconciliationMode(['--prepare'])).toBe('prepare')
    expect(parseInstanceBundleApplyMergeReconciliationMode(['--reconcile'])).toBe('reconcile')
    expect(() => parseInstanceBundleApplyMergeReconciliationMode(['--write'])).toThrow('Usage')
  })

  test('preflight emits only validated single-line workflow values', async () => {
    await withWorkspace(async ({ summaryPath, outputPath }) => {
      const inputs = parseInstanceBundleApplyMergeReconciliationInputs(workflowEnv({ summaryPath, outputPath }))
      let stdout = ''
      await runApplyMergeReconciliationPreflight(inputs, { stdout: { write(value) { stdout += value } } })
      expect(JSON.parse(stdout).currentBranch).toBe('integration/instance-rollout')
      const outputs = await readFile(outputPath, 'utf8')
      expect(outputs).toContain('pull_request_number=321')
      expect(outputs).toContain(`current_sha=${CURRENT_SHA}`)
      expect(await readFile(summaryPath, 'utf8')).toContain('no manifest was changed')
    })
  })

  test('prepares the persisted apply artifact and requires the dispatch branch to match its base', async () => {
    const inputs = inputsFixture()
    const prepared = preparedFixture()
    const result = await prepareInstanceBundleApplyMergeReconciliation(inputs, {
      dependencies: { prepareApply: async () => prepared },
    })
    expect(result.prepared.instanceId).toBe('island-test')

    await expect(prepareInstanceBundleApplyMergeReconciliation(inputs, {
      dependencies: { prepareApply: async () => preparedFixture({ baseBranch: 'other/base' }) },
    })).rejects.toThrow('does not match dispatch branch')
  })

  test('reconciles a merged one-commit one-manifest PR with deterministic generated outputs', () => {
    const report = evaluate()
    expect(report.status).toBe('reconciled')
    expect(report.ok).toBe(true)
    expect(report.contentReconciled).toBe(true)
    expect(report.localDoctorReady).toBe(true)
    expect(report.deploymentReady).toBe(false)
    expect(report.current.commitsAfterMerge).toBe(2)
    expect(report.summary.failed).toBe(0)
  })

  test('allows a descendant branch tip when the merged manifest bytes remain unchanged', () => {
    const github = githubEvidenceFixture()
    github.compare.status = 'ahead'
    github.compare.aheadBy = 7
    const report = evaluate({ github })
    expect(report.status).toBe('reconciled')
    expect(report.current.commitsAfterMerge).toBe(7)
  })

  test('reports locally_blocked without losing successful content reconciliation', () => {
    const doctor = doctorFixture({
      ok: false,
      environment: { status: 'blocked', blockers: ['TDX_CLIENT_SECRET is missing'] },
      operations: [{ name: 'deploy', status: 'blocked', blockers: ['TDX_CLIENT_SECRET is missing'] }],
    })
    const report = evaluate({ doctor })
    expect(report.status).toBe('locally_blocked')
    expect(report.ok).toBe(true)
    expect(report.contentReconciled).toBe(true)
    expect(report.localDoctorReady).toBe(false)
    expect(report.doctor.blockers).toContain('TDX_CLIENT_SECRET is missing')
    expect(report.deploymentReady).toBe(false)
  })

  test('blocks an unmerged, draft or wrong-base PR', () => {
    const github = githubEvidenceFixture()
    github.pullRequest.merged = false
    github.pullRequest.state = 'open'
    github.pullRequest.draft = true
    github.pullRequest.base.ref = 'main'
    const report = evaluate({ github })
    expect(report.status).toBe('blocked')
    expect(report.errors.join('\n')).toContain('pr-merged')
    expect(report.errors.join('\n')).toContain('pr-not-draft')
    expect(report.errors.join('\n')).toContain('base-branch')
  })

  test('blocks a moved branch snapshot or non-descendant merge commit', () => {
    const github = githubEvidenceFixture()
    github.branch.sha = MERGE_SHA
    github.compare.status = 'diverged'
    github.compare.behindBy = 1
    const report = evaluate({ github })
    expect(report.status).toBe('blocked')
    expect(report.errors.join('\n')).toContain('branch-snapshot')
    expect(report.errors.join('\n')).toContain('merge-ancestry')
  })

  test('blocks target-byte drift even when the current JSON stays canonically equivalent', () => {
    const github = githubEvidenceFixture()
    github.currentManifest = manifestSnapshot({
      sha: CURRENT_BLOB_SHA,
      source: `${JSON.stringify(MANIFEST)}\n`,
    })
    const report = evaluate({ github })
    expect(report.status).toBe('blocked')
    expect(report.errors.join('\n')).toContain('current-preserved-target-bytes')
    expect(report.errors.join('\n')).not.toContain('current-manifest-target')
  })

  test('blocks generated artifact tampering and manifest hash mismatch', () => {
    const generated = generatedFixture()
    generated.manifestHash = '9'.repeat(64)
    generated.artifacts.wrangler.matched = false
    generated.artifacts.wrangler.detail = 'tampered generated Wrangler config'
    const report = evaluate({ generated })
    expect(report.status).toBe('blocked')
    expect(report.errors.join('\n')).toContain('generated-manifest-hash')
    expect(report.errors.join('\n')).toContain('generated-wrangler')
  })

  test('blocks a second PR file or commit and a changed head parent', () => {
    const github = githubEvidenceFixture()
    github.pullRequest.changedFiles = 2
    github.pullRequest.commits = 2
    github.files.files.push({ filename: 'README.md', status: 'modified', sha: '5'.repeat(40) })
    github.commits.commits.push({ sha: '6'.repeat(40) })
    github.headCommit.parents = [SOURCE_SHA, '7'.repeat(40)]
    const report = evaluate({ github })
    expect(report.status).toBe('blocked')
    expect(report.errors.join('\n')).toContain('single-changed-file-count')
    expect(report.errors.join('\n')).toContain('single-commit-count')
    expect(report.errors.join('\n')).toContain('head-parent')
  })

  test('blocks changed review or apply workflow identity', () => {
    const github = githubEvidenceFixture()
    github.applyRun.conclusion = 'failure'
    github.reviewRun.headSha = '8'.repeat(40)
    const report = evaluate({ github })
    expect(report.status).toBe('blocked')
    expect(report.errors.join('\n')).toContain('apply-run-success')
    expect(report.errors.join('\n')).toContain('review-run-source')
  })

  test('renders operator-controlled blockers as inert indented evidence', () => {
    const report = evaluate()
    const altered = {
      ...report,
      status: 'blocked',
      errors: ['bad value\n## injected heading\n- fake instruction'],
      doctor: { ...report.doctor, blockers: ['secret `name`\n## injected'] },
      summary: { ...report.summary, failed: 1 },
    }
    const markdown = renderApplyMergeReconciliationMarkdown(altered)
    expect(markdown).toContain('    ## injected heading')
    expect(markdown).not.toMatch(/^## injected heading$/m)
    expect(markdown).toContain('    - fake instruction')
  })

  test('writes reconciliation evidence, succeeds for local blockers and fails closed for identity blockers', async () => {
    await withWorkspace(async ({ cwd, summaryPath, outputPath }) => {
      const inputs = parseInstanceBundleApplyMergeReconciliationInputs(workflowEnv({ summaryPath, outputPath }))
      const prepared = preparedFixture()
      const dependencies = {
        prepareApply: async () => prepared,
        githubEvidence: githubEvidenceFixture(),
        generated: generatedFixture(),
        doctor: doctorFixture({
          ok: false,
          environment: { status: 'blocked', blockers: ['local secret missing'] },
          operations: [{ name: 'deploy', status: 'blocked', blockers: ['local secret missing'] }],
        }),
      }
      const report = await runApplyMergeReconciliation(inputs, { cwd, dependencies })
      expect(report.status).toBe('locally_blocked')
      expect(JSON.parse(await readFile(join(cwd, inputs.resultDirectory, 'reconciliation.json'), 'utf8')).status).toBe('locally_blocked')
      expect(await readFile(outputPath, 'utf8')).toContain('deployment_ready=false')

      const blockedInputs = Object.freeze({ ...inputs, resultDirectory: '.generated/reconcile-apply-merge/blocked-result' })
      const blockedGithub = githubEvidenceFixture()
      blockedGithub.pullRequest.merged = false
      await expect(runApplyMergeReconciliation(blockedInputs, {
        cwd,
        dependencies: { ...dependencies, githubEvidence: blockedGithub },
      })).rejects.toThrow('blocked with')
    })
  })
})

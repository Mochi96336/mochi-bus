import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  buildInstanceBundleArtifact,
  parseInstanceBundleArtifactArguments,
} from './bundle-artifact.mjs'
import { renderApplyPullRequestBody } from './apply-bundle-pr-workflow.mjs'
import {
  parseInstanceBundleApplyPrVerificationInputs,
  prepareInstanceBundleApplyPrVerification,
  renderApplyPrVerificationMarkdown,
  runApplyPrVerificationPreflight,
  runApplyPrVerificationPrepare,
  verifyInstanceBundleApplyPullRequest,
} from './verify-apply-pr.mjs'

const SOURCE_SHA = 'c'.repeat(40)
const HEAD_SHA = 'd'.repeat(40)
const BASE_BLOB_SHA = 'e'.repeat(40)
const HEAD_BLOB_SHA = 'f'.repeat(40)
const APPLY_RUN_ID = '987654321'
const APPLY_RUN_ATTEMPT = '2'
const REVIEW_RUN_ID = '123456789'
const REVIEW_RUN_ATTEMPT = '3'

const BASE_MANIFEST = Object.freeze({
  $schema: '../config/instance.schema.json',
  schemaVersion: 1,
  instanceId: 'island-test',
  site: {
    name: 'Island Bus',
    canonicalOrigin: 'https://bus.example.com',
  },
  transit: {
    enabledCities: ['Taipei', 'Tainan'],
    defaultCity: 'Taipei',
    demoQuery: null,
  },
  cloudflare: {
    workerName: 'island-bus',
    workersDev: false,
    d1: {
      databaseName: 'island-transit',
      databaseId: '123e4567-e89b-42d3-a456-426614174000',
    },
    r2: { bucketName: 'island-shapes' },
    rateLimits: {
      standardNamespaceId: '42001',
      expensiveNamespaceId: '42002',
    },
  },
  operations: {
    profile: 'operator',
    snapshotSchedule: 'daily',
    releaseSmoke: true,
    publicProbe: true,
    windowWatchdog: true,
  },
})

function verificationEnv({ summaryPath = '/tmp/summary', outputPath = '/tmp/output', hashes = {}, overrides = {} } = {}) {
  return {
    GITHUB_ACTIONS: 'true',
    GITHUB_REPOSITORY: 'Mochi96336/mochi-bus',
    GITHUB_RUN_ID: '777777777',
    GITHUB_RUN_ATTEMPT: '1',
    GITHUB_STEP_SUMMARY: summaryPath,
    GITHUB_OUTPUT: outputPath,
    INPUT_CONFIRMATION: 'VERIFY',
    INPUT_PULL_REQUEST_NUMBER: '314',
    INPUT_APPLY_RUN_ID: APPLY_RUN_ID,
    INPUT_ARTIFACT_NAME: `instance-bundle-apply-island-test-${APPLY_RUN_ID}-${APPLY_RUN_ATTEMPT}`,
    INPUT_EXPECTED_BUNDLE_HASH: hashes.bundleHash ?? 'a'.repeat(64),
    INPUT_EXPECTED_ARTIFACT_HASH: hashes.artifactHash ?? 'b'.repeat(64),
    INPUT_EXPECTED_TARGET_MANIFEST_HASH: hashes.targetManifestHash ?? '9'.repeat(64),
    ...overrides,
  }
}

async function withWorkspace(run) {
  const cwd = await mkdtemp(join(tmpdir(), 'mochi-verify-apply-pr-'))
  const summaryPath = join(cwd, 'summary.md')
  const outputPath = join(cwd, 'outputs.txt')
  await writeFile(summaryPath, '', 'utf8')
  await writeFile(outputPath, '', 'utf8')
  await writeFile(join(cwd, 'instance.json'), `${JSON.stringify(BASE_MANIFEST, null, 2)}\n`, 'utf8')
  try {
    return await run({ cwd, summaryPath, outputPath })
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
}

async function buildFixture(cwd, { warnings = [] } = {}) {
  const artifact = await buildInstanceBundleArtifact(parseInstanceBundleArtifactArguments([
    '--config', 'instance.json',
    '--site-name', 'Island Transit',
    '--dry-run',
  ]), { cwd, env: {} })
  if (warnings.length > 0) {
    throw new Error('warning fixture requires rebuilding artifact integrity and is intentionally unsupported')
  }
  const bundleHash = artifact.bundle.hashes.bundleHash
  const artifactHash = artifact.integrity.artifactHash
  const targetManifestHash = artifact.bundle.hashes.targetManifestHash
  const hashes = { bundleHash, artifactHash, targetManifestHash }
  const inputs = parseInstanceBundleApplyPrVerificationInputs(verificationEnv({
    summaryPath: join(cwd, 'summary.md'),
    outputPath: join(cwd, 'outputs.txt'),
    hashes,
  }))
  const applyInput = join(cwd, '.generated', 'verify-apply-pr', 'download', 'apply-input')
  const applyResultDirectory = join(cwd, '.generated', 'verify-apply-pr', 'download', 'apply-pr', `workflow-${APPLY_RUN_ID}-${APPLY_RUN_ATTEMPT}`)
  await mkdir(applyInput, { recursive: true })
  await mkdir(applyResultDirectory, { recursive: true })

  const verification = {
    schemaVersion: 1,
    ok: true,
    instanceId: 'island-test',
    bundleHash,
    artifactHash,
    expectedBundleHash: bundleHash,
    expectedArtifactHash: artifactHash,
    summary: { passed: 20, failed: 0, total: 20 },
    checks: [],
    errors: [],
  }
  const freshness = {
    schemaVersion: 1,
    ok: true,
    status: 'fresh',
    currentState: 'baseline',
    staleKind: null,
    applyAllowed: true,
    deploymentReady: true,
    configPath: 'instance.json',
    instanceId: 'island-test',
    bundleHash,
    artifactHash,
    expectedBundleHash: bundleHash,
    expectedArtifactHash: artifactHash,
    source: { matched: true },
    baseline: { matched: true },
    target: { hash: targetManifestHash, currentMatched: false },
    proposal: { changed: true },
    summary: { passed: 25, failed: 0, total: 25 },
    checks: [],
    errors: [],
  }
  const applyResult = {
    schemaVersion: 1,
    ready: true,
    written: true,
    reason: null,
    details: [],
    artifactPath: '.generated/apply-input/bundle.json',
    configPath: 'instance.json',
    instanceId: 'island-test',
    bundleHash,
    artifactHash,
    sourceManifestHash: artifact.bundle.hashes.sourceManifestHash,
    baselineManifestHash: artifact.bundle.hashes.baselineManifestHash,
    targetManifestHash,
    changeCount: artifact.bundle.proposal.changes.length,
    changes: artifact.bundle.proposal.changes,
    warnings: artifact.bundle.proposal.warnings,
    provisioningDraft: artifact.bundle.provisioningDraft,
    cutoverReady: artifact.bundle.cutoverReady,
    deploymentReady: true,
    freshness,
  }
  const provenance = {
    schemaVersion: 1,
    kind: 'mochi-bus-instance-bundle-apply-pr-provenance',
    repository: 'Mochi96336/mochi-bus',
    reviewRunId: REVIEW_RUN_ID,
    reviewRunAttempt: REVIEW_RUN_ATTEMPT,
    reviewRunUrl: `https://github.com/Mochi96336/mochi-bus/actions/runs/${REVIEW_RUN_ID}`,
    artifactName: `instance-bundle-review-island-test-${REVIEW_RUN_ID}-${REVIEW_RUN_ATTEMPT}`,
    bundleHash,
    artifactHash,
    targetManifestHash,
    sourceRef: 'refs/heads/agent/source-stack',
    sourceSha: SOURCE_SHA,
    baseBranch: 'agent/source-stack',
    branchName: `agent/instance-bundle-apply-${APPLY_RUN_ID}-${APPLY_RUN_ATTEMPT}`,
    applyRunId: APPLY_RUN_ID,
    applyRunAttempt: APPLY_RUN_ATTEMPT,
    configPath: 'instance.json',
    instanceId: 'island-test',
    changePaths: artifact.bundle.proposal.changes.map((change) => change.path),
    provisioningDraft: artifact.bundle.provisioningDraft,
    cutoverReady: artifact.bundle.cutoverReady,
    deploymentReady: true,
  }
  const prBody = renderApplyPullRequestBody({
    reviewRunId: REVIEW_RUN_ID,
    artifactName: provenance.artifactName,
    baseBranch: provenance.baseBranch,
    sourceSha: provenance.sourceSha,
  }, {
    bundleHash,
    artifactHash,
    targetManifestHash,
    configPath: 'instance.json',
    instanceId: 'island-test',
    changes: applyResult.changes,
    warnings: applyResult.warnings,
    deploymentReady: true,
  }, provenance)

  await Promise.all([
    writeFile(join(applyInput, 'bundle.json'), `${JSON.stringify(artifact, null, 2)}\n`, 'utf8'),
    writeFile(join(applyInput, 'verification.json'), `${JSON.stringify(verification, null, 2)}\n`, 'utf8'),
    writeFile(join(applyInput, 'freshness.json'), `${JSON.stringify(freshness, null, 2)}\n`, 'utf8'),
    writeFile(join(applyResultDirectory, 'apply-result.json'), `${JSON.stringify(applyResult, null, 2)}\n`, 'utf8'),
    writeFile(join(applyResultDirectory, 'provenance.json'), `${JSON.stringify(provenance, null, 2)}\n`, 'utf8'),
    writeFile(join(applyResultDirectory, 'pr-body.md'), prBody, 'utf8'),
  ])
  return { artifact, hashes, inputs, verification, freshness, applyResult, provenance, prBody }
}

async function writeGithubEvidence(cwd, fixture, overrides = {}) {
  const directory = join(cwd, '.generated', 'verify-apply-pr', 'github')
  await mkdir(directory, { recursive: true })
  const targetSource = `${JSON.stringify(fixture.artifact.bundle.proposal.manifest, null, 2)}\n`
  const values = {
    'pull-request.json': {
      schemaVersion: 1,
      repository: 'Mochi96336/mochi-bus',
      number: 314,
      state: 'open',
      draft: true,
      merged: false,
      mergeable: true,
      title: 'chore(instance): apply reviewed bundle for island-test',
      body: fixture.prBody,
      htmlUrl: 'https://github.com/Mochi96336/mochi-bus/pull/314',
      base: { ref: 'agent/source-stack', sha: SOURCE_SHA, repository: 'Mochi96336/mochi-bus' },
      head: { ref: `agent/instance-bundle-apply-${APPLY_RUN_ID}-${APPLY_RUN_ATTEMPT}`, sha: HEAD_SHA, repository: 'Mochi96336/mochi-bus' },
      changedFiles: 1,
      commits: 1,
      additions: 1,
      deletions: 1,
    },
    'files.json': {
      schemaVersion: 1,
      files: [{ filename: 'instance.json', status: 'modified', sha: HEAD_BLOB_SHA, additions: 1, deletions: 1, changes: 2, previousFilename: null }],
    },
    'commits.json': {
      schemaVersion: 1,
      commits: [{ sha: HEAD_SHA, message: 'chore(instance): apply reviewed bundle for island-test', parents: [SOURCE_SHA] }],
    },
    'head-commit.json': {
      schemaVersion: 1,
      sha: HEAD_SHA,
      message: 'chore(instance): apply reviewed bundle for island-test',
      treeSha: '1'.repeat(40),
      parents: [SOURCE_SHA],
    },
    'base-manifest.json': manifestSnapshot(BASE_MANIFEST, BASE_BLOB_SHA),
    'head-manifest.json': manifestSnapshot(fixture.artifact.bundle.proposal.manifest, HEAD_BLOB_SHA, targetSource),
    'apply-run.json': workflowRun({ id: APPLY_RUN_ID, attempt: APPLY_RUN_ATTEMPT, name: 'Apply reviewed instance bundle to Draft PR', branch: 'agent/source-stack' }),
    'review-run.json': workflowRun({ id: REVIEW_RUN_ID, attempt: REVIEW_RUN_ATTEMPT, name: 'Review instance change bundle', branch: 'another-ref-with-same-sha' }),
    'checks.json': {
      schemaVersion: 1,
      combinedState: 'success',
      checkRuns: [{ name: 'quality', status: 'completed', conclusion: 'success', detailsUrl: null, appSlug: 'github-actions' }],
      statuses: [],
    },
  }
  for (const [name, patch] of Object.entries(overrides)) {
    values[name] = typeof patch === 'function' ? patch(structuredClone(values[name])) : patch
  }
  await Promise.all(Object.entries(values).map(([name, value]) => writeFile(join(directory, name), `${JSON.stringify(value, null, 2)}\n`, 'utf8')))
}

function manifestSnapshot(manifest, sha, source = `${JSON.stringify(manifest, null, 2)}\n`) {
  const bytes = Buffer.from(source, 'utf8')
  return {
    schemaVersion: 1,
    type: 'file',
    path: 'instance.json',
    sha,
    size: bytes.length,
    encoding: 'base64',
    content: bytes.toString('base64'),
  }
}

function workflowRun({ id, attempt, name, branch }) {
  return {
    schemaVersion: 1,
    repository: 'Mochi96336/mochi-bus',
    id: Number(id),
    runAttempt: Number(attempt),
    name,
    event: 'workflow_dispatch',
    status: 'completed',
    conclusion: 'success',
    headBranch: branch,
    headSha: SOURCE_SHA,
    htmlUrl: `https://github.com/Mochi96336/mochi-bus/actions/runs/${id}`,
  }
}

describe('reviewed bundle apply PR verification', () => {
  test('requires exact VERIFY and binds the apply artifact to its run', () => {
    const env = verificationEnv()
    expect(parseInstanceBundleApplyPrVerificationInputs(env).applyRunAttempt).toBe(APPLY_RUN_ATTEMPT)
    expect(() => parseInstanceBundleApplyPrVerificationInputs({ ...env, INPUT_CONFIRMATION: 'verify' })).toThrow('confirmation VERIFY')
    expect(() => parseInstanceBundleApplyPrVerificationInputs({ ...env, INPUT_APPLY_RUN_ID: '987654320' })).toThrow('must match apply_run_id')
    expect(() => parseInstanceBundleApplyPrVerificationInputs({ ...env, INPUT_PULL_REQUEST_NUMBER: '0' })).toThrow('greater than zero')
    expect(() => parseInstanceBundleApplyPrVerificationInputs({ ...env, INPUT_EXPECTED_TARGET_MANIFEST_HASH: 'x' })).toThrow('SHA-256')
  })

  test('preflight emits only validated run, artifact and PR identities', async () => {
    await withWorkspace(async ({ summaryPath, outputPath }) => {
      const inputs = parseInstanceBundleApplyPrVerificationInputs(verificationEnv({ summaryPath, outputPath }))
      let stdout = ''
      await runApplyPrVerificationPreflight(inputs, { stdout: { write(value) { stdout += value } } })
      expect(JSON.parse(stdout).message).toBe('instance_bundle_apply_pr_verification_preflight')
      expect(await readFile(outputPath, 'utf8')).toContain(`apply_run_id=${APPLY_RUN_ID}`)
      expect(await readFile(outputPath, 'utf8')).toContain('pull_request_number=314')
      expect(await readFile(summaryPath, 'utf8')).toContain('No artifact was downloaded')
    })
  })

  test('verifies the complete persisted apply artifact before GitHub metadata', async () => {
    await withWorkspace(async ({ cwd, summaryPath, outputPath }) => {
      const fixture = await buildFixture(cwd)
      const prepared = await prepareInstanceBundleApplyPrVerification(fixture.inputs, { cwd })
      expect(prepared.configPath).toBe('instance.json')
      expect(prepared.baseBranch).toBe('agent/source-stack')
      expect(prepared.sourceSha).toBe(SOURCE_SHA)
      expect(prepared.headBranch).toBe(`agent/instance-bundle-apply-${APPLY_RUN_ID}-${APPLY_RUN_ATTEMPT}`)

      await runApplyPrVerificationPrepare(fixture.inputs, { cwd, stdout: { write() {} } })
      expect(await readFile(outputPath, 'utf8')).toContain('config_path=instance.json')
      expect(await readFile(outputPath, 'utf8')).toContain(`review_run_id=${REVIEW_RUN_ID}`)
      expect(await readFile(summaryPath, 'utf8')).toContain('GitHub metadata has not yet been trusted')
    })
  })

  test('rejects tampered provenance and unexpected downloaded files', async () => {
    await withWorkspace(async ({ cwd }) => {
      const fixture = await buildFixture(cwd)
      const provenancePath = join(cwd, '.generated', 'verify-apply-pr', 'download', 'apply-pr', `workflow-${APPLY_RUN_ID}-${APPLY_RUN_ATTEMPT}`, 'provenance.json')
      await writeFile(provenancePath, `${JSON.stringify({ ...fixture.provenance, targetManifestHash: '0'.repeat(64) })}\n`, 'utf8')
      await expect(prepareInstanceBundleApplyPrVerification(fixture.inputs, { cwd })).rejects.toThrow('provenance target hash')
    })

    await withWorkspace(async ({ cwd }) => {
      const fixture = await buildFixture(cwd)
      await writeFile(join(cwd, '.generated', 'verify-apply-pr', 'download', 'extra.txt'), 'unexpected', 'utf8')
      await expect(prepareInstanceBundleApplyPrVerification(fixture.inputs, { cwd })).rejects.toThrow('contain exactly')
    })
  })

  test('rejects symlinked persisted evidence', async () => {
    await withWorkspace(async ({ cwd }) => {
      const fixture = await buildFixture(cwd)
      const directory = join(cwd, '.generated', 'verify-apply-pr', 'download', 'apply-input')
      await rm(join(directory, 'verification.json'))
      await symlink(join(directory, 'bundle.json'), join(directory, 'verification.json'))
      await expect(prepareInstanceBundleApplyPrVerification(fixture.inputs, { cwd })).rejects.toThrow('symbolic link')
    })
  })

  test('verifies one Draft PR, one commit and one reviewed manifest', async () => {
    await withWorkspace(async ({ cwd }) => {
      const fixture = await buildFixture(cwd)
      await writeGithubEvidence(cwd, fixture)
      const report = await verifyInstanceBundleApplyPullRequest(fixture.inputs, { cwd })
      expect(report.status).toBe('verified')
      expect(report.summary.failed).toBe(0)
      expect(report.ci.state).toBe('success')
      expect(report.readyForReviewTransition).toBe(true)
      expect(report.nextAction).toContain('human may review')
    })
  })

  test('keeps identity verification separate from missing formal CI', async () => {
    await withWorkspace(async ({ cwd }) => {
      const fixture = await buildFixture(cwd)
      await writeGithubEvidence(cwd, fixture, {
        'checks.json': { schemaVersion: 1, combinedState: 'pending', checkRuns: [], statuses: [] },
      })
      const report = await verifyInstanceBundleApplyPullRequest(fixture.inputs, { cwd })
      expect(report.ok).toBe(true)
      expect(report.ci.state).toBe('missing')
      expect(report.readyForReviewTransition).toBe(false)
      expect(report.nextAction).toContain('Dispatch the existing CI workflow')
    })
  })

  test.each([
    ['non-Draft PR', { 'pull-request.json': (value) => ({ ...value, draft: false }) }, 'pr-draft'],
    ['advanced base', { 'pull-request.json': (value) => ({ ...value, base: { ...value.base, sha: '8'.repeat(40) } }) }, 'base-sha'],
    ['edited PR body', { 'pull-request.json': (value) => ({ ...value, body: `${value.body}\nmanual edit` }) }, 'pr-body'],
    ['extra changed file', { 'files.json': (value) => ({ ...value, files: [...value.files, { filename: 'README.md', status: 'modified', sha: '7'.repeat(40), additions: 1, deletions: 0, changes: 1, previousFilename: null }] }) }, 'single-modified-manifest'],
    ['extra commit', { 'commits.json': (value) => ({ ...value, commits: [...value.commits, { sha: '6'.repeat(40), message: 'extra', parents: [HEAD_SHA] }] }) }, 'single-head-commit'],
  ])('blocks %s', async (_label, overrides, checkId) => {
    await withWorkspace(async ({ cwd }) => {
      const fixture = await buildFixture(cwd)
      await writeGithubEvidence(cwd, fixture, overrides)
      const report = await verifyInstanceBundleApplyPullRequest(fixture.inputs, { cwd })
      expect(report.status).toBe('blocked')
      expect(report.checks.find((item) => item.id === checkId)?.ok).toBe(false)
    })
  })

  test('blocks a head manifest whose canonical target hash differs', async () => {
    await withWorkspace(async ({ cwd }) => {
      const fixture = await buildFixture(cwd)
      await writeGithubEvidence(cwd, fixture, {
        'head-manifest.json': manifestSnapshot({ ...fixture.artifact.bundle.proposal.manifest, site: { ...fixture.artifact.bundle.proposal.manifest.site, name: 'Tampered' } }, HEAD_BLOB_SHA),
      })
      const report = await verifyInstanceBundleApplyPullRequest(fixture.inputs, { cwd })
      expect(report.status).toBe('blocked')
      expect(report.errors.join('\n')).toContain('head-manifest-target')
    })
  })

  test('renders blockers as inert line-preserving evidence', () => {
    const markdown = renderApplyPrVerificationMarkdown({
      status: 'blocked',
      pullRequestNumber: 314,
      instanceId: 'island-test',
      configPath: 'instance.json',
      base: { branch: 'base', sha: SOURCE_SHA },
      head: { branch: 'head', sha: HEAD_SHA },
      hashes: { bundleHash: 'a'.repeat(64), artifactHash: 'b'.repeat(64), targetManifestHash: 'c'.repeat(64) },
      pullRequest: { mergeability: 'unknown' },
      ci: { state: 'missing', total: 0 },
      readyForReviewTransition: false,
      summary: { passed: 1, failed: 1 },
      errors: ['warning\n## injected heading\n- not a list'],
      nextAction: 'verify again',
    })
    expect(markdown).toContain('    ## injected heading')
    expect(markdown).not.toMatch(/^## injected heading$/m)
    expect(markdown).toContain('    - not a list')
  })
})

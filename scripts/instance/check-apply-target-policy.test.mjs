import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  INSTANCE_BUNDLE_E2E_FIXTURE,
  classifyReviewedBundleApplyPurpose,
  enforceApplyTargetPolicy,
  parseApplyTargetPolicyInputs,
  readApplyTargetPolicyEvidence,
} from './check-apply-target-policy.mjs'

function workflowEnv(overrides = {}) {
  return {
    GITHUB_ACTIONS: 'true',
    GITHUB_REF: 'refs/heads/main',
    GITHUB_DEFAULT_BRANCH: 'main',
    ...overrides,
  }
}

async function withEvidence(freshness, run) {
  const cwd = await mkdtemp(join(tmpdir(), 'mochi-apply-policy-'))
  const directory = join(cwd, '.generated', 'apply-input')
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'freshness.json'), `${JSON.stringify(freshness)}\n`, 'utf8')
  try {
    return await run({ cwd })
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
}

function freshness(configPath) {
  return { schemaVersion: 1, ok: true, status: 'fresh', configPath }
}

describe('reviewed bundle apply target policy', () => {
  test('requires Actions, a branch ref and the repository default branch', () => {
    expect(() => parseApplyTargetPolicyInputs(workflowEnv({ GITHUB_ACTIONS: 'false' })))
      .toThrow('only inside GitHub Actions')
    expect(() => parseApplyTargetPolicyInputs(workflowEnv({ GITHUB_REF: 'refs/tags/v1' })))
      .toThrow('requires a branch ref')
    expect(() => parseApplyTargetPolicyInputs(workflowEnv({ GITHUB_DEFAULT_BRANCH: '' })))
      .toThrow('GITHUB_DEFAULT_BRANCH is required')
  })

  test('blocks example manifests on the default branch and ordinary feature branches', () => {
    const main = parseApplyTargetPolicyInputs(workflowEnv())
    expect(() => enforceApplyTargetPolicy(main, freshness(INSTANCE_BUNDLE_E2E_FIXTURE)))
      .toThrow('cannot be applied directly to default branch main')
    expect(() => classifyReviewedBundleApplyPurpose({
      baseBranch: 'feature/example-copy',
      configPath: INSTANCE_BUNDLE_E2E_FIXTURE,
    })).toThrow('requires a disposable e2e/instance-bundle-* base branch')
  })

  test('allows only the fixed starter fixture on an E2E base and marks it test-only', () => {
    const inputs = parseApplyTargetPolicyInputs(workflowEnv({
      GITHUB_REF: 'refs/heads/e2e/instance-bundle-20260806-0044',
    }))
    expect(enforceApplyTargetPolicy(inputs, freshness(INSTANCE_BUNDLE_E2E_FIXTURE))).toEqual({
      purpose: 'e2e',
      testOnly: true,
      e2eFixture: INSTANCE_BUNDLE_E2E_FIXTURE,
      configPath: INSTANCE_BUNDLE_E2E_FIXTURE,
      exampleManifest: true,
      baseBranch: 'e2e/instance-bundle-20260806-0044',
      defaultBranch: 'main',
    })
  })

  test('blocks production and alternate examples on E2E bases', () => {
    for (const configPath of [
      'instances/mochi-production.json',
      'instance.json',
      'instances/other.example.json',
    ]) {
      expect(() => classifyReviewedBundleApplyPurpose({
        baseBranch: 'e2e/instance-bundle-20260806-0044',
        configPath,
      })).toThrow(`may apply only ${INSTANCE_BUNDLE_E2E_FIXTURE}`)
    }
  })

  test('recognizes example suffix case-insensitively', () => {
    expect(() => classifyReviewedBundleApplyPurpose({
      baseBranch: 'feature/uppercase-example',
      configPath: 'instances/demo.EXAMPLE.json',
    })).toThrow('requires a disposable e2e/instance-bundle-* base branch')
  })

  test('allows normal non-example changes outside the E2E namespace', () => {
    expect(classifyReviewedBundleApplyPurpose({
      baseBranch: 'main',
      configPath: 'instances/mochi-production.json',
    })).toEqual({
      purpose: 'change',
      testOnly: false,
      e2eFixture: null,
      configPath: 'instances/mochi-production.json',
      exampleManifest: false,
      baseBranch: 'main',
    })
  })

  test('fails closed on invalid or unsafe freshness evidence', () => {
    const inputs = parseApplyTargetPolicyInputs(workflowEnv())
    expect(() => enforceApplyTargetPolicy(inputs, { schemaVersion: 1, ok: false, status: 'stale' }))
      .toThrow('requires successful schema version 1 freshness evidence')
    expect(() => enforceApplyTargetPolicy(inputs, freshness('../outside.example.json')))
      .toThrow('safe repository-relative path')
  })

  test('reads the fixed strict freshness evidence file', async () => {
    await withEvidence(freshness(INSTANCE_BUNDLE_E2E_FIXTURE), async ({ cwd }) => {
      await expect(readApplyTargetPolicyEvidence({ cwd })).resolves.toEqual(
        freshness(INSTANCE_BUNDLE_E2E_FIXTURE),
      )
    })
  })
})

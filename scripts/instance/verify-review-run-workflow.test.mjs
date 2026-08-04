import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  parseInstanceBundleReviewRunVerificationInputs,
  verifyInstanceBundleReviewRunMetadata,
} from './verify-review-run-workflow.mjs'

const REVIEW_RUN_ID = '123456789'
const REVIEW_RUN_ATTEMPT = '3'
const HEAD_SHA = 'c'.repeat(40)

function workflowEnv(overrides = {}) {
  return {
    GITHUB_ACTIONS: 'true',
    GITHUB_REPOSITORY: 'Mochi96336/mochi-bus',
    INPUT_CONFIRMATION: 'APPLY',
    INPUT_REVIEW_RUN_ID: REVIEW_RUN_ID,
    INPUT_ARTIFACT_NAME: `instance-bundle-review-island-test-${REVIEW_RUN_ID}-${REVIEW_RUN_ATTEMPT}`,
    ...overrides,
  }
}

function runMetadata(overrides = {}) {
  return {
    id: Number(REVIEW_RUN_ID),
    run_attempt: Number(REVIEW_RUN_ATTEMPT),
    event: 'workflow_dispatch',
    status: 'completed',
    conclusion: 'success',
    path: '.github/workflows/review-instance-bundle.yml',
    repository: { full_name: 'Mochi96336/mochi-bus' },
    head_repository: { full_name: 'Mochi96336/mochi-bus' },
    head_branch: 'agent/review-source',
    head_sha: HEAD_SHA,
    ...overrides,
  }
}

async function withWorkspace(run) {
  const cwd = await mkdtemp(join(tmpdir(), 'mochi-review-run-'))
  const generated = join(cwd, '.generated')
  await mkdir(generated, { recursive: true })
  try {
    return await run({ cwd, metadataPath: join(generated, 'apply-review-run.json') })
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
}

async function writeMetadata(path, value = runMetadata()) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

describe('review workflow run identity verifier', () => {
  test('requires GitHub Actions, exact APPLY and matching artifact run identity', () => {
    expect(() => parseInstanceBundleReviewRunVerificationInputs(workflowEnv({
      GITHUB_ACTIONS: 'false',
    }))).toThrow('only inside GitHub Actions')
    expect(() => parseInstanceBundleReviewRunVerificationInputs(workflowEnv({
      INPUT_CONFIRMATION: 'apply',
    }))).toThrow('confirmation APPLY')
    expect(() => parseInstanceBundleReviewRunVerificationInputs(workflowEnv({
      INPUT_REVIEW_RUN_ID: '123456788',
    }))).toThrow('must match review_run_id')
  })

  test('accepts only the exact successful same-repository review workflow run', async () => {
    await withWorkspace(async ({ cwd, metadataPath }) => {
      await writeMetadata(metadataPath)
      const inputs = parseInstanceBundleReviewRunVerificationInputs(workflowEnv())
      const result = await verifyInstanceBundleReviewRunMetadata(inputs, { cwd })
      expect(result.ok).toBe(true)
      expect(result.reviewRunId).toBe(REVIEW_RUN_ID)
      expect(result.reviewRunAttempt).toBe(REVIEW_RUN_ATTEMPT)
      expect(result.workflowPath).toBe('.github/workflows/review-instance-bundle.yml')
      expect(result.headSha).toBe(HEAD_SHA)
    })
  })

  test.each([
    ['wrong workflow path', { path: '.github/workflows/ci.yml' }, 'must use'],
    ['wrong event', { event: 'push' }, 'workflow_dispatch'],
    ['failed conclusion', { conclusion: 'failure' }, 'completed successfully'],
    ['wrong attempt', { run_attempt: 2 }, 'attempt'],
    ['wrong repository', { repository: { full_name: 'Mochi96336/other' } }, 'repository'],
    ['wrong head repository', { head_repository: { full_name: 'fork/mochi-bus' } }, 'head repository'],
  ])('rejects %s', async (_label, overrides, message) => {
    await withWorkspace(async ({ cwd, metadataPath }) => {
      await writeMetadata(metadataPath, runMetadata(overrides))
      const inputs = parseInstanceBundleReviewRunVerificationInputs(workflowEnv())
      await expect(verifyInstanceBundleReviewRunMetadata(inputs, { cwd })).rejects.toThrow(message)
    })
  })

  test('rejects symbolic links, duplicate keys and invalid UTF-8', async () => {
    await withWorkspace(async ({ cwd, metadataPath }) => {
      const target = join(cwd, '.generated', 'target.json')
      await writeMetadata(target)
      await symlink(target, metadataPath)
      const inputs = parseInstanceBundleReviewRunVerificationInputs(workflowEnv())
      await expect(verifyInstanceBundleReviewRunMetadata(inputs, { cwd })).rejects.toThrow('regular file')
    })

    await withWorkspace(async ({ cwd, metadataPath }) => {
      await writeFile(metadataPath, '{"id":123456789,"id":123456789}\n', 'utf8')
      const inputs = parseInstanceBundleReviewRunVerificationInputs(workflowEnv())
      await expect(verifyInstanceBundleReviewRunMetadata(inputs, { cwd })).rejects.toThrow('Duplicate JSON object key')
    })

    await withWorkspace(async ({ cwd, metadataPath }) => {
      await writeFile(metadataPath, Buffer.from('{"id":"bad\xff"}', 'latin1'))
      const inputs = parseInstanceBundleReviewRunVerificationInputs(workflowEnv())
      await expect(verifyInstanceBundleReviewRunMetadata(inputs, { cwd })).rejects.toThrow('valid UTF-8')
    })
  })
})

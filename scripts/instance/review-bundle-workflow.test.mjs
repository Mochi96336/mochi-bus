import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  main,
  parseInstanceBundleReviewWorkflowInputs,
  resolveInstanceBundleReviewConfig,
  runInstanceBundleReviewWorkflow,
} from './review-bundle-workflow.mjs'

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
    r2: {
      bucketName: 'island-shapes',
    },
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

async function withWorkspace(run) {
  const cwd = await mkdtemp(join(tmpdir(), 'mochi-bundle-review-'))
  await writeFile(join(cwd, 'instance.json'), `${JSON.stringify(BASE_MANIFEST, null, 2)}\n`, 'utf8')
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
    GITHUB_RUN_ID: '123456789',
    GITHUB_RUN_ATTEMPT: '2',
    GITHUB_SHA: 'a'.repeat(40),
    GITHUB_REF: 'refs/heads/agent/review',
    GITHUB_STEP_SUMMARY: summaryPath,
    GITHUB_OUTPUT: outputPath,
    INPUT_CONFIRMATION: 'REVIEW',
    INPUT_CONFIG_PATH: 'instance.json',
    INPUT_CHANGES_JSON: '["--site-name","Island Transit"]',
    INPUT_EXPECTED_BUNDLE_HASH: '',
    ...overrides,
  }
}

describe('manual instance bundle review workflow', () => {
  test('requires GitHub Actions and the exact REVIEW confirmation', () => {
    expect(() => parseInstanceBundleReviewWorkflowInputs(workflowEnv({
      overrides: { GITHUB_ACTIONS: 'false' },
    }))).toThrow('only inside GitHub Actions')
    for (const invalid of ['review', ' REVIEW', 'REVIEW ', 'REVIEW\n', '\tREVIEW']) {
      expect(() => parseInstanceBundleReviewWorkflowInputs(workflowEnv({
        overrides: { INPUT_CONFIRMATION: invalid },
      }))).toThrow('confirmation REVIEW')
    }
  })

  test('parses a bounded JSON argument array and an optional reviewed hash', () => {
    const parsed = parseInstanceBundleReviewWorkflowInputs(workflowEnv({
      overrides: {
        INPUT_CHANGES_JSON: '["--worker-name","island-v2","--add-city","Kaohsiung"]',
        INPUT_EXPECTED_BUNDLE_HASH: 'b'.repeat(64),
      },
    }))
    expect(parsed.changes).toEqual(['--worker-name', 'island-v2', '--add-city', 'Kaohsiung'])
    expect(parsed.expectedBundleHash).toBe('b'.repeat(64))
    expect(parsed.sourceSha).toBe('a'.repeat(40))
  })

  test('rejects non-array input, oversized input and workflow control flags', () => {
    expect(() => parseInstanceBundleReviewWorkflowInputs(workflowEnv({
      overrides: { INPUT_CHANGES_JSON: '{"site":"Island"}' },
    }))).toThrow('JSON array')
    expect(() => parseInstanceBundleReviewWorkflowInputs(workflowEnv({
      overrides: { INPUT_CHANGES_JSON: JSON.stringify(Array.from({ length: 65 }, () => 'x')) },
    }))).toThrow('at most 64')
    for (const unsafe of [
      'Island\nInjected',
      'Island\tInjected',
      'Island\u001bInjected',
      'Island\u007fInjected',
      'Island\u202eInjected',
    ]) {
      expect(() => parseInstanceBundleReviewWorkflowInputs(workflowEnv({
        overrides: { INPUT_CHANGES_JSON: JSON.stringify(['--site-name', unsafe]) },
      }))).toThrow('control or bidirectional')
    }
    for (const forbidden of ['--write', '--config=instance.json', '--output', '--dry-run', '--expect-hash']) {
      expect(() => parseInstanceBundleReviewWorkflowInputs(workflowEnv({
        overrides: { INPUT_CHANGES_JSON: JSON.stringify([forbidden]) },
      }))).toThrow('cannot control workflow option')
    }
  })

  test('restricts config reads to regular repository instance JSON files', async () => {
    await withWorkspace(async ({ cwd }) => {
      for (const traversal of [
        '../outside.json',
        './instance.json',
        'instances/../instance.json',
        'instances\\..\\instance.json',
      ]) {
        await expect(resolveInstanceBundleReviewConfig(cwd, traversal)).rejects.toThrow('traversal segments')
      }
      await expect(resolveInstanceBundleReviewConfig(cwd, 'docs/example.json')).rejects.toThrow('inside instances')
      await writeFile(join(cwd, 'not-json.txt'), '{}', 'utf8')
      await expect(resolveInstanceBundleReviewConfig(cwd, 'not-json.txt')).rejects.toThrow('.json extension')
      await mkdir(join(cwd, 'instances'))
      await symlink(join(cwd, 'instance.json'), join(cwd, 'instances', 'linked.json'))
      await expect(resolveInstanceBundleReviewConfig(cwd, 'instances/linked.json')).rejects.toThrow('symbolic link')
      const valid = await resolveInstanceBundleReviewConfig(cwd, 'instance.json')
      expect(valid.displayPath).toBe('instance.json')
    })
  })

  test('creates and verifies one self-contained review directory', async () => {
    await withWorkspace(async ({ cwd, summaryPath, outputPath }) => {
      const inputs = parseInstanceBundleReviewWorkflowInputs(workflowEnv({ summaryPath, outputPath }))
      const result = await runInstanceBundleReviewWorkflow(inputs, { cwd, env: {} })
      expect(result.verification.ok).toBe(true)
      expect(result.artifact.bundle.proposal.manifest.site.name).toBe('Island Transit')
      expect(result.outputs.artifact_directory).toBe('.generated/review/workflow-123456789-2')

      const bundle = JSON.parse(await readFile(join(cwd, result.outputs.artifact_path), 'utf8'))
      const verification = JSON.parse(await readFile(join(cwd, result.outputs.verification_path), 'utf8'))
      expect(bundle.integrity.artifactHash).toBe(result.outputs.artifact_hash)
      expect(verification.bundleHash).toBe(result.outputs.bundle_hash)
      expect(verification.summary.failed).toBe(0)

      const outputs = await readFile(outputPath, 'utf8')
      expect(outputs).toContain(`artifact_name=${result.outputs.artifact_name}`)
      expect(outputs).toContain(`bundle_hash=${result.outputs.bundle_hash}`)
      expect(outputs).toContain(`artifact_hash=${result.outputs.artifact_hash}`)

      const summary = await readFile(summaryPath, 'utf8')
      expect(summary).toContain('Manual instance bundle review')
      expect(summary).toContain('This workflow is review-only.')
      expect(summary).toContain('Offline verification')
      expect(summary).toContain('change-bundle artifact: VERIFIED')
      expect(summary).toContain(result.outputs.bundle_hash)
      expect(summary).toContain(result.outputs.artifact_hash)
    })
  })

  test('renders reviewed values as inert Markdown code', async () => {
    await withWorkspace(async ({ cwd, summaryPath, outputPath }) => {
      const inputs = parseInstanceBundleReviewWorkflowInputs(workflowEnv({
        summaryPath,
        outputPath,
        overrides: {
          GITHUB_REF: 'refs/heads/agent/re`view',
          INPUT_CHANGES_JSON: JSON.stringify(['--site-name', 'Island `Transit`']),
        },
      }))
      await runInstanceBundleReviewWorkflow(inputs, { cwd, env: {} })

      const summary = await readFile(summaryPath, 'utf8')
      expect(summary).toContain('- Source ref: ``refs/heads/agent/re`view``')
      expect(summary).toContain('    ~ site.name: "Island Bus" → "Island `Transit`"')
      expect(summary).toContain("    Preview: npm run instance:update -- --config 'instance.json' --site-name 'Island `Transit`'")
      expect(summary).not.toContain('Island \\`Transit\\`')
    })
  })

  test('fails before writing when the reviewed bundle hash does not match', async () => {
    await withWorkspace(async ({ cwd, summaryPath, outputPath }) => {
      const inputs = parseInstanceBundleReviewWorkflowInputs(workflowEnv({
        summaryPath,
        outputPath,
        overrides: { INPUT_EXPECTED_BUNDLE_HASH: 'f'.repeat(64) },
      }))
      await expect(runInstanceBundleReviewWorkflow(inputs, { cwd, env: {} })).rejects.toThrow('hash mismatch')
      await expect(access(join(cwd, '.generated/review/workflow-123456789-2/bundle.json'))).rejects.toThrow()
      expect(await readFile(summaryPath, 'utf8')).toBe('')
      expect(await readFile(outputPath, 'utf8')).toBe('')
    })
  })

  test('does not copy unrelated credential environment values into evidence', async () => {
    await withWorkspace(async ({ cwd, summaryPath, outputPath }) => {
      const secret = 'workflow-secret-value'
      const env = workflowEnv({
        summaryPath,
        outputPath,
        overrides: {
          TDX_CLIENT_SECRET: secret,
          CLOUDFLARE_API_TOKEN: secret,
          R2_SECRET_ACCESS_KEY: secret,
        },
      })
      const inputs = parseInstanceBundleReviewWorkflowInputs(env)
      const result = await runInstanceBundleReviewWorkflow(inputs, { cwd, env })
      const evidence = [
        await readFile(join(cwd, result.outputs.artifact_path), 'utf8'),
        await readFile(join(cwd, result.outputs.verification_path), 'utf8'),
        await readFile(summaryPath, 'utf8'),
        await readFile(outputPath, 'utf8'),
      ].join('\n')
      expect(evidence).not.toContain(secret)
    })
  })

  test('main prints only the verified identity after all files and summaries succeed', async () => {
    await withWorkspace(async ({ cwd, summaryPath, outputPath }) => {
      let stdout = ''
      const result = await main({
        cwd,
        env: workflowEnv({ summaryPath, outputPath }),
        stdout: { write(value) { stdout += value } },
      })
      const record = JSON.parse(stdout)
      expect(record.message).toBe('instance_bundle_review_verified')
      expect(record.bundleHash).toBe(result.outputs.bundle_hash)
      expect(record.artifactHash).toBe(result.outputs.artifact_hash)
    })
  })
})

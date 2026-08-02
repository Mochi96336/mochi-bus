import { readFile } from 'node:fs/promises'
import { describe, expect, test } from 'vitest'

const gateUrl = new URL('./check-bundle-freshness.mjs', import.meta.url)
const packageUrl = new URL('../../package.json', import.meta.url)
const reviewRunnerUrl = new URL('./review-bundle-workflow.mjs', import.meta.url)
const reviewTestUrl = new URL('./review-bundle-workflow.test.mjs', import.meta.url)
const documentationUrl = new URL('../../docs/INSTANCE_BUNDLE_STALENESS.md', import.meta.url)
const reviewDocumentationUrl = new URL('../../docs/INSTANCE_BUNDLE_REVIEW_WORKFLOW.md', import.meta.url)

async function source(url) {
  return readFile(url, 'utf8')
}

describe('instance bundle staleness gate contracts', () => {
  test('exposes one read-only npm command without subprocess or network access', async () => {
    const [gate, packageSource] = await Promise.all([source(gateUrl), source(packageUrl)])
    expect(packageSource).toContain('"instance:check-bundle-freshness": "node scripts/instance/check-bundle-freshness.mjs"')
    expect(gate).not.toMatch(/node:child_process|\bexec(File|Sync)?\b|\bspawn(Sync)?\b/)
    expect(gate).not.toMatch(/node:https|node:http|undici|\bfetch\s*\(/)
    expect(gate).not.toMatch(/writeFile|rename|link|unlink|rm\s*\(/)
    expect(gate).toContain('readInstanceBundleArtifact')
    expect(gate).toContain('verifyInstanceBundleArtifact')
    expect(gate).toContain("open(configPath, constants.O_RDONLY | noFollow)")
  })

  test('fails closed on bytes, identity, path and artifact integrity', async () => {
    const gate = await source(gateUrl)
    expect(gate).toContain("status: 'blocked'")
    expect(gate).toContain("status === 'fresh'")
    expect(gate).toContain("'formatting_drift'")
    expect(gate).toContain("'semantic_drift'")
    expect(gate).toContain("'already_applied'")
    expect(gate).toContain("id: 'source-bytes'")
    expect(gate).toContain("id: 'baseline-manifest'")
    expect(gate).toContain("id: 'instance-id'")
    expect(gate).toContain("id: 'config-path'")
    expect(gate).toContain("if (report.status !== 'fresh')")
  })

  test('uses bounded strict reads and never executes the reviewed apply command', async () => {
    const gate = await source(gateUrl)
    expect(gate).toContain('MAX_INSTANCE_MANIFEST_BYTES = 1024 * 1024')
    expect(gate).toContain('parseStrictJson(source)')
    expect(gate).toContain('O_NOFOLLOW')
    expect(gate).toContain("FORBIDDEN_CONFIG_DIRECTORIES = new Set(['.git', '.generated', 'node_modules'])")
    expect(gate).toContain('proposal.applyCommand')
    expect(gate).not.toMatch(/\b(instance:update|applyCommand)\b[\s\S]{0,80}\b(exec|spawn)\b/)
    expect(gate).toContain('NO FILES WERE CHANGED')
  })

  test('review workflow persists verified freshness evidence', async () => {
    const [runner, tests] = await Promise.all([source(reviewRunnerUrl), source(reviewTestUrl)])
    expect(runner).toContain('checkInstanceBundleFreshnessFile')
    expect(runner).toContain('freshness.json')
    expect(runner).toContain('freshness_path')
    expect(runner).toContain('renderInstanceBundleFreshnessText')
    expect(runner).toContain('indentCodeBlock(renderInstanceBundleFreshnessText')
    expect(tests).toContain('freshness.status')
    expect(tests).toContain('freshness_path')
  })

  test('documentation separates freshness from atomic apply and deployment readiness', async () => {
    const [documentation, reviewDocumentation] = await Promise.all([
      source(documentationUrl),
      source(reviewDocumentationUrl),
    ])
    expect(documentation).toContain('fresh')
    expect(documentation).toContain('stale')
    expect(documentation).toContain('blocked')
    expect(documentation).toContain('formatting_drift')
    expect(documentation).toContain('already_applied')
    expect(documentation).toContain('does not lock')
    expect(documentation).toContain('does not execute')
    expect(reviewDocumentation).toContain('freshness.json')
  })
})

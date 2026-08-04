import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  buildInstanceChangeBundle,
  parseInstanceChangeBundleArguments,
  renderInstanceChangeBundleText,
} from './change-bundle.mjs'
import { buildInstanceMigrationPlanFromProposal } from './migration-plan.mjs'
import { buildInstanceUpdate } from './update.mjs'

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
    demoQuery: {
      city: 'Taipei',
      routeName: '307',
      stopName: '捷運西門站',
      stopUid: 'TPE213044',
      routeUid: 'TPE19108',
      direction: 0,
    },
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

async function withManifest(run) {
  const cwd = await mkdtemp(join(tmpdir(), 'mochi-change-bundle-regression-'))
  const configPath = 'instance.json'
  await writeFile(join(cwd, configPath), `${JSON.stringify(BASE_MANIFEST, null, 2)}\n`, 'utf8')
  try {
    return await run({ cwd, configPath })
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
}

describe('instance change bundle regressions', () => {
  test('derives the migration plan from the exact updater proposal object', async () => {
    await withManifest(async ({ cwd, configPath }) => {
      const parsed = parseInstanceChangeBundleArguments([
        '--config', configPath,
        '--site-name', 'Island Transit',
      ])
      const proposal = await buildInstanceUpdate(parsed.updateOptions, { cwd, env: {} })
      const plan = buildInstanceMigrationPlanFromProposal(proposal, parsed.updateOptions)

      expect(plan.proposal.changes).toBe(proposal.changes)
      expect(plan.proposal.warnings).toBe(proposal.warnings)
      expect(plan.instance.id).toBe(proposal.manifest.instanceId)
    })
  })

  test('keeps clear-demo-query and the selected output directory in the verification command', async () => {
    await withManifest(async ({ cwd, configPath }) => {
      const bundle = await buildInstanceChangeBundle(parseInstanceChangeBundleArguments([
        '--config', configPath,
        '--clear-demo-query',
        '--out-dir', '.generated/review',
      ]), { cwd, env: {} })
      const output = renderInstanceChangeBundleText(bundle)

      expect(bundle.consistency.verification).toBe(
        'migration plan was derived from the same immutable updater proposal',
      )
      expect(output).toContain(
        "Verify hash: npm run instance:change-bundle -- --config 'instance.json' --clear-demo-query --out-dir '.generated/review' --expect-hash",
      )
    })
  })

  test('keeps the requested no-op option in the verification command', async () => {
    await withManifest(async ({ cwd, configPath }) => {
      const bundle = await buildInstanceChangeBundle(parseInstanceChangeBundleArguments([
        '--config', configPath,
        '--site-name', 'Island Bus',
      ]), { cwd, env: {} })
      const output = renderInstanceChangeBundleText(bundle)

      expect(bundle.changed).toBe(false)
      expect(output).toContain(
        "Verify hash: npm run instance:change-bundle -- --config 'instance.json' --site-name 'Island Bus' --out-dir '.generated/instance' --expect-hash",
      )
    })
  })
})
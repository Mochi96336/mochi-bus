import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  classifyRoutingAuthorityPresence,
  collectHighCardRetirementReadiness,
  normalizePublishedVersions,
  summarizeRetainedAuthorityWindow,
} from './high-card-retirement-readiness.mjs'

const source = readFileSync('scripts/transit-snapshot/high-card-retirement-readiness.mjs', 'utf8')
const workflow = readFileSync('.github/workflows/snapshot-high-card-retirement-readiness.yml', 'utf8')

function authority(mode, routingManifestCount) {
  return { mode, routingManifestCount }
}

describe('legacy high-card D1 retirement authority readiness', () => {
  it('is authority-ready only when every retained active/previous window is root-bound', async () => {
    const report = await collectHighCardRetirementReadiness({
      env: { GITHUB_SHA: 'abc123', GITHUB_RUN_ID: '42', GITHUB_RUN_ATTEMPT: '1' },
      now: () => new Date('2026-09-10T00:00:00.000Z'),
      listPublishedVersions: async () => [
        { city_code: 'Taichung', active_version: 'tc-v2' },
        { city_code: 'Taipei', active_version: 'tp-v2' },
      ],
      readWindow: async ({ city, activeVersion }) => ({
        activeVersion,
        previousVersion: city === 'Taichung' ? 'tc-v1' : 'tp-v1',
        activeAuthority: authority('root-bound', 4),
        previousAuthority: authority('root-bound', 4),
      }),
    })

    expect(report).toMatchObject({
      schemaVersion: 2,
      kind: 'snapshot-high-card-d1-retirement-readiness',
      sourceCommit: 'abc123',
      cityCount: 2,
      rootBoundCityCount: 2,
      rootBoundAuthorityReady: true,
      blockingCities: [],
    })
    expect(report.cities.map((city) => city.city)).toEqual(['Taichung', 'Taipei'])
  })

  it('reports legacy and historical partial backfill windows as blockers', async () => {
    const report = await collectHighCardRetirementReadiness({
      listPublishedVersions: async () => [
        { city_code: 'Taipei', active_version: 'tp-v2' },
        { city_code: 'Taichung', active_version: 'tc-v0' },
      ],
      readWindow: async ({ city, activeVersion }) => city === 'Taipei'
        ? {
            activeVersion,
            previousVersion: 'tp-v1',
            activeAuthority: authority('root-bound', 4),
            previousAuthority: authority('root-bound', 4),
          }
        : {
            activeVersion,
            previousVersion: 'tc-old',
            activeAuthority: authority('legacy-partial', 2),
            previousAuthority: authority('legacy-d1', 0),
          },
    })

    expect(report.rootBoundAuthorityReady).toBe(false)
    expect(report.rootBoundCityCount).toBe(1)
    expect(report.blockingCities).toEqual([{
      city: 'Taichung',
      activeVersion: 'tc-v0',
      previousVersion: 'tc-old',
      activeAuthorityMode: 'legacy-partial',
      previousAuthorityMode: 'legacy-d1',
      activeRoutingManifestCount: 2,
      previousRoutingManifestCount: 0,
      nativeRootBoundPublicationsRequired: 2,
    }])
  })

  it('classifies unbound partial completion manifests as historical legacy state', () => {
    const keys = ['pattern', 'place', 'transfer', 'stop']
    expect(classifyRoutingAuthorityPresence({
      keys,
      heads: [{}, {}, null, null],
      manifestArtifacts: [{ key: 'unrelated' }],
    })).toEqual({ mode: 'legacy-partial', routingManifestCount: 2 })
    expect(classifyRoutingAuthorityPresence({
      keys,
      heads: [null, null, null, null],
      manifestArtifacts: [],
    })).toEqual({ mode: 'legacy-d1', routingManifestCount: 0 })
    expect(classifyRoutingAuthorityPresence({
      keys,
      heads: [{}, {}, {}, {}],
      manifestArtifacts: [],
    })).toBeNull()
  })

  it('still fails closed when root claims routing authority but the retained objects are partial', () => {
    const keys = ['pattern', 'place', 'transfer', 'stop']
    expect(() => classifyRoutingAuthorityPresence({
      keys,
      heads: [{}, {}, null, null],
      manifestArtifacts: keys.map((key) => ({ key })),
    })).toThrow(/root-bound routing authority is missing/)
    expect(() => classifyRoutingAuthorityPresence({
      keys,
      heads: [{}, {}, {}, {}],
      manifestArtifacts: [{ key: 'pattern' }],
    })).toThrow(/partial routing authority binding/)
  })

  it('preserves native-publication readiness semantics across partial legacy modes', () => {
    expect(summarizeRetainedAuthorityWindow({
      activeVersion: 'v2',
      previousVersion: 'v1',
      activeAuthority: authority('root-bound', 4),
      previousAuthority: authority('legacy-partial', 3),
    })).toMatchObject({
      rootBoundRollbackWindow: false,
      nativeRootBoundPublicationsRequired: 1,
      previousAuthorityMode: 'legacy-partial',
      previousRoutingManifestCount: 3,
    })
    expect(summarizeRetainedAuthorityWindow({
      activeVersion: 'v2',
      previousVersion: 'v1',
      activeAuthority: authority('legacy-partial', 1),
      previousAuthority: authority('root-bound', 4),
    })).toMatchObject({
      rootBoundRollbackWindow: false,
      nativeRootBoundPublicationsRequired: 2,
    })
  })

  it('fails closed on empty, duplicate, unsafe, mismatched, or inconsistent authority evidence', async () => {
    expect(() => normalizePublishedVersions([])).toThrow(/bounded non-empty/)
    expect(() => normalizePublishedVersions([
      { city_code: 'Taipei', active_version: 'v1' },
      { city_code: 'Taipei', active_version: 'v2' },
    ])).toThrow(/published city set is invalid/)
    expect(() => normalizePublishedVersions([
      { city_code: '../Taipei', active_version: 'v1' },
    ])).toThrow(/published city set is invalid/)
    expect(() => summarizeRetainedAuthorityWindow({
      activeVersion: 'v2',
      previousVersion: 'v1',
      activeAuthority: authority('legacy-partial', 4),
      previousAuthority: authority('root-bound', 4),
    })).toThrow(/assessment is inconsistent/)

    await expect(collectHighCardRetirementReadiness({
      listPublishedVersions: async () => [{ city_code: 'Taipei', active_version: 'v2' }],
      readWindow: async () => ({
        activeVersion: 'v3',
        previousVersion: 'v1',
        activeAuthority: authority('root-bound', 4),
        previousAuthority: authority('root-bound', 4),
      }),
    })).rejects.toThrow(/active pointer changed/)
  })

  it('uses one low-card city/version query and never scans or mutates the legacy high-card tables', () => {
    expect(source).toContain('SELECT city_code, active_version FROM dataset_versions ORDER BY city_code')
    expect(source).not.toMatch(/FROM\s+(?:stops|pattern_stops)\b/i)
    expect(source).not.toMatch(/(?:INSERT\s+INTO|DELETE\s+FROM|UPDATE|DROP\s+TABLE|ALTER\s+TABLE)\s+(?:stops|pattern_stops)\b/i)
    expect(source).not.toContain('TDX_CLIENT_ID')
    expect(source).not.toContain('TDX_CLIENT_SECRET')
    expect(source).not.toContain('sync-transit-snapshot')
    expect(source).not.toContain('run-snapshot-window')
  })

  it('keeps the proof workflow read-only, non-recurring, and free of TDX/publication authority', () => {
    expect(workflow).toContain('workflow_dispatch:')
    expect(workflow).toContain("branches:\n      - main")
    expect(workflow).not.toContain('schedule:')
    expect(workflow).toContain('permissions:\n  contents: read')
    expect(workflow).toContain('high-card-retirement-readiness.mjs')
    expect(workflow).toContain('CLOUDFLARE_API_TOKEN')
    expect(workflow).toContain('R2_ACCESS_KEY_ID')
    expect(workflow).not.toContain('TDX_CLIENT_ID')
    expect(workflow).not.toContain('TDX_CLIENT_SECRET')
    expect(workflow).not.toContain('wrangler deploy')
    expect(workflow).not.toContain('snapshot:city')
    expect(workflow).not.toContain('snapshot:window')
  })

  it('does not present authority readiness as sufficient cleanup authorization', () => {
    expect(source).toContain('rootBoundAuthorityReady')
    expect(source).not.toContain('readyForLegacyHighCardRetirement')
    expect(source).toContain('Cleanup still requires the separate #249 acceptance evidence and explicit mutation authorization.')
  })
})

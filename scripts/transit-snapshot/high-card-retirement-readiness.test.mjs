import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  collectHighCardRetirementReadiness,
  normalizePublishedVersions,
} from './high-card-retirement-readiness.mjs'

const source = readFileSync('scripts/transit-snapshot/high-card-retirement-readiness.mjs', 'utf8')
const workflow = readFileSync('.github/workflows/snapshot-high-card-retirement-readiness.yml', 'utf8')

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
        activeMode: 'root-bound',
        previousMode: 'root-bound',
      }),
    })

    expect(report).toMatchObject({
      kind: 'snapshot-high-card-d1-retirement-readiness',
      sourceCommit: 'abc123',
      cityCount: 2,
      rootBoundCityCount: 2,
      rootBoundAuthorityReady: true,
      blockingCities: [],
    })
    expect(report.cities.map((city) => city.city)).toEqual(['Taichung', 'Taipei'])
  })

  it('reports legacy retained windows as blockers without treating normal migration state as an evidence failure', async () => {
    const report = await collectHighCardRetirementReadiness({
      listPublishedVersions: async () => [
        { city_code: 'Taipei', active_version: 'tp-v2' },
        { city_code: 'Taichung', active_version: 'tc-v0' },
      ],
      readWindow: async ({ city, activeVersion }) => city === 'Taipei'
        ? {
            activeVersion,
            previousVersion: 'tp-v1',
            activeMode: 'root-bound',
            previousMode: 'root-bound',
          }
        : {
            activeVersion,
            previousVersion: 'tc-old',
            activeMode: 'legacy-backfill',
            previousMode: 'legacy-d1',
          },
    })

    expect(report.rootBoundAuthorityReady).toBe(false)
    expect(report.rootBoundCityCount).toBe(1)
    expect(report.blockingCities).toEqual([{
      city: 'Taichung',
      activeVersion: 'tc-v0',
      previousVersion: 'tc-old',
      activeAuthorityMode: 'legacy-backfill',
      previousAuthorityMode: 'legacy-d1',
      nativeRootBoundPublicationsRequired: 2,
    }])
  })

  it('fails closed on empty, duplicate, unsafe, or mismatched published authority', async () => {
    expect(() => normalizePublishedVersions([])).toThrow(/bounded non-empty/)
    expect(() => normalizePublishedVersions([
      { city_code: 'Taipei', active_version: 'v1' },
      { city_code: 'Taipei', active_version: 'v2' },
    ])).toThrow(/published city set is invalid/)
    expect(() => normalizePublishedVersions([
      { city_code: '../Taipei', active_version: 'v1' },
    ])).toThrow(/published city set is invalid/)

    await expect(collectHighCardRetirementReadiness({
      listPublishedVersions: async () => [{ city_code: 'Taipei', active_version: 'v2' }],
      readWindow: async () => ({
        activeVersion: 'v3',
        previousVersion: 'v1',
        activeMode: 'root-bound',
        previousMode: 'root-bound',
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

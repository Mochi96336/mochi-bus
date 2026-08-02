import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import {
  main,
  resolveReleaseSmokeTargets,
  selectCatalogueRouteSample,
  validateCatalogueRouteContract,
  waitForBrowserReleaseIdentity,
} from './run-post-deploy.mjs'

const source = readFileSync(new URL('./run-post-deploy.mjs', import.meta.url), 'utf8')
const expectedSha = '0123456789abcdef0123456789abcdef01234567'
const expectedWorkerVersionId = 'worker-version-1'
const release = (
  releaseSha = expectedSha,
  workerVersionId = expectedWorkerVersionId,
) => ({
  schemaVersion: 1,
  releaseSha,
  workerVersionId,
  workerCreatedAt: '2026-07-22T16:30:00.000Z',
})

describe('post-deploy smoke CLI adapter', () => {
  it('loads without running production traffic during import', () => {
    expect(main).toBeTypeOf('function')
    expect(source).toContain("if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)")
  })

  it('keeps failures bounded and does not print raw errors or response bodies', () => {
    expect(source).not.toMatch(/console\.error\([^\n]*(?:error\.message|error\.stack|response\.body|request\.url)/)
    expect(source).not.toContain('console.error(error)')
    expect(source).toContain('safeReleaseSmokeDiagnostic(error, expectedSha)')
  })

  it('preserves production city and demo-route coverage from runtime identity', () => {
    expect(resolveReleaseSmokeTargets({
      enabledCities: ['Taipei', 'NewTaipei', 'Taoyuan', 'Chiayi'],
      defaultCity: 'Taipei',
      demoQuery: { city: 'Taipei', routeName: '307' },
    })).toEqual({
      cities: ['Taipei', 'Chiayi'],
      defaultCity: 'Taipei',
      detailCity: 'Taipei',
      routeName: '307',
      pages: [
        { path: '/', selector: '.eta-page' },
        { path: '/setup', selector: '.setup-page #board-list' },
        { path: '/map?city=Taipei', selector: '#map-app', bootSelector: '.leaflet-container' },
      ],
    })
  })

  it('scopes a no-demo single-city instance to its only enabled city', () => {
    expect(resolveReleaseSmokeTargets({
      enabledCities: ['Chiayi'],
      defaultCity: 'Chiayi',
      demoQuery: null,
    })).toEqual({
      cities: ['Chiayi'],
      defaultCity: 'Chiayi',
      detailCity: 'Chiayi',
      routeName: null,
      pages: [
        { path: '/', selector: '.eta-page' },
        { path: '/setup', selector: '.setup-page #board-list' },
        { path: '/map?city=Chiayi', selector: '#map-app', bootSelector: '.leaflet-container' },
      ],
    })
  })

  it('falls back to enabled-city order when the cross-tier canary is unavailable', () => {
    expect(resolveReleaseSmokeTargets({
      enabledCities: ['Kaohsiung', 'PingtungCounty', 'TaitungCounty'],
      defaultCity: 'Kaohsiung',
      demoQuery: null,
    }).cities).toEqual(['Kaohsiung', 'PingtungCounty'])
    expect(() => resolveReleaseSmokeTargets({
      enabledCities: ['Chiayi'],
      defaultCity: 'Taipei',
      demoQuery: null,
    })).toThrowError(expect.objectContaining({ code: 'release_identity_invalid' }))
  })

  it('derives explicit and no-demo route samples without catalogue-order dependence', () => {
    const catalogue = {
      routes: [
        { routeName: '藍線', routeUid: 'CY-BLUE' },
        { routeName: '307', routeUid: 'TPE307-B' },
        { routeName: '307', routeUid: 'TPE307-A' },
        { routeName: '307', routeUid: 'TPE307-A' },
        { routeName: '1', routeUid: 'CY-ONE' },
      ],
    }
    expect(selectCatalogueRouteSample(catalogue, '307')).toEqual({
      routeName: '307',
      routeUids: ['TPE307-A', 'TPE307-B'],
    })
    expect(selectCatalogueRouteSample(catalogue)).toEqual({
      routeName: '1',
      routeUids: ['CY-ONE'],
    })
    expect(() => selectCatalogueRouteSample(catalogue, 'missing'))
      .toThrowError(expect.objectContaining({ code: 'route_sample_missing' }))
  })

  it('accepts a usable route variant when its UID intersects the catalogue sample', () => {
    const sample = { routeName: '307', routeUids: ['TPE307-A', 'TPE307-B'] }
    const validVariant = {
      variantKey: 'PATTERN-B',
      routeName: '307',
      routeUid: 'TPE307-B',
      stops: {
        features: [
          { properties: { stopUid: 'STOP-1' } },
          { properties: { stopUid: 'STOP-2' } },
        ],
      },
    }
    const detail = {
      schemaVersion: 1,
      city: 'Taipei',
      routeName: '307',
      source: 'snapshot',
      variants: [{ ...validVariant, routeUid: 'TPE-OTHER' }, validVariant],
    }
    expect(validateCatalogueRouteContract(detail, 'Taipei', sample)).toBe(validVariant)
    expect(() => validateCatalogueRouteContract({
      ...detail,
      variants: [{ ...validVariant, routeUid: 'TPE-OTHER' }],
    }, 'Taipei', sample)).toThrowError(expect.objectContaining({ code: 'route_contract_invalid' }))
  })

  it('uses target identity instead of fixed city URLs or a hardcoded route UID', () => {
    expect(source).toContain('resolveReleaseSmokeTargets(resources)')
    expect(source).toContain('for (const city of targets.cities)')
    expect(source).toContain('selectCatalogueRouteSample(detailRoutes, targets.routeName)')
    expect(source).toContain('encodeURIComponent(targets.detailCity)')
    expect(source).not.toContain('const REPRESENTATIVE_CITIES')
    expect(source).not.toContain('const TAIPEI_ROUTE_SAMPLE')
    expect(source).not.toContain('taipei.routes[0]')
    expect(source).not.toContain('TPE19108')
    expect(source).not.toMatch(/routeUid=\$\{encodeURIComponent\(route\./)
  })

  it('waits for the expected release inside the fresh browser context', async () => {
    let clock = 0
    const readRelease = vi.fn()
      .mockResolvedValueOnce(release('f'.repeat(40)))
      .mockResolvedValueOnce(release(expectedSha, 'worker-version-old'))
      .mockResolvedValueOnce(release())

    await expect(waitForBrowserReleaseIdentity({
      expectedSha,
      expectedWorkerVersionId,
      readRelease,
      now: () => clock,
      sleep: async (milliseconds) => { clock += milliseconds },
      timeoutMs: 5_000,
      pollIntervalMs: 1_000,
    })).resolves.toEqual(release())

    expect(readRelease).toHaveBeenCalledTimes(3)
    expect(clock).toBe(2_000)
  })

  it('classifies persistent browser edge mismatch without leaking release_not_observed', async () => {
    let clock = 0
    await expect(waitForBrowserReleaseIdentity({
      expectedSha,
      expectedWorkerVersionId,
      readRelease: vi.fn(async () => release('f'.repeat(40))),
      now: () => clock,
      sleep: async (milliseconds) => { clock += milliseconds },
      timeoutMs: 2_000,
      pollIntervalMs: 1_000,
    })).rejects.toMatchObject({ code: 'release_propagation_timeout' })
  })

  it('classifies a persistently unreadable browser release endpoint as observation failure', async () => {
    let clock = 0
    await expect(waitForBrowserReleaseIdentity({
      expectedSha,
      expectedWorkerVersionId,
      readRelease: vi.fn(async () => null),
      now: () => clock,
      sleep: async (milliseconds) => { clock += milliseconds },
      timeoutMs: 2_000,
      pollIntervalMs: 1_000,
    })).rejects.toMatchObject({ code: 'release_observation_failed' })
  })

  it('observes the exact browser release before navigating each target page', () => {
    const gate = source.indexOf('await waitForBrowserReleaseIdentity({')
    const targetNavigation = source.indexOf('const response = await page.goto(addProbe(target.path')

    expect(gate).toBeGreaterThan(-1)
    expect(targetNavigation).toBeGreaterThan(gate)
    expect(source).toContain("addProbe('/api/v1/health/release', token, 'browser-release')")
    expect(source).toContain('page.goto(browserReleasePath')
    expect(source).not.toContain("fetch('/api/v1/health/release', { cache: 'no-store' })")
  })
})

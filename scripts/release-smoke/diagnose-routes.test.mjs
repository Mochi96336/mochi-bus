import { describe, expect, it, vi } from 'vitest'
import {
  classifyPublicErrorPayload,
  diagnoseRoutes,
  resolveDiagnosticTargets,
  summarizeRoutesPayload,
} from './diagnose-routes.mjs'

const healthy = {
  schemaVersion: 2,
  city: 'Taipei',
  source: 'snapshot',
  snapshotVersion: '2026-09-09T00:00:00Z',
  routes: [{ routeName: '307', routeUid: 'TPE307' }],
}

describe('release routes diagnostic', () => {
  it('uses the same two-city production canary shape without accepting unsafe origins', () => {
    expect(resolveDiagnosticTargets({
      publicOrigin: 'https://bus.example',
      enabledCities: ['Taipei', 'NewTaipei', 'Chiayi'],
      defaultCity: 'Taipei',
      demoQuery: { city: 'Taipei', routeName: '307' },
    })).toEqual({ origin: 'https://bus.example', cities: ['Taipei', 'Chiayi'] })
    expect(() => resolveDiagnosticTargets({
      publicOrigin: 'http://bus.example',
      enabledCities: ['Taipei'],
      defaultCity: 'Taipei',
      demoQuery: null,
    })).toThrow('invalid diagnostic configuration')
  })

  it('reports only bounded contract metadata for healthy and fallback payloads', () => {
    expect(summarizeRoutesPayload(healthy, 'Taipei', {
      status: 200,
      contentType: 'application/json; charset=utf-8',
    })).toEqual({
      city: 'Taipei',
      result: 'ok',
      stage: 'contract_ok',
      status: 200,
      contentType: 'json',
      publicErrorClass: 'not_applicable',
      schemaVersion: 2,
      responseCityMatches: true,
      source: 'snapshot',
      snapshotVersionValid: true,
      routeCount: 1,
      invalidRouteIdentityCount: 0,
      contractReason: null,
    })

    const fallback = summarizeRoutesPayload({
      ...healthy,
      source: 'tdx',
      snapshotVersion: null,
      routes: [],
      secret: 'token=https://secret.example',
    }, 'Taipei', { status: 200, contentType: 'application/json' })
    expect(fallback).toMatchObject({
      result: 'error',
      stage: 'contract',
      source: 'tdx',
      routeCount: 0,
      contractReason: 'source',
    })
    expect(JSON.stringify(fallback)).not.toMatch(/secret|token=|https:\/\//i)
  })

  it('distinguishes HTTP, content-type and JSON failures without exposing response bodies', async () => {
    const responses = [
      new Response('token=https://secret.example', { status: 503, headers: { 'Content-Type': 'text/plain' } }),
      new Response('<html>secret</html>', { status: 200, headers: { 'Content-Type': 'text/html' } }),
      new Response('{"secret":', { status: 200, headers: { 'Content-Type': 'application/json' } }),
    ]
    const fetchImpl = vi.fn(async () => responses.shift())
    const reports = await diagnoseRoutes({
      origin: 'https://bus.example',
      cities: ['Taipei', 'Chiayi', 'Kaohsiung'],
      fetchImpl,
    })

    expect(reports.map(({ city, stage, status, contentType }) => ({ city, stage, status, contentType }))).toEqual([
      { city: 'Taipei', stage: 'http_status', status: 503, contentType: 'other' },
      { city: 'Chiayi', stage: 'content_type', status: 200, contentType: 'html' },
      { city: 'Kaohsiung', stage: 'json_parse', status: 200, contentType: 'json' },
    ])
    expect(JSON.stringify(reports)).not.toMatch(/secret|token=|<html>|bus\.example/i)
  })

  it('classifies known public error messages without copying arbitrary bodies into diagnostics', async () => {
    expect(classifyPublicErrorPayload({
      error: '共用的 TDX 額度可能已用完，暫時查不到即時到站；地圖與已同步路網仍可使用，也可到「我的公車」的進階設定填自己的 TDX 憑證。',
    })).toBe('tdx_quota')
    expect(classifyPublicErrorPayload({ error: '暫時無法取得公車資料' })).toBe('generic')
    expect(classifyPublicErrorPayload({ error: 'token=https://secret.example' })).toBe('unknown')

    const responses = [
      new Response(JSON.stringify({
        error: '共用的 TDX 額度可能已用完，暫時查不到即時到站；地圖與已同步路網仍可使用，也可到「我的公車」的進階設定填自己的 TDX 憑證。',
      }), { status: 502, headers: { 'Content-Type': 'application/json' } }),
      new Response(JSON.stringify({ error: 'token=https://secret.example' }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      }),
    ]
    const reports = await diagnoseRoutes({
      origin: 'https://bus.example',
      cities: ['Taipei', 'Chiayi'],
      fetchImpl: vi.fn(async () => responses.shift()),
    })

    expect(reports.map(({ city, stage, status, publicErrorClass }) => ({
      city, stage, status, publicErrorClass,
    }))).toEqual([
      { city: 'Taipei', stage: 'http_status', status: 502, publicErrorClass: 'tdx_quota' },
      { city: 'Chiayi', stage: 'http_status', status: 502, publicErrorClass: 'unknown' },
    ])
    expect(JSON.stringify(reports)).not.toMatch(/token=|secret\.example|共用的 TDX 額度|暫時無法取得公車資料/)
  })

  it('classifies malformed route identities without copying them into diagnostics', () => {
    const report = summarizeRoutesPayload({
      ...healthy,
      routes: [{ routeName: '', routeUid: 'token=https://secret.example' }],
    }, 'Taipei', { status: 200, contentType: 'application/json' })
    expect(report).toMatchObject({
      result: 'error',
      contractReason: 'route_identity',
      routeCount: 1,
      invalidRouteIdentityCount: 1,
    })
    expect(JSON.stringify(report)).not.toContain('token=')
  })
})

import { describe, expect, it, vi } from 'vitest'
import {
  createPublicApiAdapter,
  createRouteSampleObserver,
} from './run-public-probe.mjs'
import {
  publicProbeBodyLimitDetail,
  readPublicProbeJson,
} from './public-probe-response.mjs'

const MIB = 1024 * 1024

async function captureError(promise) {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('Expected promise to reject')
}

function streamedResponse(byteLength) {
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(byteLength))
      controller.close()
    },
  }))
}

describe('public probe bounded response diagnostics', () => {
  it.each([
    [3 * MIB, 'gt_limit_to_2x'],
    [6 * MIB, 'gt_2x_to_4x'],
    [10 * MIB, 'gt_4x'],
  ])('buckets declared response sizes without exposing raw bytes (%s)', async (declaredLength, responseSizeBucket) => {
    const error = await captureError(readPublicProbeJson(new Response('{}', {
      headers: { 'Content-Length': String(declaredLength) },
    }), 2 * MIB))

    expect(error.message).toBe('Bounded response is too large')
    expect(publicProbeBodyLimitDetail(error)).toEqual({
      responseSizeSource: 'content_length',
      responseSizeBucket,
    })
    expect(JSON.stringify(publicProbeBodyLimitDetail(error))).not.toContain(String(declaredLength))
  })

  it.each([
    [5, 'gt_limit_to_2x'],
    [9, 'gt_2x_to_4x'],
    [17, 'gt_4x'],
  ])('buckets streamed response sizes without retaining bytes above the read limit (%s)', async (byteLength, responseSizeBucket) => {
    const error = await captureError(readPublicProbeJson(streamedResponse(byteLength), 4))

    expect(error.message).toBe('Bounded response is too large')
    expect(publicProbeBodyLimitDetail(error)).toEqual({
      responseSizeSource: 'stream',
      responseSizeBucket,
    })
    expect(JSON.stringify(publicProbeBodyLimitDetail(error))).not.toContain(String(byteLength))
  })

  it('keeps successful streamed JSON reads unchanged while the diagnostic branch is consumed concurrently', async () => {
    const response = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"ok":true}'))
        controller.close()
      },
    }))

    await expect(readPublicProbeJson(response, 1024)).resolves.toEqual({ ok: true })
  })

  it('does not relabel non-body-limit failures', async () => {
    const error = await captureError(readPublicProbeJson(new Response('{'), 1024))

    expect(error).toMatchObject({ reason: 'json_parse' })
    expect(publicProbeBodyLimitDetail(error)).toBeNull()
  })

  it('emits the bounded size detail through the existing route-sample observer', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', {
      status: 200,
      headers: { 'Content-Length': String(3 * MIB) },
    }))
    const publicApi = createPublicApiAdapter({
      baseUrl: 'https://example.test',
      fetchImpl,
      expensiveIntervalMs: 0,
      sleep: vi.fn(),
      monotonic: () => 0,
    })
    const observer = createRouteSampleObserver({
      publicApi,
      city: 'Hsinchu',
      sample: { patternId: 'pattern-1', routeUid: 'route-1', routeName: '1' },
    })

    await expect(observer.publicApi.getJson('/api/v1/map/route?city=Hsinchu&route=1')).rejects.toThrow(
      'Bounded response is too large',
    )

    expect(observer.detail('pub_case')).toEqual({
      message: 'public_probe_route_sample_detail',
      city: 'Hsinchu',
      sampleCaseId: 'pub_case',
      stage: 'route_fetch_failed',
      requestFailureReason: 'body_limit',
      responseSizeSource: 'content_length',
      responseSizeBucket: 'gt_limit_to_2x',
    })
  })
})
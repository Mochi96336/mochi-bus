import { describe, expect, it } from 'vitest'
import { parseReturnHomeMarker, returnHomeDelta, type ReturnHomeMarker } from './return-home'

const marker: ReturnHomeMarker = {
  version: 2,
  sourcePath: '/',
  targetPath: '/map',
  token: 'return-token-123',
  createdAt: 1_000,
}

const stateAt = (depth: number, token = marker.token) => ({
  __mochiReturnHomeToken: token,
  __mochiReturnHomeDepth: depth,
})

describe('return-home history planning', () => {
  it('skips every history entry created inside the secondary page', () => {
    expect(returnHomeDelta(marker, '/map', stateAt(4))).toBe(-4)
  })

  it('does not use a marker on the wrong page, token, or source entry', () => {
    expect(returnHomeDelta(marker, '/setup', stateAt(4))).toBeNull()
    expect(returnHomeDelta(marker, '/map', stateAt(4, 'another-return-token'))).toBeNull()
    expect(returnHomeDelta(marker, '/map', stateAt(0))).toBeNull()
  })

  it('rejects malformed and expired markers', () => {
    expect(parseReturnHomeMarker(JSON.stringify(marker), 2_000)).toEqual(marker)
    expect(parseReturnHomeMarker(JSON.stringify(marker), 31 * 60 * 1_000)).toBeNull()
    expect(parseReturnHomeMarker('{bad json', 2_000)).toBeNull()
    expect(parseReturnHomeMarker(JSON.stringify({ ...marker, targetPath: '/route' }), 2_000)).toBeNull()
    expect(parseReturnHomeMarker(JSON.stringify({ ...marker, token: 'short' }), 2_000)).toBeNull()
  })
})

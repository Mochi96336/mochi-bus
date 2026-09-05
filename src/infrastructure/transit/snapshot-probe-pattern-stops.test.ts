import { describe, expect, it } from 'vitest'
import {
  parsePinnedPatternStopArtifact,
  pinnedPatternStopArtifactKey,
} from './snapshot-probe-pattern-stops'

const city = 'Hsinchu'
const version = '20260722T101519183Z'
const patternId = 'HSZ000701:0:0'

function artifact(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    city,
    version,
    patternId,
    stops: [
      {
        stopUid: 'S1', placeId: 'P1', stopSequence: 1,
        name: '一站', latitude: 24.8, longitude: 120.9,
      },
      {
        stopUid: 'S2', placeId: 'P2', stopSequence: 2,
        name: '二站', latitude: 24.81, longitude: 120.91,
      },
    ],
    ...overrides,
  }
}

describe('pinned snapshot pattern-stop artifacts', () => {
  it('uses the immutable version-addressed publisher key', () => {
    expect(pinnedPatternStopArtifactKey(version, city, patternId)).toBe(
      `snapshots/${version}/cities/${city}/patterns/${patternId}/stops.json`,
    )
  })

  it('accepts an exact same-version artifact and preserves place identity', () => {
    expect(parsePinnedPatternStopArtifact(artifact(), city, version, patternId)).toEqual({
      schemaVersion: 1,
      city,
      version,
      patternId,
      stops: [
        {
          stopUid: 'S1', placeId: 'P1', stopSequence: 1,
          name: '一站', latitude: 24.8, longitude: 120.9,
        },
        {
          stopUid: 'S2', placeId: 'P2', stopSequence: 2,
          name: '二站', latitude: 24.81, longitude: 120.91,
        },
      ],
    })
  })

  it.each([
    ['wrong city', artifact({ city: 'Taipei' })],
    ['wrong version', artifact({ version: 'old' })],
    ['wrong pattern', artifact({ patternId: 'OTHER' })],
    ['too few stops', artifact({ stops: [artifact().stops[0]] })],
    ['empty place identity', artifact({ stops: [
      { ...artifact().stops[0], placeId: '' },
      artifact().stops[1],
    ] })],
    ['non-increasing sequence', artifact({ stops: [
      artifact().stops[0],
      { ...artifact().stops[1], stopSequence: 1 },
    ] })],
    ['invalid coordinate', artifact({ stops: [
      { ...artifact().stops[0], latitude: Number.NaN },
      artifact().stops[1],
    ] })],
  ])('rejects %s', (_label, value) => {
    expect(parsePinnedPatternStopArtifact(value, city, version, patternId)).toBeNull()
  })
})

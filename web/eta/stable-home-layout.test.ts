import { describe, expect, it } from 'vitest'
import { homeTypeScale } from './stable-home-layout'

describe('stable home typography', () => {
  it('keeps typography tied to a captured layout width', () => {
    expect(homeTypeScale(390)).toEqual({ routePx: 39, etaPx: 42 })
    expect(homeTypeScale(195)).toEqual(homeTypeScale(280))
  })

  it('caps large screens at the intended display sizes', () => {
    expect(homeTypeScale(1_200)).toEqual({ routePx: 54, etaPx: 58 })
  })
})

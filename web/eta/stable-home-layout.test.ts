import { describe, expect, it } from 'vitest'
import { deferHomeScaleUpdate, homeTypeScale } from './stable-home-layout'

describe('stable home typography', () => {
  it('keeps typography tied to a captured layout width', () => {
    expect(homeTypeScale(390)).toEqual({ routePx: 39, etaPx: 42 })
    expect(homeTypeScale(195)).toEqual(homeTypeScale(280))
  })

  it('caps large screens at the intended display sizes', () => {
    expect(homeTypeScale(1_200)).toEqual({ routePx: 54, etaPx: 58 })
  })

  it('defers the BFCache pageshow refresh until return-home clears its leaving flag', () => {
    let queued: (() => void) | undefined
    let updates = 0
    deferHomeScaleUpdate(
      () => { updates += 1 },
      (callback) => { queued = callback },
    )

    expect(updates).toBe(0)
    queued?.()
    expect(updates).toBe(1)
  })
})

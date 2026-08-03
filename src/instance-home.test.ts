import { describe, expect, it } from 'vitest'
import { instanceHomeRedirect } from './instance-home'

const demoQuery = {
  city: 'Taipei',
  routeName: '307',
  stopName: '捷運西門站',
  stopUid: 'TPE213044',
  routeUid: 'TPE19108',
  direction: 0,
} as const

describe('instance home routing', () => {
  it('enters the configured default city when the instance has no demo query', () => {
    expect(instanceHomeRedirect('https://chiayi.example/', 'GET', null, 'Chiayi'))
      .toBe('/map?city=Chiayi')
    expect(instanceHomeRedirect('https://chiayi.example/?notice=tdx-unavailable', 'HEAD', null, 'Chiayi'))
      .toBe('/map?city=Chiayi')
  })

  it('keeps the ETA home for configured demos and ignores non-home requests', () => {
    expect(instanceHomeRedirect('https://bus.example/', 'GET', demoQuery, 'Taipei')).toBeNull()
    expect(instanceHomeRedirect('https://bus.example/map', 'GET', null, 'Chiayi')).toBeNull()
    expect(instanceHomeRedirect('https://bus.example/', 'POST', null, 'Chiayi')).toBeNull()
  })
})

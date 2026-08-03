import { describe, expect, it } from 'vitest'
import { resolveCanonicalOrigin } from './instance-runtime'

describe('instance canonical origin', () => {
  it('keeps a fixed operator origin independent of the request host', () => {
    expect(resolveCanonicalOrigin(
      'https://bus.moc96336.com',
      'https://preview.example/map?city=Chiayi',
    )).toBe('https://bus.moc96336.com')
  })

  it('derives request-mode origins without retaining paths, queries, or fragments', () => {
    expect(resolveCanonicalOrigin(
      'request',
      'https://chiayi-bus.example/map?city=Chiayi#route',
    )).toBe('https://chiayi-bus.example')
  })

  it('fails closed when request mode has no request URL', () => {
    expect(() => resolveCanonicalOrigin('request')).toThrow(/Request URL is required/)
  })
})

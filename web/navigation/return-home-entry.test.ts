import { describe, expect, it } from 'vitest'
import { returnHomeEntryIsTrusted } from './return-home-entry'

const marker = {
  version: 2,
  sourcePath: '/',
  targetPath: '/map',
  token: 'return-token-123',
  createdAt: 1_000,
}

const raw = JSON.stringify(marker)

describe('return-home entry validation', () => {
  it('trusts reload and Forward only when history carries the same token', () => {
    expect(returnHomeEntryIsTrusted({
      raw,
      currentPath: '/map',
      state: { __mochiReturnHomeToken: marker.token },
      referrer: '',
      origin: 'https://bus.example',
      now: 2_000,
    })).toBe(true)
    expect(returnHomeEntryIsTrusted({
      raw,
      currentPath: '/map',
      state: { __mochiReturnHomeToken: 'another-token' },
      referrer: '',
      origin: 'https://bus.example',
      now: 2_000,
    })).toBe(false)
  })

  it('trusts a fresh document only when it came from the same-origin home page', () => {
    expect(returnHomeEntryIsTrusted({
      raw,
      currentPath: '/map',
      state: null,
      referrer: 'https://bus.example/',
      origin: 'https://bus.example',
      now: 2_000,
    })).toBe(true)
    expect(returnHomeEntryIsTrusted({
      raw,
      currentPath: '/map',
      state: null,
      referrer: 'https://bus.example/route?city=NewTaipei&route=307',
      origin: 'https://bus.example',
      now: 2_000,
    })).toBe(false)
    expect(returnHomeEntryIsTrusted({
      raw,
      currentPath: '/map',
      state: null,
      referrer: 'https://other.example/',
      origin: 'https://bus.example',
      now: 2_000,
    })).toBe(false)
  })

  it('rejects a marker for another secondary page', () => {
    expect(returnHomeEntryIsTrusted({
      raw,
      currentPath: '/setup',
      state: { __mochiReturnHomeToken: marker.token },
      referrer: 'https://bus.example/',
      origin: 'https://bus.example',
      now: 2_000,
    })).toBe(false)
  })
})

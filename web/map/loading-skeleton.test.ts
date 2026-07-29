import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createNearbyPlaceLoadingList, createPlaceRouteLoadingList } from './loading-skeleton'

class FakeElement {
  readonly children: FakeElement[] = []
  className = ''
  ariaHidden: string | null = null

  constructor(readonly tagName: string) {}

  appendChild(child: FakeElement): FakeElement {
    this.children.push(child)
    return child
  }
}

function tokens(element: FakeElement): string[] {
  return element.className.split(/\s+/).filter(Boolean)
}

beforeEach(() => {
  vi.stubGlobal('document', {
    createElement: (tagName: string) => new FakeElement(tagName),
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Map loading skeletons', () => {
  it('builds three presentation-only nearby rows shaped like the resolved list', () => {
    const list = createNearbyPlaceLoadingList() as unknown as FakeElement

    expect(tokens(list)).toEqual(['nearby-list', 'place-route-loading'])
    expect(list.ariaHidden).toBe('true')
    expect(list.children).toHaveLength(3)
    for (const row of list.children) {
      expect(tokens(row)).toEqual([
        'nearby-place-button',
        'map-loading-row',
        'nearby-place-skeleton',
      ])
      expect(row.children.map((child) => tokens(child))).toEqual([
        ['skeleton-line', 'skeleton-nearby-name'],
        ['skeleton-line', 'skeleton-nearby-distance'],
      ])
    }
  })

  it('builds three presentation-only route rows with resolved-shaped layout columns', () => {
    const list = createPlaceRouteLoadingList() as unknown as FakeElement

    expect(tokens(list)).toEqual(['place-route-list', 'place-route-loading'])
    expect(list.ariaHidden).toBe('true')
    expect(list.children).toHaveLength(3)
    for (const row of list.children) {
      expect(tokens(row)).toEqual(['place-route-loading-row', 'map-loading-row'])
      expect(tokens(row.children[0])).toEqual(['place-route-button'])
      expect(tokens(row.children[1])).toEqual(['favorite-direction-button', 'skeleton-favorite'])

      const route = row.children[0]
      expect(tokens(route.children[0])).toEqual(['route-color-tick'])
      expect(tokens(route.children[1])).toEqual(['place-route-main'])
      expect(tokens(route.children[2])).toEqual(['skeleton-line', 'skeleton-route-detail'])

      const main = route.children[1]
      expect(tokens(main.children[0])).toEqual(['skeleton-line', 'skeleton-route-name'])
      expect(tokens(main.children[1])).toEqual(['place-route-eta'])
      expect(tokens(main.children[1].children[0])).toEqual([
        'eta-value',
        'skeleton-line',
        'skeleton-route-eta-value',
      ])
    }
  })
})

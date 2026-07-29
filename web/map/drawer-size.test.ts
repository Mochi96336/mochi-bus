import { describe, expect, it } from 'vitest'
import { drawerSizeForTransition } from './drawer-view'

describe('drawer size states', () => {
  it('uses an explicit size without consulting the content mode', () => {
    expect(drawerSizeForTransition('content', 'timetable', true, 'a', 'b', 'expanded')).toBe('content')
    expect(drawerSizeForTransition('standard', 'compact', false, undefined, 'route', undefined)).toBe('standard')
  })

  it('maps scrollable workspaces to stable size states', () => {
    expect(drawerSizeForTransition(undefined, 'map-list', false, undefined, 'catalogue', undefined)).toBe('standard')
    expect(drawerSizeForTransition(undefined, 'results', false, undefined, 'trip', undefined)).toBe('expanded')
    expect(drawerSizeForTransition(undefined, 'timetable', false, undefined, 'times', undefined)).toBe('expanded')
  })

  it('keeps a non-content size when the same navigation view settles', () => {
    expect(drawerSizeForTransition(undefined, 'compact', false, 'route:Tainan:15', 'route:Tainan:15', 'standard')).toBe('standard')
  })

  it('treats legacy preserve-height loading views as standard workspaces', () => {
    expect(drawerSizeForTransition(undefined, 'compact', true, undefined, 'route:Tainan:15', undefined)).toBe('standard')
    expect(drawerSizeForTransition(undefined, 'compact', true, 'catalogue:Tainan', 'route:Tainan:15', 'standard')).toBe('standard')
  })

  it('leaves unrelated compact views content-sized', () => {
    expect(drawerSizeForTransition(undefined, 'compact', false, 'overview', 'region:south', 'content')).toBe('content')
  })
})

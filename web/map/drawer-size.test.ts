import { describe, expect, it } from 'vitest'
import { drawerSizeForTransition } from './drawer-view'

describe('drawer size states', () => {
  it('uses an explicit size without consulting the content mode', () => {
    expect(drawerSizeForTransition('content', 'timetable', true, 'standard')).toBe('content')
    expect(drawerSizeForTransition('standard', 'compact', false, undefined)).toBe('standard')
  })

  it('maps scrollable workspaces to stable size states', () => {
    expect(drawerSizeForTransition(undefined, 'map-list', false, undefined)).toBe('standard')
    expect(drawerSizeForTransition(undefined, 'results', false, undefined)).toBe('expanded')
    expect(drawerSizeForTransition(undefined, 'timetable', false, undefined)).toBe('expanded')
  })

  it('restores a remembered non-content size after visiting another workspace', () => {
    expect(drawerSizeForTransition(undefined, 'compact', false, 'standard')).toBe('standard')
  })

  it('treats legacy preserve-height loading views as standard workspaces', () => {
    expect(drawerSizeForTransition(undefined, 'compact', true, undefined)).toBe('standard')
  })

  it('leaves unrelated compact views content-sized', () => {
    expect(drawerSizeForTransition(undefined, 'compact', false, undefined)).toBe('content')
  })
})

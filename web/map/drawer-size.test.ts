import { describe, expect, it } from 'vitest'
import css from './drawer-size.css?raw'
import { drawerSizeForTransition } from './drawer-view'

describe('drawer size states', () => {
  it('uses an explicit size without consulting the content mode', () => {
    expect(drawerSizeForTransition('content', 'timetable', true, 'standard')).toBe('content')
    expect(drawerSizeForTransition('standard', 'compact', false, undefined)).toBe('standard')
  })

  it('maps unknown scrollable workspaces to the neutral standard size', () => {
    expect(drawerSizeForTransition(undefined, 'map-list', false, undefined)).toBe('standard')
    expect(drawerSizeForTransition(undefined, 'results', false, undefined)).toBe('standard')
    expect(drawerSizeForTransition(undefined, 'timetable', false, undefined)).toBe('standard')
  })

  it('restores a remembered non-content size before applying the mode fallback', () => {
    expect(drawerSizeForTransition(undefined, 'compact', false, 'standard')).toBe('standard')
    expect(drawerSizeForTransition(undefined, 'map-list', false, 'tall')).toBe('tall')
    expect(drawerSizeForTransition(undefined, 'timetable', false, 'compact')).toBe('compact')
  })

  it('treats legacy preserve-height loading views as standard workspaces', () => {
    expect(drawerSizeForTransition(undefined, 'compact', true, undefined)).toBe('standard')
  })

  it('leaves unrelated compact views content-sized', () => {
    expect(drawerSizeForTransition(undefined, 'compact', false, undefined)).toBe('content')
  })

  it('keeps mobile compact and nearby sheets below the generic standard workspace', () => {
    const mobileBlock = css.match(/@media \(max-width: 640px\) \{[\s\S]*?\n\}/)?.[0]
    expect(mobileBlock).toBeTruthy()
    expect(mobileBlock).toContain('--map-drawer-size-compact: min(')
    expect(mobileBlock).not.toContain('--map-drawer-size-compact: var(--map-drawer-size-standard)')
    expect(mobileBlock).toContain('--map-drawer-size-nearby: min(')
    expect(mobileBlock).toContain('.map-drawer[data-view^="nearby:"][data-size="standard"]')
  })
})

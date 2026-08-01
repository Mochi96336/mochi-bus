// @ts-expect-error Vitest 執行於 Node；應用程式 tsconfig 刻意不載入 Node 全域型別。
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { drawerSizeForTransition } from './drawer-view'

const css = readFileSync(new URL('./drawer-size.css', import.meta.url), 'utf8')

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
    expect(css).toContain('--map-drawer-size-compact: min(\n      clamp(216px, 26dvh, 240px),')
    expect(css).not.toContain('--map-drawer-size-compact: var(--map-drawer-size-standard);')
    expect(css).toContain('--map-drawer-size-nearby: min(')
    expect(css).toContain('.map-drawer[data-view^="nearby:"][data-size="standard"]')
  })

  it('moves height and max-height together so shrinking remains animated', () => {
    expect(css).toContain('height 220ms cubic-bezier(.22, .61, .36, 1),\n    max-height 220ms cubic-bezier(.22, .61, .36, 1);')
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*transition:\s*none/)
  })
})

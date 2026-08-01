// @ts-expect-error Vitest 執行於 Node；應用程式 tsconfig 刻意不載入 Node 全域型別。
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { drawerSizeForTransition } from './drawer-view'

const css = readFileSync(new URL('./drawer-size.css', import.meta.url), 'utf8')

describe('drawer size states', () => {
  it('uses an explicit size without consulting the content mode', () => {
    expect(drawerSizeForTransition('content', 'timetable', true)).toBe('content')
    expect(drawerSizeForTransition('standard', 'compact', false)).toBe('standard')
    expect(drawerSizeForTransition('nearby', 'map-list', false)).toBe('nearby')
  })

  it('maps unknown scrollable workspaces to the neutral standard size', () => {
    expect(drawerSizeForTransition(undefined, 'map-list', false)).toBe('standard')
    expect(drawerSizeForTransition(undefined, 'results', false)).toBe('standard')
    expect(drawerSizeForTransition(undefined, 'timetable', false)).toBe('standard')
  })

  it('treats legacy preserve-height loading views as standard workspaces', () => {
    expect(drawerSizeForTransition(undefined, 'compact', true)).toBe('standard')
  })

  it('leaves unrelated compact views content-sized', () => {
    expect(drawerSizeForTransition(undefined, 'compact', false)).toBe('content')
  })

  it('keeps mobile compact and nearby sheets below the generic standard workspace', () => {
    expect(css).toContain('--map-drawer-size-compact: min(\n      clamp(224px, 27dvh, 240px),')
    expect(css).not.toContain('--map-drawer-size-compact: var(--map-drawer-size-standard);')
    expect(css).toContain('--map-drawer-size-nearby: min(')
  })

  // 高度只能有一個來源。view-scoped 覆寫會讓同一個 data-size 在不同畫面下是不同高度,
  // renderer 因此無法保證讀取中不改高度——它比對的狀態沒變,實際高度卻少了 100px。
  it('resolves every height from data-size alone, never from the view name', () => {
    expect(css).toContain('.map-drawer[data-size="nearby"]')
    expect(css).not.toContain('[data-view^="nearby:"]')
    expect(css).not.toMatch(/\[data-view[^\]]*\][^{]*\{[^}]*height:/)
  })

  it('moves height and max-height together so shrinking remains animated', () => {
    expect(css).toContain('height 220ms cubic-bezier(.22, .61, .36, 1),\n    max-height 220ms cubic-bezier(.22, .61, .36, 1);')
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*transition:\s*none/)
  })
})

// @ts-expect-error Vitest 執行於 Node；應用程式 tsconfig 刻意不載入 Node 全域型別。
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { drawerSizeForTransition } from './drawer-view'

// 斷言是逐字比對多行 CSS,所以換行必須正規化:Windows 檢出(core.autocrlf=true)
// 的工作區是 CRLF,不正規化的話每一條多行斷言都只在 CI 過、在本機一律失敗。
const css = readFileSync(new URL('./drawer-size.css', import.meta.url), 'utf8')
  .replace(/\r\n/g, '\n')

describe('drawer size states', () => {
  it('uses an explicit size without consulting the content mode', () => {
    expect(drawerSizeForTransition('content', 'timetable')).toBe('content')
    expect(drawerSizeForTransition('standard', 'compact')).toBe('standard')
    expect(drawerSizeForTransition('nearby', 'map-list')).toBe('nearby')
  })

  it('maps unknown scrollable workspaces to the neutral standard size', () => {
    expect(drawerSizeForTransition(undefined, 'map-list')).toBe('standard')
    expect(drawerSizeForTransition(undefined, 'results')).toBe('standard')
    expect(drawerSizeForTransition(undefined, 'timetable')).toBe('standard')
  })

  it('leaves unsized compact views content-sized', () => {
    expect(drawerSizeForTransition(undefined, 'compact')).toBe('content')
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

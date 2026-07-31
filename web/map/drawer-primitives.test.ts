import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { degradedNotice, isNoticeFolded, resetFoldedNotices } from './drawer-primitives'

// 專案沒有 jsdom(見 vitest.config.ts):web 層測試一律手刻最小 DOM 替身。
class FakeElement {
  readonly children: FakeElement[] = []
  readonly attributes = new Map<string, string>()
  readonly classes = new Set<string>()
  readonly listeners = new Map<string, Array<() => void>>()
  textContent = ''
  href = ''
  disabled = false
  open = false
  isConnected = true
  private classValue = ''

  constructor(readonly tagName: string) {}

  readonly classList = {
    add: (...tokens: string[]) => { for (const token of tokens) this.classes.add(token) },
    toggle: (token: string, force: boolean) => {
      if (force) this.classes.add(token)
      else this.classes.delete(token)
    },
    contains: (token: string) => this.classes.has(token),
  }

  get className(): string {
    return this.classValue
  }

  set className(value: string) {
    this.classValue = value
    this.classes.clear()
    for (const token of value.split(/\s+/).filter(Boolean)) this.classes.add(token)
  }

  appendChild(child: FakeElement): FakeElement {
    this.children.push(child)
    return child
  }

  setAttribute(name: string, value: string) {
    this.attributes.set(name, value)
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null
  }

  addEventListener(type: string, listener: () => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }

  emit(type: string) {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener()
  }
}

function find(root: FakeElement, tagName: string): FakeElement | undefined {
  if (root.tagName === tagName) return root
  for (const child of root.children) {
    const found = find(child, tagName)
    if (found) return found
  }
}

function collectText(root: FakeElement): string[] {
  const values = root.textContent ? [root.textContent] : []
  for (const child of root.children) values.push(...collectText(child))
  return values
}

function liveNodes(root: FakeElement): FakeElement[] {
  const found = root.getAttribute('role') === 'status' ? [root] : []
  for (const child of root.children) found.push(...liveNodes(child))
  return found
}

const notice = (options: Partial<Parameters<typeof degradedNotice>[0]> = {}) =>
  degradedNotice({ message: 'TDX 暫時忙線', onRetry: () => {}, ...options }) as unknown as FakeElement

beforeEach(() => {
  resetFoldedNotices()
  vi.stubGlobal('document', { createElement: (tagName: string) => new FakeElement(tagName) })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('degraded notice folding', () => {
  it('keeps a non-collapsible notice fully expanded with no disclosure', () => {
    const rendered = notice()

    expect(find(rendered, 'details')).toBeUndefined()
    expect(collectText(rendered)).toContain('TDX 暫時忙線')
    expect(collectText(rendered)).toContain('再試一次')
  })

  it('opens a collapsible notice by default', () => {
    const fold = find(notice({ collapsible: true }), 'details')

    expect(fold?.open).toBe(true)
    expect(collectText(fold!)).toContain('再試一次')
  })

  // 核心原則:使用者可以把仍然成立的問題縮小,不能讓它看起來不再存在。
  it('never lets folding hide the problem statement itself', () => {
    const rendered = notice({ collapsible: true })
    const summary = find(rendered, 'summary')

    expect(collectText(summary!)).toContain('TDX 暫時忙線')
  })

  it('remembers a fold so a periodic re-render does not pop it open again', () => {
    const first = find(notice({ collapsible: true }), 'details')!
    first.open = false
    first.emit('toggle')
    expect(isNoticeFolded('TDX 暫時忙線')).toBe(true)

    // 車輛定位每 20 秒重畫一次通知。
    expect(find(notice({ collapsible: true }), 'details')?.open).toBe(false)
  })

  it('re-opens after the user expands it again', () => {
    const first = find(notice({ collapsible: true }), 'details')!
    first.open = false
    first.emit('toggle')
    first.open = true
    first.emit('toggle')

    expect(isNoticeFolded('TDX 暫時忙線')).toBe(false)
    expect(find(notice({ collapsible: true }), 'details')?.open).toBe(true)
  })

  it('keeps fold state per message so one notice does not fold another', () => {
    const first = find(notice({ collapsible: true }), 'details')!
    first.open = false
    first.emit('toggle')

    expect(find(notice({ message: '憑證已失效', collapsible: true }), 'details')?.open).toBe(true)
  })

  it('announces only the problem, not a reading of the action buttons', () => {
    for (const rendered of [notice(), notice({ collapsible: true })]) {
      const live = liveNodes(rendered)
      expect(live).toHaveLength(1)
      expect(collectText(live[0])).toEqual(['TDX 暫時忙線'])
    }
  })

  it('marks credential recovery on the notice regardless of folding', () => {
    expect(notice({ credentialRecovery: true }).classList.contains('credential-recovery')).toBe(true)
    expect(notice({ credentialRecovery: true, collapsible: true }).classList.contains('credential-recovery')).toBe(true)
  })
})

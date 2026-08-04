import { describe, expect, it } from 'vitest'
import { parseHomeViewSnapshot, type HomeViewSnapshot } from './home-return-snapshot'

const snapshot: HomeViewSnapshot = {
  version: 2,
  savedAt: 1_000,
  boardFingerprint: 'board-a',
  title: '捷運景安站',
  rows: [{
    key: 'city=NewTaipei&route=307',
    href: '/route?city=NewTaipei&route=307',
    routeName: '307',
    directionLabel: '往臺北',
    eta: {
      classes: [],
      ariaLabel: '5 分',
      signature: '|5|分|default|fresh|numeric',
      prefix: '',
      value: '5',
      suffix: '分',
      freshness: '',
    },
  }],
  updatedText: '資料 12:00:00',
  notice: [{ kind: 'text', value: '' }],
}

describe('home return snapshot validation', () => {
  it('accepts a fresh snapshot for the exact same board', () => {
    expect(parseHomeViewSnapshot(JSON.stringify(snapshot), 'board-a', 2_000)).toEqual(snapshot)
  })

  it('rejects stale, cross-board, or executable content', () => {
    expect(parseHomeViewSnapshot(JSON.stringify(snapshot), 'board-b', 2_000)).toBeNull()
    expect(parseHomeViewSnapshot(JSON.stringify(snapshot), 'board-a', 16 * 60 * 1_000)).toBeNull()
    expect(parseHomeViewSnapshot(JSON.stringify({
      ...snapshot,
      rows: [{ ...snapshot.rows[0], href: 'javascript:alert(1)' }],
    }), 'board-a', 2_000)).toBeNull()
    expect(parseHomeViewSnapshot(JSON.stringify({
      ...snapshot,
      rows: [{ ...snapshot.rows[0], eta: { ...snapshot.rows[0].eta, classes: ['onerror=alert(1)'] } }],
    }), 'board-a', 2_000)).toBeNull()
  })
})

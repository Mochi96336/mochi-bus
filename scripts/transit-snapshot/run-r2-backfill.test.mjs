import { describe, expect, it, vi } from 'vitest'
import {
  requireR2BackfillConfirmation,
  runR2Backfill,
} from './run-r2-backfill.mjs'

describe('R2 backfill process runner', () => {
  it('requires an exact city and target bound confirmation', () => {
    expect(() => requireR2BackfillConfirmation({
      city: 'Taichung',
      target: 'active',
      confirmation: 'BACKFILL_Taichung_active',
    })).not.toThrow()
    expect(() => requireR2BackfillConfirmation({
      city: 'Taipei',
      target: '20260903T214320849Z',
      confirmation: 'BACKFILL_Taipei_20260903T214320849Z',
    })).not.toThrow()
    expect(() => requireR2BackfillConfirmation({
      city: 'Taichung',
      target: 'active',
      confirmation: 'BACKFILL_Taichung_previous',
    })).toThrow('R2 backfill confirmation mismatch')
  })

  it('fails before loading an exporter when confirmation is absent or stale', async () => {
    const loadExporter = vi.fn()
    await expect(runR2Backfill({
      kind: 'place-routing',
      city: 'Taichung',
      target: 'active',
      confirmation: undefined,
      loadExporter,
    })).rejects.toThrow('R2 backfill confirmation mismatch')
    expect(loadExporter).not.toHaveBeenCalled()
  })

  it('maps every supported backfill kind through the guarded loader', async () => {
    const cases = [
      ['pattern-stops', 'pattern_stop_export_completed'],
      ['place-routing', 'place_routing_export_completed'],
      ['transfer-routing', 'transfer_routing_export_completed'],
      ['stop-lookup', 'stop_lookup_export_completed'],
    ]
    for (const [kind, event] of cases) {
      const exporter = vi.fn(async ({ city, target }) => ({ city, target, version: 'v1' }))
      const loadExporter = vi.fn(async () => exporter)
      const result = await runR2Backfill({
        kind,
        city: 'NewTaipei',
        target: 'previous',
        confirmation: 'BACKFILL_NewTaipei_previous',
        loadExporter,
      })
      expect(loadExporter).toHaveBeenCalledOnce()
      expect(exporter).toHaveBeenCalledWith({ city: 'NewTaipei', target: 'previous' })
      expect(result).toMatchObject({ event, city: 'NewTaipei', target: 'previous', version: 'v1' })
    }
  })

  it('rejects unsupported kinds before loading an exporter', async () => {
    const loadExporter = vi.fn()
    await expect(runR2Backfill({
      kind: 'unknown',
      city: 'Taichung',
      target: 'active',
      confirmation: 'BACKFILL_Taichung_active',
      loadExporter,
    })).rejects.toThrow('Unsupported R2 backfill kind')
    expect(loadExporter).not.toHaveBeenCalled()
  })
})

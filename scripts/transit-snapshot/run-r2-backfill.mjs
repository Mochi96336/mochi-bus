import { pathToFileURL } from 'node:url'

const SAFE_CITY = /^[A-Za-z][A-Za-z0-9]{0,63}$/
const SAFE_TARGET = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

const BACKFILL_EXPORTERS = Object.freeze({
  'pattern-stops': Object.freeze({
    module: './export-pattern-stops.mjs',
    exportName: 'exportPatternStops',
    event: 'pattern_stop_export_completed',
  }),
  'place-routing': Object.freeze({
    module: './export-place-routing.mjs',
    exportName: 'exportPlaceRouting',
    event: 'place_routing_export_completed',
  }),
  'transfer-routing': Object.freeze({
    module: './export-transfer-routing.mjs',
    exportName: 'exportTransferRouting',
    event: 'transfer_routing_export_completed',
  }),
  'stop-lookup': Object.freeze({
    module: './export-stop-lookup.mjs',
    exportName: 'exportStopLookup',
    event: 'stop_lookup_export_completed',
  }),
})

export function requireR2BackfillConfirmation({ city, target, confirmation } = {}) {
  if (typeof city !== 'string' || !SAFE_CITY.test(city)
    || typeof target !== 'string' || !SAFE_TARGET.test(target)) {
    throw new Error('R2 backfill scope is invalid')
  }
  if (confirmation !== `BACKFILL_${city}_${target}`) {
    throw new Error('R2 backfill confirmation mismatch')
  }
}

export async function runR2Backfill({
  kind,
  city,
  target = 'active',
  confirmation = process.env.SNAPSHOT_R2_BACKFILL_CONFIRMATION,
  loadExporter = loadR2BackfillExporter,
} = {}) {
  const definition = BACKFILL_EXPORTERS[kind]
  if (!definition) throw new Error('Unsupported R2 backfill kind')

  // Keep the operator-intent check ahead of dynamic imports. A missing or stale
  // confirmation must fail before exporter modules can resolve production
  // resources or reach any D1/R2 code path.
  requireR2BackfillConfirmation({ city, target, confirmation })
  const exporter = await loadExporter(definition)
  const result = await exporter({ city, target })
  return Object.freeze({ event: definition.event, ...result })
}

export async function loadR2BackfillExporter(definition) {
  const module = await import(new URL(definition.module, import.meta.url))
  const exporter = module[definition.exportName]
  if (typeof exporter !== 'function') throw new Error('R2 backfill exporter is unavailable')
  return exporter
}

async function main() {
  const kind = process.argv[2]
  const city = process.argv[3]
  const target = process.argv[4] ?? 'active'
  const result = await runR2Backfill({ kind, city, target })
  console.log(JSON.stringify(result))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(JSON.stringify({
      event: 'r2_backfill_runner_failed',
      message: error instanceof Error ? error.message : String(error),
    }))
    process.exitCode = 1
  })
}

import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

const REPORT_KIND = 'snapshot-high-card-d1-retirement-readiness'
const REPORT_SCHEMA_VERSION = 2
const SAFE_CITY = /^[A-Za-z][A-Za-z0-9]{0,63}$/
const AUTHORITY_MODES = new Set(['legacy-d1', 'legacy-partial', 'legacy-backfill', 'root-bound'])

export function scheduledNativeAuthorityRefreshDecision(report, city) {
  if (!SAFE_CITY.test(city ?? '')) {
    throw new Error('Scheduled native authority refresh requires a safe city')
  }
  if (!report || report.schemaVersion !== REPORT_SCHEMA_VERSION || report.kind !== REPORT_KIND
    || !Array.isArray(report.cities) || !Array.isArray(report.blockingCities)
    || !Number.isSafeInteger(report.cityCount) || report.cityCount !== report.cities.length
    || !Number.isSafeInteger(report.rootBoundCityCount)
    || report.rootBoundCityCount < 0 || report.rootBoundCityCount > report.cityCount
    || typeof report.rootBoundAuthorityReady !== 'boolean') {
    throw new Error('Scheduled native authority refresh readiness report is invalid')
  }

  const cityRows = report.cities.filter((entry) => entry?.city === city)
  if (cityRows.length !== 1) {
    throw new Error(`Scheduled native authority refresh city ${city} is not uniquely represented`)
  }
  const cityRow = normalizeCityRow(cityRows[0])
  const blockerRows = report.blockingCities.filter((entry) => entry?.city === city)
  if (blockerRows.length > 1) {
    throw new Error(`Scheduled native authority refresh city ${city} has duplicate blockers`)
  }

  if (cityRow.rootBoundRollbackWindow) {
    if (blockerRows.length !== 0 || cityRow.nativeRootBoundPublicationsRequired !== 0) {
      throw new Error(`Scheduled native authority refresh ready city ${city} disagrees with blockers`)
    }
    return Object.freeze({
      city,
      forcePublish: false,
      nativeRootBoundPublicationsRequired: 0,
      activeAuthorityMode: cityRow.activeAuthorityMode,
      previousAuthorityMode: cityRow.previousAuthorityMode,
    })
  }

  if (blockerRows.length !== 1) {
    throw new Error(`Scheduled native authority refresh blocking city ${city} is missing from blockers`)
  }
  const blocker = normalizeCityRow(blockerRows[0], false)
  if (blocker.activeVersion !== cityRow.activeVersion
    || blocker.previousVersion !== cityRow.previousVersion
    || blocker.activeAuthorityMode !== cityRow.activeAuthorityMode
    || blocker.previousAuthorityMode !== cityRow.previousAuthorityMode
    || blocker.nativeRootBoundPublicationsRequired !== cityRow.nativeRootBoundPublicationsRequired) {
    throw new Error(`Scheduled native authority refresh blocker for ${city} disagrees with city evidence`)
  }
  if (cityRow.nativeRootBoundPublicationsRequired !== 1
    && cityRow.nativeRootBoundPublicationsRequired !== 2) {
    throw new Error(`Scheduled native authority refresh blocker for ${city} has invalid publication count`)
  }

  return Object.freeze({
    city,
    forcePublish: true,
    nativeRootBoundPublicationsRequired: cityRow.nativeRootBoundPublicationsRequired,
    activeAuthorityMode: cityRow.activeAuthorityMode,
    previousAuthorityMode: cityRow.previousAuthorityMode,
  })
}

export function renderScheduledNativeAuthorityRefreshFlag(decision) {
  if (!decision || decision.forcePublish !== true && decision.forcePublish !== false) {
    throw new Error('Scheduled native authority refresh decision is invalid')
  }
  return decision.forcePublish ? '1' : '0'
}

function normalizeCityRow(value, requireWindow = true) {
  if (!value || !SAFE_CITY.test(value.city ?? '')
    || typeof value.activeVersion !== 'string' || !value.activeVersion
    || typeof value.previousVersion !== 'string' || !value.previousVersion
    || value.activeVersion === value.previousVersion
    || !AUTHORITY_MODES.has(value.activeAuthorityMode)
    || !AUTHORITY_MODES.has(value.previousAuthorityMode)
    || !Number.isSafeInteger(value.nativeRootBoundPublicationsRequired)) {
    throw new Error('Scheduled native authority refresh city evidence is invalid')
  }
  if (requireWindow && typeof value.rootBoundRollbackWindow !== 'boolean') {
    throw new Error('Scheduled native authority refresh city window evidence is invalid')
  }
  return value
}

async function main(argv = process.argv.slice(2)) {
  const [reportPath, city] = argv
  if (!reportPath || !city) {
    throw new Error('Usage: scheduled-native-authority-refresh <readiness-report.json> <city>')
  }
  const report = JSON.parse(await readFile(reportPath, 'utf8'))
  const decision = scheduledNativeAuthorityRefreshDecision(report, city)
  process.stdout.write(`${renderScheduledNativeAuthorityRefreshFlag(decision)}\n`)
  process.stderr.write(`${JSON.stringify({ event: 'scheduled_native_authority_refresh', ...decision })}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}

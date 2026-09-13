export const HIGH_CARD_RETIREMENT_PLAN_SCHEMA_VERSION = 1

const SCHEMA_INVENTORY_KIND = 'snapshot-high-card-d1-schema-inventory'
const AUTHORITY_READINESS_KIND = 'snapshot-high-card-d1-retirement-readiness'
const PLAN_KIND = 'snapshot-high-card-d1-retirement-plan'
const TARGET_TABLES = new Set(['stops', 'pattern_stops'])
const EXPECTED_EXPLICIT_OBJECTS = new Map([
  ['pattern_stops', Object.freeze({ type: 'table', table: 'pattern_stops' })],
  ['pattern_stops_place_idx', Object.freeze({ type: 'index', table: 'pattern_stops' })],
  ['stops', Object.freeze({ type: 'table', table: 'stops' })],
  ['stops_name_idx', Object.freeze({ type: 'index', table: 'stops' })],
  ['stops_place_idx', Object.freeze({ type: 'index', table: 'stops' })],
])
const SAFE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/
const SAFE_CITY = /^[A-Za-z][A-Za-z0-9]{0,63}$/
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const ALLOWED_OBJECT_TYPES = new Set(['index', 'table', 'trigger', 'view'])
const AUTHORITY_MODES = new Set(['legacy-d1', 'legacy-partial', 'legacy-backfill', 'root-bound'])
const MAX_PUBLISHED_CITIES = 256
const COMPLETE_ROUTING_MANIFEST_COUNT = 4

export const remainingHighCardRetirementGates = Object.freeze([
  'changed_large_city_rows_written_acceptance',
  'worker_resource_measurement_acceptance',
  'taichung_rollback_drill_acceptance',
  'full_weekly_shard_acceptance',
  'explicit_mutation_authorization',
])

export function buildHighCardRetirementPlan({
  schemaInventory,
  authorityReadiness,
  now = () => new Date(),
} = {}) {
  const schema = normalizeSchemaInventory(schemaInventory)
  const authority = normalizeAuthorityReadiness(authorityReadiness)
  const blockers = []

  if (schema.schemaState === 'partial') blockers.push('schema_partial')
  if (!schema.dependencyClear) blockers.push('schema_dependency_not_clear')
  if (schema.schemaState === 'legacy-present' && !schema.schemaMatchesExpectedLegacyShape) {
    blockers.push('schema_drift')
  }
  if (schema.schemaState !== 'retired' && !authority.rootBoundAuthorityReady) {
    blockers.push('root_bound_authority_not_ready')
  }

  const planningState = schema.schemaState === 'retired' && blockers.length === 0
    ? 'already-retired'
    : blockers.length === 0
      ? 'authority-and-schema-ready'
      : 'blocked'
  const candidateObjects = schema.schemaState === 'legacy-present'
    ? [...schema.ownedObjects].sort(compareObjects)
    : []
  const remainingAcceptanceGates = planningState === 'already-retired'
    ? []
    : [...remainingHighCardRetirementGates]

  return Object.freeze({
    schemaVersion: HIGH_CARD_RETIREMENT_PLAN_SCHEMA_VERSION,
    kind: PLAN_KIND,
    generatedAt: now().toISOString(),
    planningState,
    destructiveExecutionAuthorized: false,
    blockers: Object.freeze(blockers),
    candidateObjects: Object.freeze(candidateObjects.map((entry) => Object.freeze({ ...entry }))),
    remainingAcceptanceGates: Object.freeze(remainingAcceptanceGates),
    schema: Object.freeze({
      state: schema.schemaState,
      dependencyClear: schema.dependencyClear,
      matchesExpectedLegacyShape: schema.schemaMatchesExpectedLegacyShape,
      ownedObjectCount: schema.ownedObjects.length,
      externalDependencyCount: schema.externalDependencies.length,
    }),
    authority: Object.freeze({
      cityCount: authority.cityCount,
      rootBoundCityCount: authority.rootBoundCityCount,
      rootBoundAuthorityReady: authority.rootBoundAuthorityReady,
      blockingCities: Object.freeze(authority.blockingCities.map((city) => Object.freeze({ city }))),
    }),
  })
}

export function normalizeSchemaInventory(report) {
  if (!report || typeof report !== 'object'
    || report.schemaVersion !== 1
    || report.kind !== SCHEMA_INVENTORY_KIND
    || !['legacy-present', 'retired', 'partial'].includes(report.schemaState)
    || typeof report.schemaMatchesExpectedLegacyShape !== 'boolean'
    || typeof report.dependencyClear !== 'boolean'
    || !Array.isArray(report.tablesPresent)
    || !Array.isArray(report.ownedObjects)
    || !Array.isArray(report.missingExpectedObjects)
    || !Array.isArray(report.unexpectedOwnedObjects)
    || !Array.isArray(report.externalDependencies)) {
    throw new Error('High-card retirement plan requires a valid schema inventory report')
  }

  const tablesPresent = normalizeNames(report.tablesPresent, 'schema table')
  if (tablesPresent.some((name) => !TARGET_TABLES.has(name))) {
    throw new Error('High-card retirement plan schema inventory contains an unexpected target table')
  }
  const expectedTableCount = report.schemaState === 'legacy-present' ? 2 : report.schemaState === 'retired' ? 0 : 1
  if (tablesPresent.length !== expectedTableCount) {
    throw new Error('High-card retirement plan schema state is inconsistent with target tables')
  }

  const ownedObjects = normalizeOwnedObjects(report.ownedObjects)
  const observedTables = ownedObjects
    .filter((entry) => entry.type === 'table' && entry.name === entry.table)
    .map((entry) => entry.table)
    .sort()
  if (!sameNames(tablesPresent, observedTables)) {
    throw new Error('High-card retirement plan schema tables do not match owned objects')
  }
  const tableSet = new Set(tablesPresent)
  if (ownedObjects.some((entry) => !tableSet.has(entry.table))) {
    throw new Error('High-card retirement plan schema owned objects outlive their target table')
  }

  const missingExpectedObjects = normalizeNames(report.missingExpectedObjects, 'missing schema object')
  const expectedMissingObjects = report.schemaState === 'legacy-present'
    ? [...EXPECTED_EXPLICIT_OBJECTS.entries()]
      .filter(([name, expected]) => !ownedObjects.some((entry) => entry.name === name
        && entry.type === expected.type && entry.table === expected.table))
      .map(([name]) => name)
      .sort()
    : []
  if (!sameNames(missingExpectedObjects, expectedMissingObjects)) {
    throw new Error('High-card retirement plan missing schema objects do not match owned objects')
  }

  const unexpectedOwnedObjects = normalizeOwnedObjects(report.unexpectedOwnedObjects).sort(compareObjects)
  const expectedUnexpectedOwnedObjects = ownedObjects
    .filter((entry) => !isExpectedOwnedObject(entry))
    .sort(compareObjects)
  if (!sameObjects(unexpectedOwnedObjects, expectedUnexpectedOwnedObjects)) {
    throw new Error('High-card retirement plan unexpected schema objects do not match owned objects')
  }

  const externalDependencies = normalizeDependencies(report.externalDependencies)
  const expectedDependencyClear = report.schemaState !== 'partial' && externalDependencies.length === 0
  const expectedShape = report.schemaState === 'legacy-present'
    && expectedMissingObjects.length === 0
    && expectedUnexpectedOwnedObjects.length === 0
    && externalDependencies.length === 0

  if (report.dependencyClear !== expectedDependencyClear
    || report.schemaMatchesExpectedLegacyShape !== expectedShape) {
    throw new Error('High-card retirement plan schema inventory summary is inconsistent')
  }

  return Object.freeze({
    schemaState: report.schemaState,
    tablesPresent: Object.freeze(tablesPresent),
    ownedObjects: Object.freeze(ownedObjects),
    missingExpectedObjects: Object.freeze(missingExpectedObjects),
    unexpectedOwnedObjects: Object.freeze(unexpectedOwnedObjects),
    externalDependencies: Object.freeze(externalDependencies),
    schemaMatchesExpectedLegacyShape: report.schemaMatchesExpectedLegacyShape,
    dependencyClear: report.dependencyClear,
  })
}

export function normalizeAuthorityReadiness(report) {
  if (!report || typeof report !== 'object'
    || report.schemaVersion !== 2
    || report.kind !== AUTHORITY_READINESS_KIND
    || !Number.isSafeInteger(report.cityCount) || report.cityCount < 1 || report.cityCount > MAX_PUBLISHED_CITIES
    || !Number.isSafeInteger(report.rootBoundCityCount)
    || report.rootBoundCityCount < 0 || report.rootBoundCityCount > report.cityCount
    || typeof report.rootBoundAuthorityReady !== 'boolean'
    || !Array.isArray(report.blockingCities)
    || !Array.isArray(report.cities)
    || report.cities.length !== report.cityCount) {
    throw new Error('High-card retirement plan requires a valid authority readiness report')
  }

  const cities = new Map()
  for (const rawEntry of report.cities) {
    const entry = normalizeAuthorityCity(rawEntry)
    if (cities.has(entry.city)) {
      throw new Error('High-card retirement plan authority city set is invalid')
    }
    cities.set(entry.city, entry)
  }
  const actualRootBoundCount = [...cities.values()]
    .filter((entry) => entry.rootBoundRollbackWindow).length
  if (actualRootBoundCount !== report.rootBoundCityCount
    || report.rootBoundAuthorityReady !== (actualRootBoundCount === report.cityCount)) {
    throw new Error('High-card retirement plan authority summary is inconsistent')
  }

  const blockingCities = []
  const seenBlocking = new Set()
  for (const entry of report.blockingCities) {
    const city = safeCity(entry?.city)
    const authority = city ? cities.get(city) : undefined
    if (!city || seenBlocking.has(city) || !authority || authority.rootBoundRollbackWindow) {
      throw new Error('High-card retirement plan blocking city set is invalid')
    }
    if (entry.activeVersion !== authority.activeVersion
      || entry.previousVersion !== authority.previousVersion
      || entry.activeAuthorityMode !== authority.activeAuthorityMode
      || entry.previousAuthorityMode !== authority.previousAuthorityMode
      || entry.activeRoutingManifestCount !== authority.activeRoutingManifestCount
      || entry.previousRoutingManifestCount !== authority.previousRoutingManifestCount
      || entry.nativeRootBoundPublicationsRequired !== authority.nativeRootBoundPublicationsRequired) {
      throw new Error('High-card retirement plan blocking city evidence does not match authority windows')
    }
    seenBlocking.add(city)
    blockingCities.push(city)
  }
  const expectedBlocking = [...cities.values()]
    .filter((entry) => !entry.rootBoundRollbackWindow)
    .map((entry) => entry.city)
    .sort()
  blockingCities.sort()
  if (blockingCities.length !== expectedBlocking.length
    || blockingCities.some((city, index) => city !== expectedBlocking[index])) {
    throw new Error('High-card retirement plan blocking cities do not match authority windows')
  }

  return Object.freeze({
    cityCount: report.cityCount,
    rootBoundCityCount: report.rootBoundCityCount,
    rootBoundAuthorityReady: report.rootBoundAuthorityReady,
    blockingCities: Object.freeze(blockingCities),
  })
}

function normalizeAuthorityCity(entry) {
  const city = safeCity(entry?.city)
  const activeVersion = safeId(entry?.activeVersion)
  const previousVersion = safeId(entry?.previousVersion)
  const activeAuthorityMode = entry?.activeAuthorityMode
  const previousAuthorityMode = entry?.previousAuthorityMode
  const rollbackTargetAuthorityMode = entry?.rollbackTargetAuthorityMode
  const activeRoutingManifestCount = entry?.activeRoutingManifestCount
  const previousRoutingManifestCount = entry?.previousRoutingManifestCount
  const rootBoundRollbackWindow = entry?.rootBoundRollbackWindow
  const nativeRootBoundPublicationsRequired = entry?.nativeRootBoundPublicationsRequired

  if (!city || !activeVersion || !previousVersion || activeVersion === previousVersion
    || !AUTHORITY_MODES.has(activeAuthorityMode)
    || !AUTHORITY_MODES.has(previousAuthorityMode)
    || !AUTHORITY_MODES.has(rollbackTargetAuthorityMode)
    || !Number.isSafeInteger(activeRoutingManifestCount)
    || !Number.isSafeInteger(previousRoutingManifestCount)
    || typeof rootBoundRollbackWindow !== 'boolean'
    || !Number.isSafeInteger(nativeRootBoundPublicationsRequired)
    || nativeRootBoundPublicationsRequired < 0 || nativeRootBoundPublicationsRequired > 2) {
    throw new Error('High-card retirement plan authority city evidence is invalid')
  }
  if (!authorityModeMatchesCount(activeAuthorityMode, activeRoutingManifestCount)
    || !authorityModeMatchesCount(previousAuthorityMode, previousRoutingManifestCount)) {
    throw new Error('High-card retirement plan authority city evidence is inconsistent')
  }

  const expectedRootBound = activeAuthorityMode === 'root-bound'
    && previousAuthorityMode === 'root-bound'
  const expectedPublications = activeAuthorityMode === 'root-bound'
    ? (previousAuthorityMode === 'root-bound' ? 0 : 1)
    : 2
  if (rollbackTargetAuthorityMode !== previousAuthorityMode
    || rootBoundRollbackWindow !== expectedRootBound
    || nativeRootBoundPublicationsRequired !== expectedPublications) {
    throw new Error('High-card retirement plan authority city evidence is inconsistent')
  }

  return Object.freeze({
    city,
    activeVersion,
    previousVersion,
    activeAuthorityMode,
    previousAuthorityMode,
    rollbackTargetAuthorityMode,
    activeRoutingManifestCount,
    previousRoutingManifestCount,
    rootBoundRollbackWindow,
    nativeRootBoundPublicationsRequired,
  })
}

function authorityModeMatchesCount(mode, count) {
  if (count < 0 || count > COMPLETE_ROUTING_MANIFEST_COUNT) return false
  if (mode === 'legacy-d1') return count === 0
  if (mode === 'legacy-partial') return count > 0 && count < COMPLETE_ROUTING_MANIFEST_COUNT
  return count === COMPLETE_ROUTING_MANIFEST_COUNT
}

function normalizeOwnedObjects(values) {
  const names = new Set()
  return values.map((entry) => {
    const type = entry?.type
    const name = safeName(entry?.name)
    const table = safeName(entry?.table)
    if (!ALLOWED_OBJECT_TYPES.has(type) || !name || !table || !TARGET_TABLES.has(table) || names.has(name)) {
      throw new Error('High-card retirement plan schema object set is invalid')
    }
    names.add(name)
    return Object.freeze({ type, name, table })
  })
}

function normalizeDependencies(values) {
  return values.map((entry) => {
    const type = entry?.type
    const name = safeName(entry?.name)
    const table = safeName(entry?.table)
    if (!ALLOWED_OBJECT_TYPES.has(type) || !name || !table) {
      throw new Error('High-card retirement plan external dependency set is invalid')
    }
    return Object.freeze({ type, name, table })
  })
}

function normalizeNames(values, label) {
  const seen = new Set()
  return values.map((value) => {
    const name = safeName(value)
    if (!name || seen.has(name)) throw new Error(`High-card retirement plan ${label} set is invalid`)
    seen.add(name)
    return name
  }).sort()
}

function isExpectedOwnedObject(entry) {
  const expected = EXPECTED_EXPLICIT_OBJECTS.get(entry.name)
  if (expected) return entry.type === expected.type && entry.table === expected.table
  return entry.type === 'index'
    && new RegExp(`^sqlite_autoindex_${entry.table}_[1-9][0-9]*$`).test(entry.name)
}

function sameNames(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function sameObjects(left, right) {
  return left.length === right.length && left.every((entry, index) => {
    const expected = right[index]
    return entry.type === expected.type && entry.name === expected.name && entry.table === expected.table
  })
}

function compareObjects(left, right) {
  return left.table.localeCompare(right.table)
    || left.type.localeCompare(right.type)
    || left.name.localeCompare(right.name)
}

function safeName(value) {
  return typeof value === 'string' && SAFE_NAME.test(value) ? value : null
}

function safeCity(value) {
  return typeof value === 'string' && SAFE_CITY.test(value) ? value : null
}

function safeId(value) {
  return typeof value === 'string' && SAFE_ID.test(value) ? value : null
}

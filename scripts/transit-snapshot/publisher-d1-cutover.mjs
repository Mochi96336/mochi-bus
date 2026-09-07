export function buildPublisherD1ImportSql({ version, city, routes, patterns, places }) {
  if (!nonEmpty(version) || !nonEmpty(city)) throw new Error('Publisher D1 import identity is required')
  if (!(routes instanceof Map) || !Array.isArray(patterns) || !(places instanceof Map)) {
    throw new Error('Publisher D1 import collections are invalid')
  }
  const statements = ['PRAGMA foreign_keys=OFF;']
  for (const route of routes.values()) {
    statements.push(`INSERT OR REPLACE INTO routes VALUES (${values(
      version, city, route.uid, route.name, route.departure, route.destination,
    )});`)
  }
  for (const pattern of patterns) {
    statements.push(`INSERT OR REPLACE INTO patterns VALUES (${values(
      version, pattern.id, city, pattern.routeUid, pattern.subrouteUid, pattern.subrouteName,
      pattern.direction, pattern.departure, pattern.destination, pattern.shapeKey, pattern.updatedAt,
    )});`)
  }
  for (const place of places.values()) {
    statements.push(`INSERT OR REPLACE INTO stop_places VALUES (${values(
      version, place.id, city, place.name, place.lat, place.lon,
    )});`)
  }
  return statements
}

export function buildPublisherD1CleanupSql({ city, versions }) {
  if (!nonEmpty(city)) throw new Error('Publisher D1 cleanup city is required')
  const unique = [...new Set(versions ?? [])].filter(nonEmpty)
  if (!unique.length) return []
  const versionList = unique.map(sqlValue).join(',')
  // Legacy `stops` / `pattern_stops` are intentionally retained. They may still
  // be the rollback authority for the immediately previous pre-cutover version,
  // and deleting them on the normal publish path would recreate the rows_written
  // spike this cutover is designed to remove.
  return [
    `DELETE FROM stop_places WHERE city_code=${sqlValue(city)} AND version IN (${versionList});`,
    `DELETE FROM patterns WHERE city_code=${sqlValue(city)} AND version IN (${versionList});`,
    `DELETE FROM routes WHERE city_code=${sqlValue(city)} AND version IN (${versionList});`,
  ]
}

export function publisherD1ValidationSql({ version, city }) {
  if (!nonEmpty(version) || !nonEmpty(city)) throw new Error('Publisher D1 validation identity is required')
  return [
    `SELECT COUNT(*) AS count FROM routes WHERE version=${sqlValue(version)} AND city_code=${sqlValue(city)}`,
    `SELECT COUNT(*) AS count FROM patterns WHERE version=${sqlValue(version)} AND city_code=${sqlValue(city)}`,
    `SELECT COUNT(*) AS count FROM stop_places WHERE version=${sqlValue(version)} AND city_code=${sqlValue(city)}`,
    `SELECT COUNT(*) AS count FROM patterns p LEFT JOIN routes r ON r.version=p.version AND r.route_uid=p.route_uid WHERE p.version=${sqlValue(version)} AND p.city_code=${sqlValue(city)} AND r.route_uid IS NULL`,
    `SELECT COUNT(*) AS count FROM routes r WHERE r.version=${sqlValue(version)} AND r.city_code=${sqlValue(city)} AND NOT EXISTS (SELECT 1 FROM patterns p WHERE p.version=r.version AND p.city_code=r.city_code AND p.route_uid=r.route_uid)`,
  ].join(';')
}

export function assertPublisherD1Validation(result, expectedCounts) {
  const actual = Object.freeze({
    routes: countAt(result, 0, 'routes'),
    patterns: countAt(result, 1, 'patterns'),
    places: countAt(result, 2, 'places'),
  })
  for (const name of ['routes', 'patterns', 'places']) {
    const expected = nonNegativeInteger(expectedCounts?.[name], `expectedCounts.${name}`)
    if (actual[name] !== expected) {
      throw new Error(`Remote D1 ${name} count mismatch: ${actual[name]} != ${expected}`)
    }
  }
  const danglingPatterns = countAt(result, 3, 'dangling patterns')
  if (danglingPatterns !== 0) throw new Error(`Remote D1 contains ${danglingPatterns} patterns without routes`)
  const orphanRoutes = countAt(result, 4, 'orphan routes')
  if (orphanRoutes !== 0) throw new Error(`Remote D1 contains ${orphanRoutes} routes without patterns`)
  return actual
}

export function assertPublisherRoutingAuthorityCounts(actual, expected) {
  for (const name of ['patterns', 'patternStops', 'places', 'stops']) {
    const actualCount = nonNegativeInteger(actual?.[name], `routingAuthority.${name}`)
    const expectedCount = nonNegativeInteger(expected?.[name], `expectedCounts.${name}`)
    if (actualCount !== expectedCount) {
      throw new Error(`Remote R2 ${name} count mismatch: ${actualCount} != ${expectedCount}`)
    }
  }
  return true
}

function countAt(result, index, label) {
  const value = Number(result?.[index]?.results?.[0]?.count)
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Remote D1 ${label} count is invalid`)
  return value
}

function values(...items) {
  return items.map(sqlValue).join(', ')
}

function sqlValue(value) {
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'number') return String(value)
  return `'${String(value).replaceAll("'", "''")}'`
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function nonNegativeInteger(value, name) {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`${name} must be a non-negative integer`)
  return number
}

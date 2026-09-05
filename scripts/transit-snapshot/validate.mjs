import { assertPublisherManifestBudget } from './publisher-manifest-budget.mjs'
import { promotePendingTdxStaticSources } from './tdx-static-source-promotion.mjs'

export class SnapshotValidationError extends Error {
  constructor(issues) {
    super(`Snapshot validation failed:\n- ${issues.join('\n- ')}`)
    this.name = 'SnapshotValidationError'
    this.issues = issues
  }
}

export function validateSnapshot(snapshot, previousState = null) {
  const issues = []
  const counts = {
    routes: snapshot.routes.size,
    patterns: snapshot.patterns.length,
    stops: snapshot.stops.size,
    places: snapshot.places.size,
    patternStops: snapshot.patternStops.length,
    schedules: snapshot.schedules.size,
    placeBundles: snapshot.placeBundles.size,
  }
  const quality = snapshotQuality(snapshot)

  for (const [name, count] of Object.entries(counts)) {
    if (!Number.isInteger(count) || count <= 0) issues.push(`${name} must not be empty`)
  }
  compareWithPrevious(counts, quality, previousState, issues)

  const patternIds = new Set()
  const patternById = new Map()
  const patternedRouteUids = new Set()
  for (const pattern of snapshot.patterns) {
    if (!pattern.id || patternIds.has(pattern.id)) issues.push(`duplicate or empty pattern id: ${pattern.id ?? ''}`)
    patternIds.add(pattern.id)
    patternById.set(pattern.id, pattern)
    patternedRouteUids.add(pattern.routeUid)
    if (!snapshot.routes.has(pattern.routeUid)) issues.push(`pattern ${pattern.id} references missing route ${pattern.routeUid}`)
    validateLineString(pattern.id, pattern.shapeFeature, issues)
  }
  for (const routeUid of snapshot.routes.keys()) {
    if (!patternedRouteUids.has(routeUid)) issues.push(`route ${routeUid} has no pattern`)
  }

  for (const [stopUid, stop] of snapshot.stops) {
    if (!stopUid || !snapshot.places.has(stop.placeId)) {
      issues.push(`stop ${stopUid || '(empty)'} references missing place ${stop.placeId ?? ''}`)
    }
    validateCoordinate(`stop ${stopUid}`, stop.lat, stop.lon, issues)
  }
  for (const [placeId, place] of snapshot.places) {
    validateCoordinate(`place ${placeId}`, place.lat, place.lon, issues)
  }

  const sequences = new Set()
  const patternStopCounts = new Map()
  const patternStopRefs = new Set()
  const patternStopIdentities = new Set()
  const patternStopPlaceMismatches = new Map()
  for (const item of snapshot.patternStops) {
    if (!patternIds.has(item.patternId)) issues.push(`pattern stop references missing pattern ${item.patternId}`)
    const canonicalStop = snapshot.stops.get(item.stopUid)
    if (!canonicalStop) issues.push(`pattern stop references missing stop ${item.stopUid}`)
    else if (canonicalStop.placeId !== item.placeId) {
      const key = `${item.stopUid}\0${item.placeId}\0${canonicalStop.placeId}`
      const mismatch = patternStopPlaceMismatches.get(key) ?? {
        stopUid: item.stopUid, referencedPlaceId: item.placeId, canonicalPlaceId: canonicalStop.placeId, count: 0,
      }
      mismatch.count += 1
      patternStopPlaceMismatches.set(key, mismatch)
    }
    if (!snapshot.places.has(item.placeId)) issues.push(`pattern stop references missing place ${item.placeId}`)
    if (!Number.isInteger(item.sequence) || item.sequence < 0) {
      issues.push(`pattern ${item.patternId} has invalid stop sequence ${item.sequence}`)
    }
    const key = `${item.patternId}:${item.sequence}`
    if (sequences.has(key)) issues.push(`pattern ${item.patternId} has duplicate stop sequence ${item.sequence}`)
    sequences.add(key)
    patternStopCounts.set(item.patternId, (patternStopCounts.get(item.patternId) ?? 0) + 1)
    patternStopRefs.add(`${item.patternId}\0${item.stopUid}\0${item.placeId}\0${item.sequence}`)
    patternStopIdentities.add(`${item.patternId}\0${item.stopUid}\0${item.placeId}`)
  }
  for (const mismatch of patternStopPlaceMismatches.values()) {
    issues.push(`stop ${mismatch.stopUid} has ${mismatch.count} pattern reference(s) to ${mismatch.referencedPlaceId}, but canonical place is ${mismatch.canonicalPlaceId}`)
  }
  for (const patternId of patternIds) {
    const stopCount = patternStopCounts.get(patternId) ?? 0
    if (stopCount < 2) issues.push(`pattern ${patternId} has only ${stopCount} stop(s)`)
  }

  for (const routeUid of snapshot.routes.keys()) {
    if (!snapshot.schedules.has(routeUid)) issues.push(`missing schedule artifact for route ${routeUid}`)
  }
  for (const [routeUid, schedules] of snapshot.schedules) {
    if (!snapshot.routes.has(routeUid)) issues.push(`schedule artifact references missing route ${routeUid}`)
    if (!Array.isArray(schedules)) issues.push(`schedule artifact for route ${routeUid} is not an array`)
  }
  const bundleRouteIdentities = new Set()
  for (const [placeId, place] of snapshot.places) {
    const bundle = snapshot.placeBundles.get(placeId)
    if (!bundle) issues.push(`missing place bundle for ${placeId}`)
    else validatePlaceBundle(snapshot, place, bundle, patternById, patternStopRefs, bundleRouteIdentities, issues)
  }
  for (const identity of patternStopIdentities) {
    if (!bundleRouteIdentities.has(identity)) issues.push('pattern stop has no matching place bundle route')
  }

  validateNetwork(snapshot, patternIds, issues)
  if (issues.length) throw new SnapshotValidationError(issues)
  // Fresh static payloads were only staged in R2 while this model was being built.
  // Crossing the complete local validation boundary makes them safe cache authority.
  // Promotion is an optimization and stays fail-open for publication correctness.
  void promotePendingTdxStaticSources()
  // #280 made routing artifacts part of the main manifest. Bound its worst-case serialized
  // size now, while the process is still entirely local, instead of discovering the 16 MiB
  // validator ceiling after R2 objects and D1 rows have already been staged.
  assertPublisherManifestBudget({
    city: snapshot.city,
    version: snapshot.version,
    routes: snapshot.routes,
    patterns: snapshot.patterns,
    places: snapshot.places,
    counts,
    quality,
  })
  return { valid: true, counts, quality }
}

function compareWithPrevious(counts, quality, previousState, issues) {
  const previousCounts = previousState?.counts
  if (previousCounts) for (const name of ['routes', 'patterns', 'stops', 'places', 'patternStops', 'placeBundles']) {
    const previous = previousCounts[name]
    if (!Number.isInteger(previous) || previous <= 0) continue
    if (counts[name] < previous * 0.6) {
      issues.push(`${name} dropped from ${previous} to ${counts[name]} (over 40%)`)
    }
  }

  const previousQuality = previousState?.quality
  if (!previousQuality) return
  for (const name of ['bundleRoutes', 'scheduledRoutes', 'bundleRoutesWithSchedules', 'networkCoordinates', 'networkBytes']) {
    const previous = previousQuality[name]
    const current = quality[name]
    if (!Number.isFinite(previous) || previous <= 0) continue
    if (current < previous * 0.6) issues.push(`${name} dropped from ${previous} to ${current} (over 40%)`)
  }
  for (const name of ['scheduleRouteCoverage', 'bundleScheduleCoverage']) {
    const previous = previousQuality[name]
    const current = quality[name]
    if (!Number.isFinite(previous) || previous <= 0) continue
    if (current < previous * 0.6) issues.push(`${name} dropped from ${previous} to ${current} (over 40%)`)
  }
}

function snapshotQuality(snapshot) {
  const scheduledRoutes = [...snapshot.schedules.entries()].filter(([, schedules]) =>
    Array.isArray(schedules) && schedules.some(hasSchedulePayload)).length
  const bundleRoutes = [...snapshot.placeBundles.values()].flatMap((bundle) =>
    Array.isArray(bundle?.routes) ? bundle.routes : [])
  const bundleRoutesWithSchedules = bundleRoutes.filter((route) =>
    Array.isArray(route?.schedules) && route.schedules.length > 0).length
  const networkCoordinates = Array.isArray(snapshot.network?.routes)
    ? snapshot.network.routes.reduce((total, route) =>
      total + (Array.isArray(route?.shape?.geometry?.coordinates) ? route.shape.geometry.coordinates.length : 0), 0)
    : 0
  const networkBytes = new TextEncoder().encode(JSON.stringify(snapshot.network ?? null)).byteLength
  return {
    scheduledRoutes,
    scheduleRouteCoverage: ratio(scheduledRoutes, snapshot.routes.size),
    bundleRoutes: bundleRoutes.length,
    bundleRoutesWithSchedules,
    bundleScheduleCoverage: ratio(bundleRoutesWithSchedules, bundleRoutes.length),
    networkCoordinates,
    networkBytes,
  }
}

function hasSchedulePayload(schedule) {
  return (Array.isArray(schedule?.Timetables) && schedule.Timetables.length > 0)
    || (Array.isArray(schedule?.Frequencys) && schedule.Frequencys.length > 0)
}

function ratio(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : 0
}

function validatePlaceBundle(snapshot, place, bundle, patternById, patternStopRefs, bundleRouteIdentities, issues) {
  if (bundle.version !== snapshot.version || bundle.placeId !== place.id) {
    issues.push(`place bundle ${place.id} metadata does not match the snapshot`)
  }
  if (!Array.isArray(bundle.routes) || bundle.routes.length === 0) {
    issues.push(`place bundle ${place.id} has no routes`)
    return
  }
  for (const route of bundle.routes) {
    bundleRouteIdentities.add(`${route?.variantKey}\0${route?.stopUid}\0${place.id}`)
    const pattern = patternById.get(route?.variantKey)
    const stop = snapshot.stops.get(route?.stopUid)
    if (!snapshot.routes.has(route?.routeUid)) {
      issues.push(`place bundle ${place.id} references missing route ${route?.routeUid ?? ''}`)
    }
    if (!pattern) issues.push(`place bundle ${place.id} references missing pattern ${route?.variantKey ?? ''}`)
    else if (pattern.routeUid !== route?.routeUid) {
      issues.push(`place bundle ${place.id} route ${route?.routeUid ?? ''} does not match pattern ${route?.variantKey ?? ''}`)
    }
    if (!stop) issues.push(`place bundle ${place.id} references missing stop ${route?.stopUid ?? ''}`)
    else if (stop.placeId !== place.id) {
      issues.push(`place bundle ${place.id} stop ${route.stopUid} belongs to ${stop.placeId}`)
    }
    if (!patternStopRefs.has(`${route?.variantKey}\0${route?.stopUid}\0${place.id}\0${route?.stopSequence}`)) {
      issues.push(`place bundle ${place.id} route entry is not backed by a pattern stop`)
    }
    if (!Array.isArray(route?.schedules)) issues.push(`place bundle ${place.id} route schedules are not an array`)
  }
}

function validateCoordinate(label, latitude, longitude, issues) {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)
    || latitude < 20 || latitude > 27 || longitude < 117 || longitude > 123.5) {
    issues.push(`${label} has invalid Taiwan coordinate ${latitude},${longitude}`)
  }
}

function validateLineString(patternId, feature, issues) {
  const coordinates = feature?.geometry?.type === 'LineString' ? feature.geometry.coordinates : null
  if (!Array.isArray(coordinates) || coordinates.length < 2) {
    issues.push(`pattern ${patternId} has an invalid LineString`)
    return
  }
  for (const coordinate of coordinates) {
    if (!Array.isArray(coordinate) || coordinate.length < 2) {
      issues.push(`pattern ${patternId} has a malformed shape coordinate`)
      return
    }
    validateCoordinate(`pattern ${patternId}`, coordinate[1], coordinate[0], issues)
  }
}

function validateNetwork(snapshot, patternIds, issues) {
  const network = snapshot.network
  if (network?.schemaVersion !== 1 || network.city !== snapshot.city || network.version !== snapshot.version) {
    issues.push('network metadata does not match the generated snapshot')
    return
  }
  if (!Array.isArray(network.routes) || network.routes.length !== snapshot.patterns.length) {
    issues.push(`network routes count does not match patterns (${network?.routes?.length ?? 'missing'} vs ${snapshot.patterns.length})`)
  } else {
    const variants = new Set()
    for (const route of network.routes) {
      if (!patternIds.has(route.variantKey)) issues.push(`network references missing pattern ${route.variantKey}`)
      if (variants.has(route.variantKey)) issues.push(`network contains duplicate pattern ${route.variantKey}`)
      variants.add(route.variantKey)
      validateLineString(route.variantKey, route.shape, issues)
    }
    for (const patternId of patternIds) {
      if (!variants.has(patternId)) issues.push(`network is missing pattern ${patternId}`)
    }
  }
  if (!Array.isArray(network.places) || network.places.length !== snapshot.places.size) {
    issues.push(`network places count does not match places (${network?.places?.length ?? 'missing'} vs ${snapshot.places.size})`)
  } else {
    const placeIds = new Set()
    for (const place of network.places) {
      if (!snapshot.places.has(place.placeId)) issues.push(`network references missing place ${place.placeId}`)
      if (placeIds.has(place.placeId)) issues.push(`network contains duplicate place ${place.placeId}`)
      placeIds.add(place.placeId)
    }
    for (const placeId of snapshot.places.keys()) {
      if (!placeIds.has(placeId)) issues.push(`network is missing place ${placeId}`)
    }
  }
}

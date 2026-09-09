const DAY_MS = 24 * 60 * 60 * 1_000
const TOPOLOGY_RESOURCES = new Set(['Route', 'Stop', 'StopOfRoute'])
const SCOPES = new Set(['city', 'intercity'])

export function staticSourceMinimumRefreshMs(env, scope, resource) {
  if (!SCOPES.has(scope)) return 0
  const group = resourceGroup(resource)
  if (!group) return 0
  const key = `SNAPSHOT_${scope.toUpperCase()}_${group}_REFRESH_DAYS`
  return refreshDaysToMs(env?.[key])
}

export function staticSourceRefreshFloorBypassed(env) {
  const value = String(env?.SNAPSHOT_STATIC_SOURCE_BYPASS_FLOOR ?? '').trim().toLowerCase()
  return value === '1' || value === 'true' || value === 'yes'
}

function resourceGroup(resource) {
  if (TOPOLOGY_RESOURCES.has(resource)) return 'TOPOLOGY'
  if (resource === 'Schedule') return 'SCHEDULE'
  if (resource === 'Shape') return 'SHAPE'
  return null
}

function refreshDaysToMs(value) {
  if (value === undefined || value === null || String(value).trim() === '') return 0
  const days = Number(value)
  if (!Number.isInteger(days) || days < 0 || days > 365) return 0
  return days * DAY_MS
}

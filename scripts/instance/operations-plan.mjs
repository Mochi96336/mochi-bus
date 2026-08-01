import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { SUPPORTED_CITY_CODES } from './config.mjs'

export const DEFAULT_OPERATIONS_PLAN_PATH = '.generated/instance/operations-plan.json'

const SUPPORTED_CITY_SET = new Set(SUPPORTED_CITY_CODES)
const ALLOWED_ROOT_KEYS = new Set([
  'schemaVersion', 'profile', 'enabledCities', 'snapshotSchedule', 'checks', 'provisioned',
])
const ALLOWED_CHECK_KEYS = new Set(['releaseSmoke', 'publicProbe', 'windowWatchdog'])
const OPERATION_PROFILES = new Set(['starter', 'managed', 'operator'])
const SNAPSHOT_SCHEDULES = new Set(['manual', 'daily', 'taipei-weekly-sharded'])

export function resolveOperationsPlanPath({ cwd = process.cwd(), env = process.env } = {}) {
  const configured = env.MOCHI_BUS_OPERATIONS_PLAN?.trim()
  return resolve(cwd, configured || DEFAULT_OPERATIONS_PLAN_PATH)
}

export function loadOperationsPlan({
  cwd = process.cwd(),
  env = process.env,
  readFile = readFileSync,
} = {}) {
  const planPath = resolveOperationsPlanPath({ cwd, env })
  let source
  try {
    source = readFile(planPath, 'utf8')
  } catch (error) {
    throw new Error(`Cannot read operations plan ${planPath}: ${errorMessage(error)}`)
  }

  let value
  try {
    value = JSON.parse(source)
  } catch (error) {
    throw new Error(`Invalid JSON in operations plan ${planPath}: ${errorMessage(error)}`)
  }
  return validateOperationsPlan(value, { source: planPath })
}

export function validateOperationsPlan(value, { source = 'operations plan' } = {}) {
  const errors = []
  if (!isRecord(value)) {
    throw validationError([`${source} must be an object`])
  }
  rejectUnknownKeys(value, ALLOWED_ROOT_KEYS, source, errors)
  if (value.schemaVersion !== 1) errors.push(`${source}.schemaVersion must equal 1`)
  if (!OPERATION_PROFILES.has(value.profile)) {
    errors.push(`${source}.profile must be starter, managed or operator`)
  }
  if (!SNAPSHOT_SCHEDULES.has(value.snapshotSchedule)) {
    errors.push(`${source}.snapshotSchedule is not supported`)
  }
  if (typeof value.provisioned !== 'boolean') {
    errors.push(`${source}.provisioned must be a boolean`)
  }

  const enabledCities = validateEnabledCities(value.enabledCities, `${source}.enabledCities`, errors)
  const checks = value.checks
  if (!isRecord(checks)) {
    errors.push(`${source}.checks must be an object`)
  } else {
    rejectUnknownKeys(checks, ALLOWED_CHECK_KEYS, `${source}.checks`, errors)
    for (const key of ALLOWED_CHECK_KEYS) {
      if (typeof checks[key] !== 'boolean') errors.push(`${source}.checks.${key} must be a boolean`)
    }
  }

  if (errors.length > 0) throw validationError(errors)
  return Object.freeze({
    schemaVersion: 1,
    profile: value.profile,
    enabledCities: Object.freeze([...enabledCities]),
    snapshotSchedule: value.snapshotSchedule,
    checks: Object.freeze({
      releaseSmoke: checks.releaseSmoke,
      publicProbe: checks.publicProbe,
      windowWatchdog: checks.windowWatchdog,
    }),
    provisioned: value.provisioned,
  })
}

export function operationEnabledCities(options = {}) {
  return loadOperationsPlan(options).enabledCities
}

export function assertOperationCityEnabled(city, enabledCities = operationEnabledCities()) {
  const normalized = typeof city === 'string' ? city.trim() : ''
  if (!SUPPORTED_CITY_SET.has(normalized)) throw new Error(`Unsupported snapshot city: ${normalized || '<empty>'}`)
  if (!enabledCities.includes(normalized)) {
    throw new Error(`Snapshot city is not enabled for this instance: ${normalized}`)
  }
  return normalized
}

function validateEnabledCities(value, path, errors) {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push(`${path} must be a non-empty array`)
    return []
  }
  const seen = new Set()
  const cities = []
  for (const [index, city] of value.entries()) {
    if (typeof city !== 'string' || !SUPPORTED_CITY_SET.has(city)) {
      errors.push(`${path}[${index}] must be a supported city code`)
      continue
    }
    if (seen.has(city)) {
      errors.push(`${path} must not contain duplicate city ${city}`)
      continue
    }
    seen.add(city)
    cities.push(city)
  }
  return cities
}

function rejectUnknownKeys(value, allowed, path, errors) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) errors.push(`${path} contains unknown property ${key}`)
  }
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function validationError(errors) {
  return new Error(`Invalid operations plan:\n- ${errors.join('\n- ')}`)
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

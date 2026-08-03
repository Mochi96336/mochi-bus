import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export const DEFAULT_INSTANCE_RUNTIME_PATH = '.generated/instance/instance-runtime.json'

export function resolvePublicProbeBaseUrl({
  cwd = process.cwd(),
  env = process.env,
  readFile = readFileSync,
} = {}) {
  const explicit = env.SNAPSHOT_SMOKE_BASE_URL?.trim()
  if (explicit) return validOrigin(explicit, 'SNAPSHOT_SMOKE_BASE_URL')

  const configuredPath = env.MOCHI_BUS_RUNTIME_CONFIG?.trim()
    || env.MOCHI_BUS_INSTANCE_RUNTIME?.trim()
  const runtimePath = resolve(cwd, configuredPath || DEFAULT_INSTANCE_RUNTIME_PATH)
  let source
  try {
    source = readFile(runtimePath, 'utf8')
  } catch (error) {
    throw new Error(`Cannot read instance runtime ${runtimePath}: ${errorMessage(error)}`)
  }

  let runtime
  try {
    runtime = JSON.parse(source)
  } catch (error) {
    throw new Error(`Invalid JSON in instance runtime ${runtimePath}: ${errorMessage(error)}`)
  }

  const canonicalOrigin = runtime?.site?.canonicalOrigin
  if (canonicalOrigin === 'request') {
    throw new Error('SNAPSHOT_SMOKE_BASE_URL is required when the instance canonical origin is request-derived')
  }
  return validOrigin(canonicalOrigin, `${runtimePath}.site.canonicalOrigin`)
}

function validOrigin(value, label) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label} must be an absolute HTTP origin`)
  let url
  try {
    url = new URL(value)
  } catch {
    throw new Error(`${label} must be an absolute HTTP origin`)
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:')
    || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error(`${label} must be an absolute HTTP origin`)
  }
  return url.origin
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

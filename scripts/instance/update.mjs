import { lstat, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  DEFAULT_PRODUCTION_CONFIG,
  SUPPORTED_CITY_CODES,
  resolveInstanceConfigPath,
  validateInstanceConfig,
} from './config.mjs'

const PROFILES = new Set(['starter', 'managed', 'operator'])
const SNAPSHOT_SCHEDULES = new Set(['manual', 'daily', 'taipei-weekly-sharded'])
const RESERVED_DIRECTORIES = new Set(['.git', '.generated', 'node_modules'])
const CITY_SET = new Set(SUPPORTED_CITY_CODES)

const PROFILE_DEFAULTS = Object.freeze({
  starter: Object.freeze({
    workersDev: true,
    snapshotSchedule: 'manual',
    releaseSmoke: true,
    publicProbe: false,
    windowWatchdog: false,
  }),
  managed: Object.freeze({
    workersDev: true,
    snapshotSchedule: 'daily',
    releaseSmoke: true,
    publicProbe: true,
    windowWatchdog: true,
  }),
  operator: Object.freeze({
    workersDev: false,
    snapshotSchedule: 'daily',
    releaseSmoke: true,
    publicProbe: true,
    windowWatchdog: true,
  }),
})

export function parseInstanceUpdateArguments(argv = process.argv.slice(2)) {
  const options = {
    configPath: null,
    profile: null,
    siteName: null,
    origin: null,
    replaceCities: null,
    addCities: [],
    removeCities: [],
    defaultCity: null,
    workerName: null,
    d1DatabaseName: null,
    r2BucketName: null,
    databaseId: undefined,
    standardNamespaceId: undefined,
    expensiveNamespaceId: undefined,
    workersDev: undefined,
    snapshotSchedule: null,
    releaseSmoke: undefined,
    publicProbe: undefined,
    windowWatchdog: undefined,
    clearDemoQuery: false,
    write: false,
    json: false,
    help: false,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--write' || argument === '--json' || argument === '--help' || argument === '--clear-demo-query') {
      const key = argument === '--clear-demo-query' ? 'clearDemoQuery' : argument.slice(2)
      options[key] = true
      continue
    }

    const equalsIndex = argument.indexOf('=')
    const optionName = equalsIndex >= 0 ? argument.slice(0, equalsIndex) : argument
    if (!optionName.startsWith('--')) throw new Error(`Unexpected argument: ${argument}`)
    let value = equalsIndex >= 0 ? argument.slice(equalsIndex + 1) : null
    if (value === null) {
      value = argv[index + 1]
      if (!value || value.startsWith('--')) throw new Error(`Missing value after ${optionName}`)
      index += 1
    }
    if (!value) throw new Error(`Missing value after ${optionName}=`)

    switch (optionName) {
      case '--config': options.configPath = value; break
      case '--profile': options.profile = value; break
      case '--site-name': options.siteName = value; break
      case '--origin': options.origin = value; break
      case '--cities': {
        if (options.replaceCities === null) options.replaceCities = []
        options.replaceCities.push(...splitCities(value))
        break
      }
      case '--add-city': options.addCities.push(...splitCities(value)); break
      case '--remove-city': options.removeCities.push(...splitCities(value)); break
      case '--default-city': options.defaultCity = value; break
      case '--worker-name': options.workerName = value; break
      case '--d1-name': options.d1DatabaseName = value; break
      case '--r2-name': options.r2BucketName = value; break
      case '--database-id': options.databaseId = nullIfLiteral(value); break
      case '--standard-rate-limit-id': options.standardNamespaceId = nullIfLiteral(value); break
      case '--expensive-rate-limit-id': options.expensiveNamespaceId = nullIfLiteral(value); break
      case '--workers-dev': options.workersDev = parseBoolean(value, optionName); break
      case '--snapshot-schedule': options.snapshotSchedule = value; break
      case '--release-smoke': options.releaseSmoke = parseBoolean(value, optionName); break
      case '--public-probe': options.publicProbe = parseBoolean(value, optionName); break
      case '--window-watchdog': options.windowWatchdog = parseBoolean(value, optionName); break
      default: throw new Error(`Unknown instance update option: ${optionName}`)
    }
  }

  return Object.freeze({
    ...options,
    replaceCities: options.replaceCities === null ? null : Object.freeze([...options.replaceCities]),
    addCities: Object.freeze([...options.addCities]),
    removeCities: Object.freeze([...options.removeCities]),
  })
}

export async function buildInstanceUpdate(options, {
  cwd = process.cwd(),
  env = process.env,
} = {}) {
  if (!options || typeof options !== 'object') throw new Error('Instance update options are required')
  if (!hasRequestedChanges(options)) {
    throw new Error('No manifest updates requested; specify at least one field to change')
  }
  if (options.replaceCities !== null && (options.addCities.length > 0 || options.removeCities.length > 0)) {
    throw new Error('--cities cannot be combined with --add-city or --remove-city')
  }

  const requestedPath = await resolveInstanceConfigPath({
    cwd,
    argv: options.configPath ? ['--config', options.configPath] : [],
    env,
  })
  const loaded = await loadEditableManifest(requestedPath, { cwd })
  const before = structuredClone(loaded.manifest)
  const manifest = structuredClone(loaded.manifest)
  const warnings = []

  if (options.profile !== null) {
    const profile = requiredChoice(options.profile, PROFILES, '--profile')
    manifest.operations.profile = profile
    manifest.cloudflare.workersDev = PROFILE_DEFAULTS[profile].workersDev
    manifest.operations.snapshotSchedule = PROFILE_DEFAULTS[profile].snapshotSchedule
    manifest.operations.releaseSmoke = PROFILE_DEFAULTS[profile].releaseSmoke
    manifest.operations.publicProbe = PROFILE_DEFAULTS[profile].publicProbe
    manifest.operations.windowWatchdog = PROFILE_DEFAULTS[profile].windowWatchdog
    if (profile !== before.operations.profile) {
      warnings.push(`Profile changed from ${before.operations.profile} to ${profile}; profile operation defaults were reapplied.`)
    } else {
      warnings.push(`Profile ${profile} operation defaults were reapplied.`)
    }
  }

  if (options.siteName !== null) manifest.site.name = requiredString(options.siteName, '--site-name')
  if (options.origin !== null) manifest.site.canonicalOrigin = normalizeOrigin(options.origin)
  if (options.workerName !== null) manifest.cloudflare.workerName = requiredString(options.workerName, '--worker-name')
  if (options.d1DatabaseName !== null) manifest.cloudflare.d1.databaseName = requiredString(options.d1DatabaseName, '--d1-name')
  if (options.r2BucketName !== null) manifest.cloudflare.r2.bucketName = requiredString(options.r2BucketName, '--r2-name')
  if (options.databaseId !== undefined) manifest.cloudflare.d1.databaseId = options.databaseId
  if (options.standardNamespaceId !== undefined) {
    manifest.cloudflare.rateLimits.standardNamespaceId = options.standardNamespaceId
  }
  if (options.expensiveNamespaceId !== undefined) {
    manifest.cloudflare.rateLimits.expensiveNamespaceId = options.expensiveNamespaceId
  }
  if (options.workersDev !== undefined) manifest.cloudflare.workersDev = options.workersDev
  if (options.snapshotSchedule !== null) {
    manifest.operations.snapshotSchedule = requiredChoice(
      options.snapshotSchedule,
      SNAPSHOT_SCHEDULES,
      '--snapshot-schedule',
    )
  }
  if (options.releaseSmoke !== undefined) manifest.operations.releaseSmoke = options.releaseSmoke
  if (options.publicProbe !== undefined) manifest.operations.publicProbe = options.publicProbe
  if (options.windowWatchdog !== undefined) manifest.operations.windowWatchdog = options.windowWatchdog

  const enabledCities = updateCities(manifest.transit.enabledCities, options)
  const defaultCity = options.defaultCity === null
    ? manifest.transit.defaultCity
    : validateCity(options.defaultCity, '--default-city')
  if (!enabledCities.includes(defaultCity)) {
    if (options.defaultCity === null) {
      throw new Error(`The update removes default city ${defaultCity}; pass --default-city with an enabled replacement`)
    }
    throw new Error('--default-city must be included in the updated city set')
  }
  if (
    manifest.transit.demoQuery
    && !enabledCities.includes(manifest.transit.demoQuery.city)
    && !options.clearDemoQuery
  ) {
    throw new Error(
      `The update removes demo query city ${manifest.transit.demoQuery.city}; preserve that city or pass --clear-demo-query`,
    )
  }
  manifest.transit.enabledCities = enabledCities
  manifest.transit.defaultCity = defaultCity
  if (options.clearDemoQuery) manifest.transit.demoQuery = null

  const strictValidation = inspectEditableManifest(manifest, { source: 'updated instance manifest' })
  const changes = collectChanges(before, manifest)

  if (
    before.cloudflare.d1.databaseName !== manifest.cloudflare.d1.databaseName
    && manifest.cloudflare.d1.databaseId
  ) {
    warnings.push('D1 database name changed while the existing database ID was preserved; verify the remote ID/name pair with npm run instance:doctor -- --remote.')
  }
  if (before.cloudflare.r2.bucketName !== manifest.cloudflare.r2.bucketName) {
    warnings.push('R2 bucket name changed; no bucket content was copied or migrated.')
  }
  if (before.cloudflare.workerName !== manifest.cloudflare.workerName) {
    warnings.push('Worker name changed; no Worker was deployed or renamed by this command.')
  }
  if (before.transit.demoQuery !== null && manifest.transit.demoQuery === null) {
    warnings.push('The home-page demo query was explicitly cleared.')
  }
  if (!strictValidation.valid) {
    warnings.push('The result is an operator provisioning draft; finish the D1 and rate-limit identities with instance:provision-plan.')
  }

  return Object.freeze({
    configPath: loaded.configPath,
    displayPath: loaded.displayPath,
    source: loaded.source,
    sourceIdentity: loaded.sourceIdentity,
    format: loaded.format,
    before: deepFreeze(before),
    manifest: deepFreeze(manifest),
    changes: Object.freeze(changes.map((change) => deepFreeze(change))),
    warnings: Object.freeze(uniqueStrings(warnings)),
    changed: changes.length > 0,
    strictValidation,
    provisioningDraft: !strictValidation.valid,
  })
}

export async function writeInstanceUpdate(result) {
  if (!result.changed) return false
  const currentMetadata = await lstat(result.configPath)
  if (!currentMetadata.isFile() || currentMetadata.isSymbolicLink()) {
    throw new Error('Refusing to replace a non-regular or symbolic-link instance manifest')
  }
  if (
    currentMetadata.dev !== result.sourceIdentity.dev
    || currentMetadata.ino !== result.sourceIdentity.ino
    || (currentMetadata.mode & 0o777) !== result.sourceIdentity.mode
  ) {
    throw new Error('Instance manifest changed after preview; rebuild the update before writing')
  }
  const currentSource = await readFile(result.configPath, 'utf8')
  if (currentSource !== result.source) {
    throw new Error('Instance manifest changed after preview; rebuild the update before writing')
  }

  const temporary = `${result.configPath}.tmp-${process.pid}-${Date.now()}`
  try {
    await writeFile(temporary, serializeManifest(result.manifest, result.format), {
      encoding: 'utf8',
      mode: result.sourceIdentity.mode,
    })
    await rename(temporary, result.configPath)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
  return true
}

export function renderInstanceUpdateText(result, { written = false } = {}) {
  const lines = [
    written ? `Updated Mochi Bus instance manifest: ${result.displayPath}` : 'Mochi Bus instance update preview',
    `Config: ${result.displayPath}`,
    `State: ${result.provisioningDraft ? 'operator provisioning draft' : 'valid instance manifest'}`,
    '',
  ]

  if (result.changes.length === 0) {
    lines.push('No effective changes.')
  } else {
    lines.push(`Changes (${result.changes.length}):`)
    for (const change of result.changes) {
      lines.push(`~ ${change.path}`)
      lines.push(`  before: ${formatDiffValue(change.before)}`)
      lines.push(`  after:  ${formatDiffValue(change.after)}`)
    }
  }

  if (result.warnings.length > 0) {
    lines.push('', 'Warnings:')
    for (const warning of result.warnings) lines.push(`- ${warning}`)
  }

  if (!written) {
    lines.push('', 'NO FILE WAS CHANGED')
    if (result.changed) lines.push('Re-run the same command with --write to apply this exact update.')
  } else if (result.provisioningDraft) {
    lines.push('', `Next: npm run instance:provision-plan -- --config ${shellQuote(result.displayPath)}`)
  } else {
    lines.push('', `Next: npm run instance:validate -- --config ${shellQuote(result.displayPath)}`)
  }
  return `${lines.join('\n')}\n`
}

export function renderInstanceUpdateJson(result, { written = false } = {}) {
  return {
    schemaVersion: 1,
    written,
    changed: result.changed,
    configPath: result.displayPath,
    provisioningDraft: result.provisioningDraft,
    strictValidation: result.strictValidation,
    changes: result.changes,
    warnings: result.warnings,
    manifest: result.manifest,
  }
}

export function instanceUpdateUsage() {
  return `Preview or apply a safe Mochi Bus instance manifest update.\n\nUsage:\n  npm run instance:update -- [--config <path>] <changes>\n  npm run instance:update -- [--config <path>] <changes> --write\n\nThe command previews a JSON-path diff by default. It writes only when --write is supplied.\n\nIdentity and profile:\n  --profile <starter|managed|operator>  Change profile and reapply its operation defaults\n  --site-name <name>                   Change the public site name\n  --origin <request|https://host>       Change the canonical origin\n\nCities:\n  --cities <City[,City...]>             Replace the enabled city set\n  --add-city <City[,City...]>           Append enabled cities\n  --remove-city <City[,City...]>        Remove enabled cities\n  --default-city <city>                 Select an enabled default city\n  --clear-demo-query                    Explicitly remove the preserved demo query\n\nCloudflare resources:\n  --worker-name <name>                  Change the Worker name\n  --d1-name <name>                      Change the D1 database name while preserving its ID\n  --r2-name <name>                      Change the R2 bucket name\n  --database-id <uuid|null>             Change or clear the D1 ID\n  --standard-rate-limit-id <id|null>    Change or clear the standard namespace ID\n  --expensive-rate-limit-id <id|null>   Change or clear the expensive namespace ID\n  --workers-dev <true|false>            Override workers.dev publication\n\nOperations:\n  --snapshot-schedule <manual|daily|taipei-weekly-sharded>\n  --release-smoke <true|false>\n  --public-probe <true|false>\n  --window-watchdog <true|false>\n\nExecution:\n  --config <path>                       Manifest path (default resolution ends at ${DEFAULT_PRODUCTION_CONFIG})\n  --write                               Atomically apply the previewed update\n  --json                                Print a machine-readable result\n  --help                                Show this help\n\nSupported city codes:\n  ${SUPPORTED_CITY_CODES.join(', ')}\n`
}

export async function main({
  argv = process.argv.slice(2),
  cwd = process.cwd(),
  env = process.env,
  stdout = process.stdout,
} = {}) {
  const options = parseInstanceUpdateArguments(argv)
  if (options.help) {
    stdout.write(instanceUpdateUsage())
    return null
  }

  const result = await buildInstanceUpdate(options, { cwd, env })
  const written = options.write ? await writeInstanceUpdate(result) : false
  if (options.json) {
    stdout.write(`${JSON.stringify(renderInstanceUpdateJson(result, { written }), null, 2)}\n`)
  } else {
    stdout.write(renderInstanceUpdateText(result, { written }))
  }
  return result
}

async function loadEditableManifest(configPath, { cwd }) {
  const root = resolve(cwd)
  const target = resolve(configPath)
  const logicalRelative = relative(root, target)
  assertInsideRepository(logicalRelative, target)
  if (extname(target).toLowerCase() !== '.json') throw new Error('Instance manifest path must end in .json')
  const firstSegment = logicalRelative.split(sep)[0]
  if (RESERVED_DIRECTORIES.has(firstSegment)) {
    throw new Error(`Instance manifest cannot be updated inside ${firstSegment}`)
  }

  let metadata
  try {
    metadata = await lstat(target)
  } catch (error) {
    throw new Error(`Cannot inspect instance manifest ${displayPath(cwd, target)}: ${errorMessage(error)}`)
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error('Instance manifest must be a regular file, not a directory or symbolic link')
  }

  const [realRoot, realTarget] = await Promise.all([realpath(root), realpath(target)])
  const physicalRelative = relative(realRoot, realTarget)
  assertInsideRepository(physicalRelative, realTarget)

  let source
  try {
    source = await readFile(target, 'utf8')
  } catch (error) {
    throw new Error(`Cannot read instance manifest ${displayPath(cwd, target)}: ${errorMessage(error)}`)
  }
  let manifest
  try {
    manifest = JSON.parse(source)
  } catch (error) {
    throw new Error(`Invalid JSON in instance manifest ${displayPath(cwd, target)}: ${errorMessage(error)}`)
  }
  inspectEditableManifest(manifest, { source: displayPath(cwd, target) })

  return Object.freeze({
    configPath: target,
    displayPath: displayPath(cwd, target),
    source,
    sourceIdentity: Object.freeze({
      dev: metadata.dev,
      ino: metadata.ino,
      mode: metadata.mode & 0o777,
    }),
    format: Object.freeze(detectJsonFormat(source)),
    manifest: deepFreeze(manifest),
  })
}

function inspectEditableManifest(manifest, { source }) {
  try {
    validateInstanceConfig(manifest, { source })
    return Object.freeze({ valid: true, errors: Object.freeze([]) })
  } catch (strictError) {
    if (manifest?.operations?.profile !== 'operator') throw strictError
    const draftShape = structuredClone(manifest)
    draftShape.operations.profile = 'managed'
    validateInstanceConfig(draftShape, { source: `${source} operator draft` })
    const errors = validationMessages(strictError)
    if (errors.length === 0 || errors.some((message) => !isProvisioningIdentityError(message))) {
      throw strictError
    }
    return Object.freeze({ valid: false, errors: Object.freeze(errors) })
  }
}

function updateCities(currentCities, options) {
  const additions = uniqueCities(options.addCities, '--add-city')
  const removals = uniqueCities(options.removeCities, '--remove-city')
  for (const city of additions) {
    if (removals.includes(city)) throw new Error(`${city} cannot be both added and removed`)
  }

  let cities = options.replaceCities === null
    ? [...currentCities]
    : uniqueCities(options.replaceCities, '--cities')
  for (const city of additions) {
    if (!cities.includes(city)) cities.push(city)
  }
  for (const city of removals) {
    if (!cities.includes(city)) throw new Error(`Cannot remove ${city}; it is not currently enabled`)
    cities = cities.filter((candidate) => candidate !== city)
  }
  if (cities.length === 0) throw new Error('The updated city set must contain at least one city')
  return cities
}

function collectChanges(before, after, path = '') {
  if (deepEqual(before, after)) return []
  if (Array.isArray(before) || Array.isArray(after) || !isRecord(before) || !isRecord(after)) {
    return [{ path: path || '$', before, after }]
  }
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])]
  const changes = []
  for (const key of keys) {
    const childPath = path ? `${path}.${key}` : key
    changes.push(...collectChanges(before[key], after[key], childPath))
  }
  return changes
}

function hasRequestedChanges(options) {
  return options.profile !== null
    || options.siteName !== null
    || options.origin !== null
    || options.replaceCities !== null
    || options.addCities.length > 0
    || options.removeCities.length > 0
    || options.defaultCity !== null
    || options.workerName !== null
    || options.d1DatabaseName !== null
    || options.r2BucketName !== null
    || options.databaseId !== undefined
    || options.standardNamespaceId !== undefined
    || options.expensiveNamespaceId !== undefined
    || options.workersDev !== undefined
    || options.snapshotSchedule !== null
    || options.releaseSmoke !== undefined
    || options.publicProbe !== undefined
    || options.windowWatchdog !== undefined
    || options.clearDemoQuery
}

function normalizeOrigin(value) {
  const origin = requiredString(value, '--origin')
  if (origin === 'request') return origin
  let parsed
  try {
    parsed = new URL(origin)
  } catch {
    throw new Error('--origin must be request or a fixed HTTPS origin')
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error('--origin must be request or a fixed HTTPS origin without a path, query or fragment')
  }
  return parsed.origin
}

function uniqueCities(values, optionName) {
  const result = []
  for (const value of values ?? []) {
    const city = validateCity(value, optionName)
    if (!result.includes(city)) result.push(city)
  }
  if (values && values.length > 0 && result.length === 0) throw new Error(`${optionName} must include a city`)
  return result
}

function validateCity(value, optionName) {
  const city = requiredString(value, optionName)
  if (!CITY_SET.has(city)) throw new Error(`Unsupported city code for ${optionName}: ${city}`)
  return city
}

function requiredChoice(value, choices, optionName) {
  const normalized = requiredString(value, optionName)
  if (!choices.has(normalized)) throw new Error(`Unsupported value for ${optionName}: ${normalized}`)
  return normalized
}

function parseBoolean(value, optionName) {
  const normalized = String(value).trim().toLowerCase()
  if (normalized === 'true') return true
  if (normalized === 'false') return false
  throw new Error(`${optionName} must be true or false`)
}

function nullIfLiteral(value) {
  return value.trim().toLowerCase() === 'null' ? null : value.trim()
}

function splitCities(value) {
  const cities = value.split(',').map((city) => city.trim()).filter(Boolean)
  if (cities.length === 0) throw new Error('City options must include at least one city code')
  return cities
}

function validationMessages(error) {
  return String(error?.message ?? error)
    .split('\n')
    .map((line) => line.replace(/^Instance config validation failed:\s*/, '').replace(/^\s*-\s*/, '').trim())
    .filter(Boolean)
}

function isProvisioningIdentityError(message) {
  return /databaseId is required for operator profile/.test(message)
    || /namespace IDs are required for operator profile/.test(message)
}

function detectJsonFormat(source) {
  const eol = source.includes('\r\n') ? '\r\n' : '\n'
  const indentation = source.match(/\r?\n([ \t]+)"/)?.[1] ?? ''
  return {
    eol,
    indentation,
    trailingNewline: source.endsWith('\n'),
  }
}

function serializeManifest(manifest, format) {
  const spacing = format.indentation || undefined
  const json = JSON.stringify(manifest, null, spacing).replaceAll('\n', format.eol)
  return `${json}${format.trailingNewline ? format.eol : ''}`
}

function assertInsideRepository(pathFromRoot, target) {
  if (
    !pathFromRoot
    || pathFromRoot === '..'
    || pathFromRoot.startsWith(`..${sep}`)
    || isAbsolute(pathFromRoot)
  ) {
    throw new Error(`Instance manifest must stay inside the repository: ${target}`)
  }
}

function displayPath(cwd, path) {
  return relative(resolve(cwd), path).split(sep).join('/') || '.'
}

function formatDiffValue(value) {
  return JSON.stringify(value)
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`
}

function requiredString(value, optionName) {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (!normalized) throw new Error(`${optionName} is required`)
  return normalized
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function deepEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function uniqueStrings(values) {
  return [...new Set(values)]
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const child of Object.values(value)) deepFreeze(child)
  return value
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    process.stderr.write(`${errorMessage(error)}\n`)
    process.exitCode = 1
  })
}

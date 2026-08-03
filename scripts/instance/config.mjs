import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'

export const INSTANCE_SCHEMA_VERSION = 1
export const DEFAULT_PRODUCTION_CONFIG = 'instances/mochi-production.json'
export const DEFAULT_OUTPUT_DIRECTORY = '.generated/instance'

export const SUPPORTED_CITY_CODES = Object.freeze([
  'Taipei',
  'NewTaipei',
  'Taoyuan',
  'Taichung',
  'Tainan',
  'Kaohsiung',
  'Keelung',
  'Hsinchu',
  'HsinchuCounty',
  'MiaoliCounty',
  'ChanghuaCounty',
  'NantouCounty',
  'YunlinCounty',
  'Chiayi',
  'ChiayiCounty',
  'PingtungCounty',
  'YilanCounty',
  'HualienCounty',
  'TaitungCounty',
  'KinmenCounty',
  'PenghuCounty',
  'LienchiangCounty',
])

const SUPPORTED_CITY_SET = new Set(SUPPORTED_CITY_CODES)
const INSTANCE_ID = /^[a-z](?:[a-z0-9-]{1,61}[a-z0-9])$/
const CLOUDFLARE_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
const R2_BUCKET_NAME = /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/
const D1_DATABASE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const RATE_LIMIT_NAMESPACE_ID = /^[1-9][0-9]{0,19}$/
const ALLOWED_TOP_LEVEL_KEYS = new Set([
  '$schema', 'schemaVersion', 'instanceId', 'site', 'transit', 'cloudflare', 'operations',
])

export async function resolveInstanceConfigPath({
  cwd = process.cwd(),
  argv = process.argv.slice(2),
  env = process.env,
} = {}) {
  const cli = parseCliArguments(argv)
  if (cli.configPath) return absoluteFrom(cwd, cli.configPath)
  if (env.MOCHI_BUS_INSTANCE_CONFIG?.trim()) {
    return absoluteFrom(cwd, env.MOCHI_BUS_INSTANCE_CONFIG.trim())
  }

  const local = resolve(cwd, 'instance.json')
  if (await exists(local)) return local
  return resolve(cwd, DEFAULT_PRODUCTION_CONFIG)
}

export function parseCliArguments(argv = []) {
  let configPath = null
  let outputDirectory = null
  const positional = []

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--config') {
      const value = argv[index + 1]
      if (!value || value.startsWith('--')) throw new Error('Missing value after --config')
      configPath = value
      index += 1
      continue
    }
    if (argument.startsWith('--config=')) {
      configPath = argument.slice('--config='.length)
      if (!configPath) throw new Error('Missing value after --config=')
      continue
    }
    if (argument === '--out-dir') {
      const value = argv[index + 1]
      if (!value || value.startsWith('--')) throw new Error('Missing value after --out-dir')
      outputDirectory = value
      index += 1
      continue
    }
    if (argument.startsWith('--out-dir=')) {
      outputDirectory = argument.slice('--out-dir='.length)
      if (!outputDirectory) throw new Error('Missing value after --out-dir=')
      continue
    }
    if (argument.startsWith('--')) throw new Error(`Unknown option: ${argument}`)
    positional.push(argument)
  }

  if (!configPath && positional.length > 0) configPath = positional.shift()
  if (positional.length > 0) throw new Error(`Unexpected argument: ${positional[0]}`)
  return Object.freeze({ configPath, outputDirectory })
}

export async function loadInstanceConfig(configPath) {
  let source
  try {
    source = await readFile(configPath, 'utf8')
  } catch (error) {
    throw new Error(`Cannot read instance config ${configPath}: ${errorMessage(error)}`)
  }

  let value
  try {
    value = JSON.parse(source)
  } catch (error) {
    throw new Error(`Invalid JSON in instance config ${configPath}: ${errorMessage(error)}`)
  }

  return validateInstanceConfig(value, { source: configPath })
}

export function validateInstanceConfig(value, { source = 'instance config' } = {}) {
  const errors = []
  const root = expectObject(value, source, errors)
  if (!root) throw validationError(errors)

  rejectUnknownKeys(root, ALLOWED_TOP_LEVEL_KEYS, source, errors)
  if (root.$schema !== undefined) nonEmptyString(root.$schema, `${source}.$schema`, errors, 500)
  exactNumber(root.schemaVersion, INSTANCE_SCHEMA_VERSION, `${source}.schemaVersion`, errors)
  stringMatching(root.instanceId, INSTANCE_ID, `${source}.instanceId`, errors)

  const site = expectObject(root.site, `${source}.site`, errors)
  if (site) {
    rejectUnknownKeys(site, new Set(['name', 'canonicalOrigin']), `${source}.site`, errors)
    nonEmptyString(site.name, `${source}.site.name`, errors, 80)
    canonicalOrigin(site.canonicalOrigin, `${source}.site.canonicalOrigin`, errors)
  }

  const transit = expectObject(root.transit, `${source}.transit`, errors)
  let enabledCities = []
  if (transit) {
    rejectUnknownKeys(
      transit,
      new Set(['enabledCities', 'defaultCity', 'demoQuery']),
      `${source}.transit`,
      errors,
    )
    enabledCities = cityArray(transit.enabledCities, `${source}.transit.enabledCities`, errors)
    cityCode(transit.defaultCity, `${source}.transit.defaultCity`, errors)
    if (typeof transit.defaultCity === 'string' && !enabledCities.includes(transit.defaultCity)) {
      errors.push(`${source}.transit.defaultCity must be included in enabledCities`)
    }
    validateDemoQuery(transit.demoQuery, enabledCities, `${source}.transit.demoQuery`, errors)
  }

  const cloudflare = expectObject(root.cloudflare, `${source}.cloudflare`, errors)
  if (cloudflare) {
    rejectUnknownKeys(
      cloudflare,
      new Set(['workerName', 'workersDev', 'd1', 'r2', 'rateLimits']),
      `${source}.cloudflare`,
      errors,
    )
    stringMatching(cloudflare.workerName, CLOUDFLARE_NAME, `${source}.cloudflare.workerName`, errors)
    booleanValue(cloudflare.workersDev, `${source}.cloudflare.workersDev`, errors)

    const d1 = expectObject(cloudflare.d1, `${source}.cloudflare.d1`, errors)
    if (d1) {
      rejectUnknownKeys(d1, new Set(['databaseName', 'databaseId']), `${source}.cloudflare.d1`, errors)
      stringMatching(d1.databaseName, CLOUDFLARE_NAME, `${source}.cloudflare.d1.databaseName`, errors)
      nullableMatching(d1.databaseId, D1_DATABASE_ID, `${source}.cloudflare.d1.databaseId`, errors)
    }

    const r2 = expectObject(cloudflare.r2, `${source}.cloudflare.r2`, errors)
    if (r2) {
      rejectUnknownKeys(r2, new Set(['bucketName']), `${source}.cloudflare.r2`, errors)
      stringMatching(r2.bucketName, R2_BUCKET_NAME, `${source}.cloudflare.r2.bucketName`, errors)
    }

    const rateLimits = expectObject(root.cloudflare.rateLimits, `${source}.cloudflare.rateLimits`, errors)
    if (rateLimits) {
      rejectUnknownKeys(
        rateLimits,
        new Set(['standardNamespaceId', 'expensiveNamespaceId']),
        `${source}.cloudflare.rateLimits`,
        errors,
      )
      nullableMatching(
        rateLimits.standardNamespaceId,
        RATE_LIMIT_NAMESPACE_ID,
        `${source}.cloudflare.rateLimits.standardNamespaceId`,
        errors,
      )
      nullableMatching(
        rateLimits.expensiveNamespaceId,
        RATE_LIMIT_NAMESPACE_ID,
        `${source}.cloudflare.rateLimits.expensiveNamespaceId`,
        errors,
      )
      if (rateLimits.standardNamespaceId && rateLimits.standardNamespaceId === rateLimits.expensiveNamespaceId) {
        errors.push(`${source}.cloudflare.rateLimits namespace IDs must be distinct`)
      }
    }
  }

  const operations = expectObject(root.operations, `${source}.operations`, errors)
  if (operations) {
    rejectUnknownKeys(
      operations,
      new Set(['profile', 'snapshotSchedule', 'releaseSmoke', 'publicProbe', 'windowWatchdog']),
      `${source}.operations`,
      errors,
    )
    enumValue(operations.profile, ['starter', 'managed', 'operator'], `${source}.operations.profile`, errors)
    enumValue(
      operations.snapshotSchedule,
      ['manual', 'daily', 'taipei-weekly-sharded'],
      `${source}.operations.snapshotSchedule`,
      errors,
    )
    booleanValue(operations.releaseSmoke, `${source}.operations.releaseSmoke`, errors)
    booleanValue(operations.publicProbe, `${source}.operations.publicProbe`, errors)
    booleanValue(operations.windowWatchdog, `${source}.operations.windowWatchdog`, errors)

    if (operations.profile === 'starter') {
      if (operations.snapshotSchedule !== 'manual') {
        errors.push(`${source}.operations starter profile requires snapshotSchedule="manual"`)
      }
      if (operations.publicProbe) errors.push(`${source}.operations starter profile cannot enable publicProbe`)
      if (operations.windowWatchdog) errors.push(`${source}.operations starter profile cannot enable windowWatchdog`)
    }

    if (operations.profile === 'operator') {
      if (site?.canonicalOrigin === 'request') {
        errors.push(`${source}.site.canonicalOrigin must be fixed for operator profile`)
      }
      if (cloudflare?.workersDev !== false) {
        errors.push(`${source}.cloudflare.workersDev must be false for operator profile`)
      }
      if (!cloudflare?.d1?.databaseId) {
        errors.push(`${source}.cloudflare.d1.databaseId is required for operator profile`)
      }
      if (!cloudflare?.rateLimits?.standardNamespaceId || !cloudflare?.rateLimits?.expensiveNamespaceId) {
        errors.push(`${source}.cloudflare.rateLimits namespace IDs are required for operator profile`)
      }
      if (!operations.releaseSmoke || !operations.publicProbe || !operations.windowWatchdog) {
        errors.push(`${source}.operations operator profile requires all verification checks`)
      }
    }

    if (operations.windowWatchdog && operations.snapshotSchedule === 'manual') {
      errors.push(`${source}.operations windowWatchdog requires an automatic snapshot schedule`)
    }
  }

  if (errors.length > 0) throw validationError(errors)
  return deepFreeze(structuredClone(root))
}

export function compileInstanceConfig(config) {
  const validated = validateInstanceConfig(config)
  const d1Binding = {
    binding: 'TRANSIT_DB',
    database_name: validated.cloudflare.d1.databaseName,
    migrations_dir: 'migrations',
    ...(validated.cloudflare.d1.databaseId
      ? { database_id: validated.cloudflare.d1.databaseId }
      : {}),
  }

  const rateLimits = []
  if (validated.cloudflare.rateLimits.standardNamespaceId) {
    rateLimits.push({
      name: 'API_STANDARD_RATE_LIMITER',
      namespace_id: validated.cloudflare.rateLimits.standardNamespaceId,
      simple: { limit: 120, period: 60 },
    })
  }
  if (validated.cloudflare.rateLimits.expensiveNamespaceId) {
    rateLimits.push({
      name: 'API_EXPENSIVE_RATE_LIMITER',
      namespace_id: validated.cloudflare.rateLimits.expensiveNamespaceId,
      simple: { limit: 30, period: 60 },
    })
  }

  const runtime = {
    schemaVersion: INSTANCE_SCHEMA_VERSION,
    instanceId: validated.instanceId,
    site: validated.site,
    transit: validated.transit,
    operationsProfile: validated.operations.profile,
  }

  const wrangler = {
    $schema: 'node_modules/wrangler/config-schema.json',
    name: validated.cloudflare.workerName,
    main: 'src/index.ts',
    compatibility_date: '2026-07-03',
    workers_dev: validated.cloudflare.workersDev,
    assets: { directory: 'public' },
    observability: { enabled: true, logs: { invocation_logs: false } },
    version_metadata: { binding: 'CF_VERSION_METADATA' },
    ...(rateLimits.length > 0 ? { ratelimits: rateLimits } : {}),
    d1_databases: [d1Binding],
    r2_buckets: [{
      binding: 'TRANSIT_SHAPES',
      bucket_name: validated.cloudflare.r2.bucketName,
    }],
  }

  const operations = {
    schemaVersion: INSTANCE_SCHEMA_VERSION,
    profile: validated.operations.profile,
    enabledCities: validated.transit.enabledCities,
    snapshotSchedule: validated.operations.snapshotSchedule,
    checks: {
      releaseSmoke: validated.operations.releaseSmoke,
      publicProbe: validated.operations.publicProbe,
      windowWatchdog: validated.operations.windowWatchdog,
    },
    provisioned: Boolean(
      validated.cloudflare.d1.databaseId
      && validated.cloudflare.rateLimits.standardNamespaceId
      && validated.cloudflare.rateLimits.expensiveNamespaceId,
    ),
  }

  return deepFreeze({ runtime, wrangler, operations })
}

export async function writeCompiledInstance(
  compiled,
  outputDirectory,
  { workingDirectory = process.cwd() } = {},
) {
  const target = resolve(outputDirectory)
  assertSafeOutputDirectory(target, workingDirectory)
  const parent = dirname(target)
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}`
  const wrangler = rebaseWranglerConfig(compiled.wrangler, target, workingDirectory)
  await mkdir(parent, { recursive: true })
  await rm(temporary, { recursive: true, force: true })
  await mkdir(temporary, { recursive: true })

  try {
    await Promise.all([
      writeJson(join(temporary, 'instance-runtime.json'), compiled.runtime),
      writeJson(join(temporary, 'wrangler.instance.jsonc'), wrangler),
      writeJson(join(temporary, 'operations-plan.json'), compiled.operations),
    ])
    await rm(target, { recursive: true, force: true })
    await rename(temporary, target)
  } catch (error) {
    await rm(temporary, { recursive: true, force: true })
    throw error
  }

  return Object.freeze({
    outputDirectory: target,
    files: Object.freeze([
      join(target, 'instance-runtime.json'),
      join(target, 'wrangler.instance.jsonc'),
      join(target, 'operations-plan.json'),
    ]),
  })
}

export function rebaseWranglerConfig(wrangler, outputDirectory, workingDirectory = process.cwd()) {
  const configDirectory = resolve(outputDirectory)
  const projectRoot = resolve(workingDirectory)
  const rootFromConfig = relative(configDirectory, projectRoot) || '.'
  const fromProject = (path) => join(rootFromConfig, path).split(sep).join('/')
  const rebased = structuredClone(wrangler)
  rebased.$schema = fromProject('node_modules/wrangler/config-schema.json')
  rebased.main = fromProject('src/index.ts')
  rebased.assets = { ...rebased.assets, directory: fromProject('public') }
  rebased.d1_databases = rebased.d1_databases.map((binding) => ({
    ...binding,
    migrations_dir: fromProject('migrations'),
  }))
  return deepFreeze(rebased)
}

function assertSafeOutputDirectory(target, workingDirectory) {
  const cwd = resolve(workingDirectory)
  const filesystemRoot = parse(target).root
  if (target === filesystemRoot || target === cwd || cwd.startsWith(`${target}${sep}`)) {
    throw new Error('Refusing to replace the working directory, its parent, or the filesystem root')
  }
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function validateDemoQuery(value, enabledCities, path, errors) {
  if (value === null) return
  const query = expectObject(value, path, errors)
  if (!query) return
  rejectUnknownKeys(
    query,
    new Set(['city', 'routeName', 'stopName', 'stopUid', 'routeUid', 'direction']),
    path,
    errors,
  )
  cityCode(query.city, `${path}.city`, errors)
  if (typeof query.city === 'string' && !enabledCities.includes(query.city)) {
    errors.push(`${path}.city must be included in enabledCities`)
  }
  nonEmptyString(query.routeName, `${path}.routeName`, errors, 40)
  for (const key of ['stopName', 'stopUid', 'routeUid']) {
    nonEmptyString(query[key], `${path}.${key}`, errors, 160)
  }
  if (query.direction !== 0 && query.direction !== 1) {
    errors.push(`${path}.direction must be 0 or 1`)
  }
}

function cityArray(value, path, errors) {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push(`${path} must be a non-empty array`)
    return []
  }
  const cities = []
  const seen = new Set()
  value.forEach((city, index) => {
    cityCode(city, `${path}[${index}]`, errors)
    if (typeof city !== 'string' || !SUPPORTED_CITY_SET.has(city)) return
    if (seen.has(city)) errors.push(`${path} contains duplicate city ${city}`)
    seen.add(city)
    cities.push(city)
  })
  return cities
}

function cityCode(value, path, errors) {
  if (typeof value !== 'string' || !SUPPORTED_CITY_SET.has(value)) {
    errors.push(`${path} must be a supported TDX city code`)
  }
}

function canonicalOrigin(value, path, errors) {
  if (value === 'request') return
  if (typeof value !== 'string') {
    errors.push(`${path} must be "request" or an HTTPS origin`)
    return
  }
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/'
      || url.search || url.hash) {
      errors.push(`${path} must be an HTTPS origin without path, query, credentials or hash`)
    }
  } catch {
    errors.push(`${path} must be "request" or an HTTPS origin`)
  }
}

function expectObject(value, path, errors) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    errors.push(`${path} must be an object`)
    return null
  }
  return value
}

function rejectUnknownKeys(value, allowed, path, errors) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) errors.push(`${path} contains unknown property ${key}`)
  }
}

function exactNumber(value, expected, path, errors) {
  if (value !== expected) errors.push(`${path} must equal ${expected}`)
}

function booleanValue(value, path, errors) {
  if (typeof value !== 'boolean') errors.push(`${path} must be a boolean`)
}

function nonEmptyString(value, path, errors, maximumLength) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maximumLength) {
    errors.push(`${path} must be a non-empty string up to ${maximumLength} characters`)
  }
}

function stringMatching(value, pattern, path, errors) {
  if (typeof value !== 'string' || !pattern.test(value)) errors.push(`${path} has an invalid format`)
}

function nullableMatching(value, pattern, path, errors) {
  if (value === null) return
  stringMatching(value, pattern, path, errors)
}

function enumValue(value, allowed, path, errors) {
  if (!allowed.includes(value)) errors.push(`${path} must be one of ${allowed.join(', ')}`)
}

function validationError(errors) {
  return new AggregateError(errors.map((message) => new Error(message)), `Instance config validation failed:\n- ${errors.join('\n- ')}`)
}

function absoluteFrom(cwd, path) {
  return isAbsolute(path) ? path : resolve(cwd, path)
}

async function exists(path) {
  try {
    await access(path, fsConstants.F_OK)
    return true
  } catch {
    return false
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}
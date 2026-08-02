import { mkdir, open, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  INSTANCE_SCHEMA_VERSION,
  SUPPORTED_CITY_CODES,
  validateInstanceConfig,
} from './config.mjs'

const INSTANCE_ID_PATTERN = /^[a-z][a-z0-9-]{2,62}$/
const CLOUDFLARE_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/
const D1_DATABASE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const RATE_LIMIT_NAMESPACE_ID_PATTERN = /^[0-9]{1,20}$/
const PROFILES = new Set(['starter', 'managed', 'operator'])
const RESERVED_OUTPUT_DIRECTORIES = new Set(['.git', '.generated', 'node_modules'])
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

export function parseInstanceInitArguments(argv = process.argv.slice(2)) {
  const options = {
    instanceId: null,
    siteName: null,
    profile: 'starter',
    cities: [],
    defaultCity: null,
    origin: null,
    workerName: null,
    d1DatabaseName: null,
    r2BucketName: null,
    databaseId: null,
    standardNamespaceId: null,
    expensiveNamespaceId: null,
    outputPath: 'instance.json',
    force: false,
    dryRun: false,
    json: false,
    help: false,
  }
  const positional = []

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--force' || argument === '--dry-run' || argument === '--json' || argument === '--help') {
      const key = argument === '--dry-run' ? 'dryRun' : argument.slice(2)
      options[key] = true
      continue
    }

    const equalsIndex = argument.indexOf('=')
    const optionName = equalsIndex >= 0 ? argument.slice(0, equalsIndex) : argument
    let value = equalsIndex >= 0 ? argument.slice(equalsIndex + 1) : null
    if (!optionName.startsWith('--')) {
      positional.push(argument)
      continue
    }

    if (value === null) {
      value = argv[index + 1]
      if (!value || value.startsWith('--')) throw new Error(`Missing value after ${optionName}`)
      index += 1
    }
    if (!value) throw new Error(`Missing value after ${optionName}=`)

    switch (optionName) {
      case '--instance-id': options.instanceId = value; break
      case '--site-name': options.siteName = value; break
      case '--profile': options.profile = value; break
      case '--cities': options.cities.push(...splitCities(value)); break
      case '--default-city': options.defaultCity = value; break
      case '--origin': options.origin = value; break
      case '--worker-name': options.workerName = value; break
      case '--d1-name': options.d1DatabaseName = value; break
      case '--r2-name': options.r2BucketName = value; break
      case '--database-id': options.databaseId = nullIfLiteral(value); break
      case '--standard-rate-limit-id': options.standardNamespaceId = nullIfLiteral(value); break
      case '--expensive-rate-limit-id': options.expensiveNamespaceId = nullIfLiteral(value); break
      case '--output': options.outputPath = value; break
      default: throw new Error(`Unknown instance init option: ${optionName}`)
    }
  }

  if (!options.instanceId && positional.length > 0) options.instanceId = positional.shift()
  if (positional.length > 0) throw new Error(`Unexpected argument: ${positional[0]}`)
  return Object.freeze({ ...options, cities: Object.freeze([...options.cities]) })
}

export function buildInstanceManifest(options, { cwd = process.cwd() } = {}) {
  if (!options || typeof options !== 'object') throw new Error('Instance init options are required')
  const profile = stringValue(options.profile) || 'starter'
  if (!PROFILES.has(profile)) throw new Error(`Unsupported profile: ${profile}`)

  const instanceId = requiredString(options.instanceId, '--instance-id')
  if (!INSTANCE_ID_PATTERN.test(instanceId)) {
    throw new Error('--instance-id must start with a lowercase letter and contain only lowercase letters, numbers or hyphens (3-63 characters)')
  }

  const enabledCities = uniqueCities(options.cities)
  if (enabledCities.length === 0) throw new Error('--cities must include at least one supported city code')
  const defaultCity = stringValue(options.defaultCity) || enabledCities[0]
  if (!enabledCities.includes(defaultCity)) throw new Error('--default-city must be included in --cities')

  const origin = resolveOrigin(profile, options.origin)
  const resourcePrefix = instanceId.endsWith('-bus') ? instanceId.slice(0, -4) : instanceId
  const workerName = validateCloudflareName(
    stringValue(options.workerName) || instanceId,
    '--worker-name',
  )
  const d1DatabaseName = validateCloudflareName(
    stringValue(options.d1DatabaseName) || withSuffix(resourcePrefix, '-transit'),
    '--d1-name',
  )
  const r2BucketName = validateCloudflareName(
    stringValue(options.r2BucketName) || withSuffix(resourcePrefix, '-transit-shapes'),
    '--r2-name',
  )
  const databaseId = validateNullable(options.databaseId, D1_DATABASE_ID_PATTERN, '--database-id')
  const standardNamespaceId = validateNullable(
    options.standardNamespaceId,
    RATE_LIMIT_NAMESPACE_ID_PATTERN,
    '--standard-rate-limit-id',
  )
  const expensiveNamespaceId = validateNullable(
    options.expensiveNamespaceId,
    RATE_LIMIT_NAMESPACE_ID_PATTERN,
    '--expensive-rate-limit-id',
  )
  if (standardNamespaceId && standardNamespaceId === expensiveNamespaceId) {
    throw new Error('Rate-limit namespace IDs must be distinct')
  }

  const outputPath = resolveInitOutputPath(cwd, options.outputPath || 'instance.json')
  const manifest = {
    $schema: schemaReference(cwd, outputPath),
    schemaVersion: INSTANCE_SCHEMA_VERSION,
    instanceId,
    site: {
      name: stringValue(options.siteName) || titleFromInstanceId(instanceId),
      canonicalOrigin: origin,
    },
    transit: {
      enabledCities,
      defaultCity,
      demoQuery: null,
    },
    cloudflare: {
      workerName,
      workersDev: PROFILE_DEFAULTS[profile].workersDev,
      d1: {
        databaseName: d1DatabaseName,
        databaseId,
      },
      r2: {
        bucketName: r2BucketName,
      },
      rateLimits: {
        standardNamespaceId,
        expensiveNamespaceId,
      },
    },
    operations: {
      profile,
      snapshotSchedule: PROFILE_DEFAULTS[profile].snapshotSchedule,
      releaseSmoke: PROFILE_DEFAULTS[profile].releaseSmoke,
      publicProbe: PROFILE_DEFAULTS[profile].publicProbe,
      windowWatchdog: PROFILE_DEFAULTS[profile].windowWatchdog,
    },
  }

  validateGeneratedShape(manifest)
  const strictValidation = validateStrictly(manifest)
  return Object.freeze({
    manifest: deepFreeze(manifest),
    outputPath,
    displayPath: displayPath(cwd, outputPath),
    profile,
    strictValidation,
    provisioningDraft: !strictValidation.valid,
  })
}

export async function writeInstanceManifest(result, { force = false } = {}) {
  const content = `${JSON.stringify(result.manifest, null, 2)}\n`
  await mkdir(dirname(result.outputPath), { recursive: true })

  if (!force) {
    let handle
    try {
      handle = await open(result.outputPath, 'wx')
      await handle.writeFile(content, 'utf8')
    } catch (error) {
      if (error?.code === 'EEXIST') {
        throw new Error(`${result.displayPath} already exists; pass --force to replace it`)
      }
      throw error
    } finally {
      await handle?.close()
    }
    return result.outputPath
  }

  const temporary = `${result.outputPath}.tmp-${process.pid}-${Date.now()}`
  try {
    await writeFile(temporary, content, 'utf8')
    await rename(temporary, result.outputPath)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
  return result.outputPath
}

export function renderInstanceInitText(result, { written = false, dryRun = false } = {}) {
  const action = dryRun ? 'Previewed' : written ? 'Created' : 'Prepared'
  const lines = [
    `${action} Mochi Bus instance manifest: ${result.displayPath}`,
    `Profile: ${result.profile}`,
    `Cities: ${result.manifest.transit.enabledCities.join(', ')}`,
    `Cloudflare: ${result.manifest.cloudflare.workerName} / ${result.manifest.cloudflare.d1.databaseName} / ${result.manifest.cloudflare.r2.bucketName}`,
  ]
  if (result.provisioningDraft) {
    lines.push(
      'State: provisioning draft (strict operator validation is pending resource IDs)',
      `Next: npm run instance:provision-plan -- --config ${shellQuote(result.displayPath)}`,
    )
  } else {
    lines.push(
      'State: valid instance manifest',
      `Next: npm run instance:validate -- --config ${shellQuote(result.displayPath)}`,
      `Then: npm run instance:provision-plan -- --config ${shellQuote(result.displayPath)}`,
    )
  }
  if (!dryRun) lines.push('Existing files are never replaced unless --force is supplied.')
  return `${lines.join('\n')}\n`
}

export function renderInstanceInitJson(result, { written = false, dryRun = false } = {}) {
  return {
    schemaVersion: 1,
    written,
    dryRun,
    outputPath: result.displayPath,
    profile: result.profile,
    provisioningDraft: result.provisioningDraft,
    strictValidation: result.strictValidation,
    manifest: result.manifest,
  }
}

export function instanceInitUsage() {
  return `Create a deterministic Mochi Bus instance manifest.\n\nUsage:\n  npm run instance:init -- --instance-id <id> --cities <City[,City...]> [options]\n  npm run instance:init -- <id> --cities <City[,City...]> [options]\n\nOptions:\n  --profile <starter|managed|operator>  Deployment profile (default: starter)\n  --site-name <name>                   Public site name (default: title-cased instance ID)\n  --origin <request|https://host>       Canonical origin; operator requires a fixed HTTPS URL\n  --default-city <city>                Default city (default: first enabled city)\n  --worker-name <name>                 Cloudflare Worker name\n  --d1-name <name>                     D1 database name\n  --r2-name <name>                     R2 bucket name\n  --database-id <uuid|null>             Existing D1 ID, when already provisioned\n  --standard-rate-limit-id <id|null>    Standard namespace ID\n  --expensive-rate-limit-id <id|null>   Expensive namespace ID\n  --output <path>                       Manifest path inside this repository (default: instance.json)\n  --dry-run                             Print the manifest without writing it\n  --force                               Atomically replace an existing output file\n  --json                                Print a machine-readable result\n  --help                                Show this help\n\nSupported city codes:\n  ${SUPPORTED_CITY_CODES.join(', ')}\n`
}

export async function main({
  argv = process.argv.slice(2),
  cwd = process.cwd(),
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  const options = parseInstanceInitArguments(argv)
  if (options.help) {
    stdout.write(instanceInitUsage())
    return null
  }
  const result = buildInstanceManifest(options, { cwd })
  let written = false
  if (!options.dryRun) {
    await writeInstanceManifest(result, { force: options.force })
    written = true
  }

  if (options.json) {
    stdout.write(`${JSON.stringify(renderInstanceInitJson(result, { written, dryRun: options.dryRun }), null, 2)}\n`)
  } else if (options.dryRun) {
    stdout.write(`${JSON.stringify(result.manifest, null, 2)}\n`)
    stderr.write(renderInstanceInitText(result, { written, dryRun: true }))
  } else {
    stdout.write(renderInstanceInitText(result, { written }))
  }
  return result
}

function resolveOrigin(profile, value) {
  const origin = stringValue(value)
  if (!origin) {
    if (profile === 'operator') throw new Error('--origin must be a fixed HTTPS URL for operator profile')
    return 'request'
  }
  if (origin === 'request') {
    if (profile === 'operator') throw new Error('--origin=request is not allowed for operator profile')
    return origin
  }
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

function validateGeneratedShape(manifest) {
  if (manifest.operations.profile !== 'operator') {
    validateInstanceConfig(manifest, { source: 'generated instance manifest' })
    return
  }
  const draftShape = structuredClone(manifest)
  draftShape.operations.profile = 'managed'
  validateInstanceConfig(draftShape, { source: 'generated operator draft' })
}

function validateStrictly(manifest) {
  try {
    validateInstanceConfig(manifest, { source: 'generated instance manifest' })
    return Object.freeze({ valid: true, errors: Object.freeze([]) })
  } catch (error) {
    if (manifest.operations.profile !== 'operator') throw error
    const errors = String(error?.message ?? error)
      .split('\n')
      .map((line) => line.replace(/^Instance config validation failed:\s*/, '').replace(/^\s*-\s*/, '').trim())
      .filter(Boolean)
    return Object.freeze({ valid: false, errors: Object.freeze(errors) })
  }
}

function resolveInitOutputPath(cwd, value) {
  const raw = requiredString(value, '--output')
  if (isAbsolute(raw)) throw new Error('--output must be a path inside the repository')
  const root = resolve(cwd)
  const target = resolve(root, raw)
  const pathFromRoot = relative(root, target)
  if (!pathFromRoot || pathFromRoot === '..' || pathFromRoot.startsWith(`..${sep}`) || isAbsolute(pathFromRoot)) {
    throw new Error('--output must stay inside the repository and cannot replace its root')
  }
  if (extname(target).toLowerCase() !== '.json') throw new Error('--output must end in .json')
  const firstSegment = pathFromRoot.split(sep)[0]
  if (RESERVED_OUTPUT_DIRECTORIES.has(firstSegment)) {
    throw new Error(`--output cannot write inside ${firstSegment}`)
  }
  return target
}

function schemaReference(cwd, outputPath) {
  const target = resolve(cwd, 'config/instance.schema.json')
  const path = relative(dirname(outputPath), target).split(sep).join('/')
  return path.startsWith('.') ? path : `./${path}`
}

function uniqueCities(values) {
  const result = []
  for (const city of values ?? []) {
    const normalized = stringValue(city)
    if (!normalized) continue
    if (!CITY_SET.has(normalized)) throw new Error(`Unsupported city code: ${normalized}`)
    if (!result.includes(normalized)) result.push(normalized)
  }
  return result
}

function splitCities(value) {
  return value.split(',').map((city) => city.trim()).filter(Boolean)
}

function validateCloudflareName(value, optionName) {
  if (!CLOUDFLARE_NAME_PATTERN.test(value)) {
    throw new Error(`${optionName} must contain only lowercase letters, numbers or hyphens (1-63 characters)`)
  }
  return value
}

function validateNullable(value, pattern, optionName) {
  if (value === null || value === undefined || value === '') return null
  const normalized = String(value).trim()
  if (!pattern.test(normalized)) throw new Error(`${optionName} has an invalid value`)
  return normalized
}

function nullIfLiteral(value) {
  return value.trim().toLowerCase() === 'null' ? null : value.trim()
}

function withSuffix(base, suffix) {
  const maximumBaseLength = 63 - suffix.length
  const truncated = base.slice(0, maximumBaseLength).replace(/-+$/g, '') || 'instance'
  return `${truncated}${suffix}`
}

function titleFromInstanceId(instanceId) {
  return instanceId
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function displayPath(cwd, path) {
  const pathFromRoot = relative(resolve(cwd), path).split(sep).join('/')
  return pathFromRoot || '.'
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`
}

function requiredString(value, optionName) {
  const normalized = stringValue(value)
  if (!normalized) throw new Error(`${optionName} is required`)
  return normalized
}

function stringValue(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const child of Object.values(value)) deepFreeze(child)
  return value
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}

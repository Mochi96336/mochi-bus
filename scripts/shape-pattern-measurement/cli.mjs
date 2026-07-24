import { access, lstat, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import {
  ALL_CITIES, DEFAULT_CITIES, DEFAULT_FETCH_CONCURRENCY, DEFAULT_GENERATED_DIR,
  DEFAULT_RAW_DIR, DEFAULT_REPORT_DIR, DEFAULT_TOP_OUTLIERS,
} from './constants.mjs'
import { finiteNonNegative, positiveInteger } from './util.mjs'

const SECRET_FLAGS = new Set(['--client-id', '--client-secret', '--token'])
const VALUE_FLAGS = new Set([
  '--cities', '--raw-dir', '--report-dir', '--generated-dir', '--warmup', '--iterations',
  '--top-outliers', '--fetch-concurrency', '--expected-matcher-sha256', '--matcher-sha',
])
const BOOLEAN_FLAGS = new Set(['--include-intercity', '--replay', '--instrumented', '--help'])

export async function parseCli(argv, {
  requireReplayPath = true,
  cwd = process.cwd(),
  repositoryRoot = cwd,
} = {}) {
  const values = new Map()
  const booleans = new Set()
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (SECRET_FLAGS.has(token)) throw new Error(`${token} is forbidden; credentials are read only from environment or .dev.vars`)
    if (BOOLEAN_FLAGS.has(token)) {
      if (booleans.has(token)) throw new Error(`Duplicate option: ${token}`)
      booleans.add(token)
      continue
    }
    if (!VALUE_FLAGS.has(token)) throw new Error(`Unknown option: ${token}`)
    if (values.has(token)) throw new Error(`Duplicate option: ${token}`)
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`${token} requires a value`)
    values.set(token, value)
    index += 1
  }

  if (values.has('--matcher-sha') && values.has('--expected-matcher-sha256')) {
    throw new Error('Use only one of --matcher-sha or --expected-matcher-sha256')
  }
  const citiesExplicit = values.has('--cities')
  const includeIntercityExplicit = booleans.has('--include-intercity')
  const cities = (values.get('--cities') ?? DEFAULT_CITIES.join(','))
    .split(',').map((value) => value.trim()).filter(Boolean)
  if (!cities.length) throw new Error('--cities must select at least one city')
  if (new Set(cities).size !== cities.length) throw new Error('--cities must not contain duplicates')
  const unknown = cities.filter((city) => !ALL_CITIES.has(city))
  if (unknown.length) throw new Error(`Unknown city: ${unknown.join(', ')}`)

  const rawDir = resolve(cwd, values.get('--raw-dir') ?? DEFAULT_RAW_DIR)
  const reportDir = resolve(cwd, values.get('--report-dir') ?? DEFAULT_REPORT_DIR)
  const generatedRoot = resolve(cwd, values.get('--generated-dir') ?? DEFAULT_GENERATED_DIR)
  await validatePathBoundaries({ rawDir, reportDir, generatedRoot, repositoryRoot: resolve(repositoryRoot) })

  const matcherSha = values.get('--matcher-sha') ?? values.get('--expected-matcher-sha256') ?? null
  const options = {
    help: booleans.has('--help'),
    cities: [...cities],
    citiesExplicit,
    includeIntercity: includeIntercityExplicit,
    includeIntercityExplicit,
    replay: booleans.has('--replay'),
    instrumented: booleans.has('--instrumented'),
    rawDir,
    reportDir,
    generatedRoot,
    warmup: parseCount(values.get('--warmup') ?? '1', '--warmup', true),
    iterations: parseCount(values.get('--iterations') ?? '1', '--iterations', false),
    topOutliers: parseCount(values.get('--top-outliers') ?? String(DEFAULT_TOP_OUTLIERS), '--top-outliers', false),
    fetchConcurrency: parseCount(values.get('--fetch-concurrency') ?? String(DEFAULT_FETCH_CONCURRENCY), '--fetch-concurrency', false),
    expectedMatcherSha256: matcherSha?.toLowerCase() ?? null,
  }
  if (options.expectedMatcherSha256 && !/^[a-f0-9]{64}$/.test(options.expectedMatcherSha256)) {
    throw new Error('--matcher-sha must be a 64-character hexadecimal file SHA-256')
  }
  if (options.instrumented && !options.expectedMatcherSha256) {
    throw new Error('--instrumented requires --matcher-sha so source revision verification fails closed')
  }
  if (options.replay && requireReplayPath) await access(rawDir)
  return options
}

export async function validatePathBoundaries({ rawDir, reportDir, generatedRoot, repositoryRoot }) {
  const repository = resolve(repositoryRoot)
  const measurementRoot = resolve(repository, '.tdx-measurement')
  const entries = [
    ['raw', resolve(rawDir)], ['report', resolve(reportDir)], ['generated', resolve(generatedRoot)],
  ]
  const canonicalRepository = await canonicalizeFuturePath(repository)
  const canonicalMeasurementRoot = await canonicalizeFuturePath(measurementRoot)
  const canonical = new Map()
  for (const [name, value] of entries) canonical.set(name, await canonicalizeFuturePath(value))

  for (let left = 0; left < entries.length; left += 1) {
    for (let right = left + 1; right < entries.length; right += 1) {
      const [leftName] = entries[left]
      const [rightName] = entries[right]
      if (pathsOverlap(canonical.get(leftName), canonical.get(rightName))) {
        throw new Error(`${leftName} and ${rightName} directories must be pairwise disjoint`)
      }
    }
  }

  for (const [name, requested] of entries) {
    const candidate = canonical.get(name)
    const requestedInsideRepository = containsPath(repository, requested)
    const canonicalInsideRepository = containsPath(canonicalRepository, candidate)
    if (requestedInsideRepository !== canonicalInsideRepository) {
      throw new Error(`${name} directory must not cross the repository boundary through a symlink alias`)
    }

    if (requestedInsideRepository) {
      if (!strictChild(measurementRoot, requested)
        || !strictChild(canonicalMeasurementRoot, candidate)) {
        throw new Error(`${name} directory inside the repository must be a strict child of .tdx-measurement`)
      }
      continue
    }

    if (dirname(candidate) === candidate) throw new Error(`${name} directory must not be a filesystem root`)
    if (pathsOverlap(candidate, canonicalRepository)) {
      throw new Error(`${name} external directory must not contain or overlap the repository`)
    }
  }
}

export function pathsOverlap(left, right) {
  return containsPath(left, right) || containsPath(right, left)
}

function strictChild(parent, child) {
  return parent !== child && containsPath(parent, child)
}

function containsPath(ancestor, candidate) {
  const path = relative(ancestor, candidate)
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`))
}

async function canonicalizeFuturePath(target) {
  const resolved = resolve(target)
  const suffix = []
  let current = resolved
  while (true) {
    try {
      const stat = await lstat(current)
      current = stat.isSymbolicLink() ? await realpath(current) : await realpath(current)
      return resolve(current, ...suffix.reverse())
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      const parent = dirname(current)
      if (parent === current) return resolved
      suffix.push(current.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)))
      current = parent
    }
  }
}

function parseCount(raw, name, allowZero) {
  if (!/^(?:0|[1-9]\d*)$/.test(raw)) throw new RangeError(`${name} must be a canonical integer`)
  const value = Number(raw)
  finiteNonNegative(value, name)
  if (!Number.isSafeInteger(value) || (!allowZero && value === 0)) {
    throw new RangeError(`${name} must be ${allowZero ? 'a non-negative' : 'a positive'} safe integer`)
  }
  if (!allowZero) positiveInteger(value, name)
  return value
}

export const helpText = `Usage: npm run measure:shape-pattern -- [options]\n\n` +
  `  --cities Taipei,NewTaipei\n  --include-intercity\n  --raw-dir PATH\n  --report-dir PATH\n` +
  `  --generated-dir ROOT\n  --replay\n  --instrumented --matcher-sha HEX\n` +
  `  --expected-matcher-sha256 HEX (legacy alias)\n` +
  `  --warmup N\n  --iterations N\n  --top-outliers N\n  --fetch-concurrency N\n`

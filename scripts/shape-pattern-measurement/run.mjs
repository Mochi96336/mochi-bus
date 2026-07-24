#!/usr/bin/env node
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { buildCandidatePartitions } from './build-candidates.mjs'
import { helpText, parseCli } from './cli.mjs'
import { attachCleanupFailure, cleanupOnlyFailure } from './measurement-errors.mjs'
import { createMeasurementReport, publishMeasurementReport } from './report.mjs'
import {
  assertRedacted, assertReplayScope, fetchRawBundle, replayRawBundle, safeErrorRecord,
} from './tdx-source.mjs'
import { stableStringify } from './util.mjs'

const execFileAsync = promisify(execFile)
const OWNERSHIP_MARKER = '.measurement-run-owner'
const NOOP_PROGRESS = () => undefined

export async function runMeasurement(options, dependencies = {}) {
  const generatedOwnership = await createOwnedGeneratedChild(options.generatedRoot)
  const progress = dependencies.progress ?? NOOP_PROGRESS
  let primaryError = null
  let result = null
  try {
    let source = options.replay
      ? await (dependencies.replayRawBundle ?? replayRawBundle)({ rawDir: options.rawDir })
      : await (dependencies.fetchRawBundle ?? fetchRawBundle)({
          cities: options.cities,
          includeIntercity: options.includeIntercity,
          rawDir: options.rawDir,
          concurrency: options.fetchConcurrency,
          fetcher: dependencies.fetcher,
          credentials: dependencies.credentials,
          progress,
        })
    const rawManifest = source.manifest
    if (options.replay) assertReplayScope(options, rawManifest)

    let rawBundle = source.bundle
    const buildCandidates = dependencies.buildCandidatePartitions ?? buildCandidatePartitions
    const candidateBundle = buildCandidates(rawBundle)

    // The raw TDX object graph is substantially larger than the normalized matcher
    // candidates. Measurement owns the replay result and deliberately severs that
    // graph before any matcher invocation so both representations are never retained
    // for the complete multi-hour run.
    Reflect.set(source, 'bundle', null)
    rawBundle = null
    source = null
    emitProgress(progress, candidateSummary(candidateBundle))

    const repositoryMainSha = dependencies.repositoryMainSha ?? await resolveRepositoryMainSha()
    const report = await (dependencies.createMeasurementReport ?? createMeasurementReport)({
      candidateBundle,
      rawManifest,
      options: {
        ...options,
        cities: [...rawManifest.cities],
        includeIntercity: rawManifest.includeIntercity,
        generatedRunDir: generatedOwnership.child,
      },
      repositoryMainSha,
    }, { progress })
    const runDir = await (dependencies.publishMeasurementReport ?? publishMeasurementReport)(report, options.reportDir)
    result = { report, runDir, manifest: rawManifest }
  } catch (error) {
    primaryError = error
  }

  try {
    await cleanupOwnedGeneratedChild(generatedOwnership, {
      rawDir: options.rawDir,
      reportDir: options.reportDir,
    })
  } catch {
    if (primaryError) {
      primaryError = attachCleanupFailure(primaryError, {
        stage: 'generated-run-cleanup',
        temporaryPath: generatedOwnership.child,
      })
    } else {
      primaryError = cleanupOnlyFailure({
        stage: 'generated-run-cleanup',
        temporaryPath: generatedOwnership.child,
      })
    }
  }
  if (primaryError) throw primaryError
  return result
}

export async function createOwnedGeneratedChild(generatedRoot, {
  makeTemporary = mkdtemp,
  writeMarker = writeFile,
  removeDirectory = rm,
  createToken = randomUUID,
} = {}) {
  const root = resolve(generatedRoot)
  await mkdir(root, { recursive: true })
  const rootStat = await lstat(root)
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('Generated root must be a real directory')
  const child = await makeTemporary(join(root, 'run-'))
  try {
    const token = createToken()
    const marker = join(child, OWNERSHIP_MARKER)
    await writeMarker(marker, `${token}\n`, { flag: 'wx', mode: 0o600 })
    return { root, child, marker, token }
  } catch (error) {
    try {
      await removeDirectory(child, { recursive: true, force: true })
    } catch {
      throw attachCleanupFailure(error, {
        stage: 'generated-run-initialization-cleanup',
        temporaryPath: child,
      })
    }
    throw error
  }
}

export async function cleanupOwnedGeneratedChild(ownership, { rawDir, reportDir }) {
  const rootStat = await lstat(ownership.root)
  const childStat = await lstat(ownership.child)
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('Generated root changed before cleanup')
  if (!childStat.isDirectory() || childStat.isSymbolicLink()) throw new Error('Generated run child changed before cleanup')
  const resolvedRoot = await realpath(ownership.root)
  const resolvedChild = await realpath(ownership.child)
  assertStrictOwnedChild(resolvedRoot, resolvedChild)
  for (const protectedPath of [resolve(rawDir), resolve(reportDir)]) {
    if (pathsOverlap(resolvedChild, protectedPath)) throw new Error('Generated cleanup target overlaps persistent measurement data')
  }
  const markerStat = await lstat(ownership.marker)
  if (!markerStat.isFile() || markerStat.isSymbolicLink()) throw new Error('Generated run ownership marker is invalid')
  const marker = (await readFile(ownership.marker, 'utf8')).trim()
  if (marker !== ownership.token) throw new Error('Generated run ownership marker does not match this process')
  await rm(resolvedChild, { recursive: true, force: false })
}

function candidateSummary(candidateBundle) {
  const partitions = Array.isArray(candidateBundle?.partitions) ? candidateBundle.partitions : []
  const largestPartitions = [...partitions]
    .sort((left, right) =>
      (right.stats?.minSideCount ?? 0) - (left.stats?.minSideCount ?? 0)
      || (right.stats?.candidateMultiplicity ?? 0) - (left.stats?.candidateMultiplicity ?? 0)
      || left.partitionId.localeCompare(right.partitionId))
    .slice(0, 20)
    .map((partition) => ({
      partitionId: partition.partitionId,
      sourceScope: partition.sourceScope,
      city: partition.city,
      direction: partition.direction,
      patternCount: partition.stats.patternCount,
      shapeCount: partition.stats.shapeCount,
      minSideCount: partition.stats.minSideCount,
      candidateMultiplicity: partition.stats.candidateMultiplicity,
    }))
  return {
    phase: 'candidate-summary',
    partitionCount: partitions.length,
    rejectedSourceRecordCount: Array.isArray(candidateBundle?.rejected) ? candidateBundle.rejected.length : 0,
    totalPatternCount: partitions.reduce((sum, partition) => sum + partition.stats.patternCount, 0),
    totalShapeCount: partitions.reduce((sum, partition) => sum + partition.stats.shapeCount, 0),
    largestPartitions,
  }
}

function emitProgress(progress, entry) {
  try { progress(entry) } catch {
    // Progress is diagnostic-only and must not replace measurement settlement.
  }
}

function assertStrictOwnedChild(root, child) {
  const path = relative(root, child)
  if (path === '' || path === '..' || path.startsWith(`..${sep}`)) {
    throw new Error('Generated cleanup target is not a strict child of the generated root')
  }
}
function pathsOverlap(left, right) {
  return contains(left, right) || contains(right, left)
}
function contains(ancestor, candidate) {
  const path = relative(resolve(ancestor), resolve(candidate))
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`))
}
async function resolveRepositoryMainSha() {
  for (const ref of ['origin/main', 'main', 'HEAD']) {
    try {
      const { stdout } = await execFileAsync('git', ['rev-parse', '--verify', ref], { encoding: 'utf8' })
      const sha = stdout.trim()
      if (/^[a-f0-9]{40}$/.test(sha)) return sha
    } catch {
      // Missing refs are expected probes; continue to the next local revision source.
    }
  }
  throw new Error('Unable to determine repository revision')
}

function writeProgress(entry) {
  process.stdout.write(`${stableStringify(entry)}\n`)
}

async function main() {
  let options
  try {
    options = await parseCli(process.argv.slice(2))
    if (options.help) {
      process.stdout.write(helpText)
      return
    }
    const result = await runMeasurement(options, { progress: writeProgress })
    process.stdout.write(`${stableStringify({ phase: 'complete', runDir: result.runDir, runId: result.report.metadata.runId })}\n`)
  } catch (error) {
    const record = safeErrorRecord(error)
    const secrets = [process.env.TDX_CLIENT_ID, process.env.TDX_CLIENT_SECRET]
    assertRedacted(record, secrets)
    process.stderr.write(`${stableStringify(record)}\n`)
    process.exitCode = 1
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) await main()

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { performance } from 'node:perf_hooks'
import ts from 'typescript'
import { MATCHER_SOURCE, SUPPORTED_MATCHER_GIT_BLOB_SHA1 } from './constants.mjs'
import { attachCleanupFailure, boundedFailure, cleanupOnlyFailure } from './measurement-errors.mjs'
import { gitBlobSha1, sha256Hex } from './util.mjs'

const HOOK_NAME = '__MOCHI_SHAPE_PATTERN_MEASUREMENT__'

export async function loadMatcherModule({
  instrumented = false,
  expectedMatcherSha256 = null,
  matcherSourcePath = MATCHER_SOURCE,
  generatedRunDir,
  onMeasurement = () => undefined,
}) {
  if (typeof generatedRunDir !== 'string' || !generatedRunDir) throw new TypeError('generatedRunDir is required')
  const sourceVerificationStartedAt = performance.now()
  const sourcePath = resolve(matcherSourcePath)
  const source = await readFile(sourcePath, 'utf8')
  const sourceSha256 = sha256Hex(source)
  const sourceGitBlobSha1 = gitBlobSha1(source)
  if (sourceGitBlobSha1 !== SUPPORTED_MATCHER_GIT_BLOB_SHA1) {
    throw unsupportedRevision(`matcher Git blob ${sourceGitBlobSha1} is not supported`)
  }
  if (instrumented) {
    if (!expectedMatcherSha256) throw unsupportedRevision('instrumented mode requires an expected matcher SHA-256')
    if (sourceSha256 !== expectedMatcherSha256.toLowerCase()) {
      throw unsupportedRevision(`matcher SHA-256 mismatch: expected ${expectedMatcherSha256}, got ${sourceSha256}`)
    }
  }
  const sourceVerificationTimeMs = performance.now() - sourceVerificationStartedAt

  const generatedSource = instrumented ? instrumentSource(source) : source
  const transpileStartedAt = performance.now()
  const compiled = ts.transpileModule(generatedSource, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ES2022,
      sourceMap: false,
      inlineSourceMap: false,
      removeComments: false,
    },
    fileName: matcherSourcePath,
    reportDiagnostics: true,
  })
  const errors = (compiled.diagnostics ?? []).filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)
  if (errors.length) throw new Error(`Matcher transpilation failed: ${errors.map(formatDiagnostic).join('; ')}`)
  const transpileTimeMs = performance.now() - transpileStartedAt

  await mkdir(generatedRunDir, { recursive: true })
  const outputPath = resolve(generatedRunDir, `shape-pattern-matcher-${instrumented ? 'instrumented' : 'plain'}-${randomUUID()}.mjs`)
  await writeFile(outputPath, compiled.outputText, { flag: 'wx', mode: 0o600 })

  let module
  const importStartedAt = performance.now()
  try {
    module = await import(`${pathToFileURL(outputPath).href}?run=${randomUUID()}`)
  } catch (error) {
    try {
      await rm(outputPath, { force: true })
    } catch {
      throw attachCleanupFailure(error, {
        stage: 'matcher-import-temp-cleanup',
        temporaryPath: outputPath,
      })
    }
    throw error
  }
  const importTimeMs = performance.now() - importStartedAt
  if (typeof module.matchShapesToPatterns !== 'function'
    || (instrumented && typeof module.__measurementProjectionProbe !== 'function')) {
    const error = new TypeError('Compiled matcher does not expose required measurement functions')
    try {
      await rm(outputPath, { force: true })
    } catch {
      throw attachCleanupFailure(error, {
        stage: 'matcher-interface-temp-cleanup',
        temporaryPath: outputPath,
      })
    }
    throw error
  }

  let firstCollectorFailure = null
  let disposed = false
  const withObserverHook = (run) => {
    const previousHook = globalThis[HOOK_NAME]
    globalThis[HOOK_NAME] = (event, payload) => {
      try { onMeasurement(event, payload) } catch {
        firstCollectorFailure ??= { event: boundedEventType(event) }
      }
    }
    try {
      return run()
    } finally {
      if (previousHook === undefined) delete globalThis[HOOK_NAME]
      else globalThis[HOOK_NAME] = previousHook
    }
  }
  const invoke = (patterns, shapes, options = {}) => {
    if (disposed) throw new Error('Matcher module has been disposed')
    return instrumented
      ? withObserverHook(() => module.matchShapesToPatterns(patterns, shapes, options))
      : module.matchShapesToPatterns(patterns, shapes, options)
  }
  const invokeProjectionProbe = instrumented
    ? (stops, coordinates, options, { injectThrow = false } = {}) => {
        if (disposed) throw new Error('Matcher module has been disposed')
        return withObserverHook(() => module.__measurementProjectionProbe(
          stops, coordinates, options, injectThrow,
        ))
      }
    : null
  const dispose = async () => {
    if (disposed) return
    disposed = true
    await rm(outputPath, { force: true })
  }
  return {
    invoke,
    invokeProjectionProbe,
    dispose,
    takeCollectorError: () => firstCollectorFailure,
    sourceSha256,
    sourceGitBlobSha1,
    loaderTimings: { sourceVerificationTimeMs, transpileTimeMs, importTimeMs },
    outputPath,
  }
}

export async function executeMatcher(options) {
  const loaded = await loadMatcherModule({
    instrumented: options.instrumented,
    expectedMatcherSha256: options.expectedMatcherSha256,
    matcherSourcePath: options.matcherSourcePath,
    generatedRunDir: options.generatedRunDir ?? options.generatedDir,
    onMeasurement: options.onMeasurement,
  })
  let primaryError = null
  let result
  try {
    result = loaded.invoke(options.patterns, options.shapes, options.options)
    const collectorError = loaded.takeCollectorError()
    if (collectorError) throw collectorFailure(collectorError)
  } catch (error) {
    primaryError = error
  }
  try {
    await loaded.dispose()
  } catch {
    if (primaryError) throw attachCleanupFailure(primaryError, { stage: 'matcher-module-dispose', temporaryPath: loaded.outputPath })
    throw cleanupOnlyFailure({ stage: 'matcher-module-dispose', temporaryPath: loaded.outputPath })
  }
  if (primaryError) throw primaryError
  return {
    result,
    sourceSha256: loaded.sourceSha256,
    sourceGitBlobSha1: loaded.sourceGitBlobSha1,
    loaderTimings: loaded.loaderTimings,
  }
}

export function instrumentSource(source) {
  let next = source
  next = replaceExactlyOnce(next,
    'export function matchShapesToPatterns(\n',
    `${observerPrelude()}\nexport function matchShapesToPatterns(\n`,
    'top-level observer helpers')

  next = replaceExactlyOnce(next,
    `    if (duplicateShapeIds.has(shape.shapeId)) {\n      rejectedContexts.push(context)`,
    `    if (duplicateShapeIds.has(shape.shapeId)) {\n      __measure('shape-classified', { shapeId: shape.shapeId, direction: shape.direction, rawCoordinateCount: Array.isArray(shape.coordinates) ? shape.coordinates.length : 0, normalizedCoordinateCount: null, segmentCount: null, closureClassification: shape.direction === 2 ? 'open-or-invalid' : 'not-direction-2', closureGapDistanceMeters: null, accepted: false })\n      rejectedContexts.push(context)`,
    'duplicate Shape classification')

  next = replaceExactlyOnce(next,
    `    if (!shape.shapeId || !shape.routeUid || normalizedCoordinates === null) {\n      rejectedContexts.push(context)`,
    `    if (!shape.shapeId || !shape.routeUid || normalizedCoordinates === null) {\n      __measure('shape-classified', { shapeId: shape.shapeId, direction: shape.direction, rawCoordinateCount: Array.isArray(shape.coordinates) ? shape.coordinates.length : 0, normalizedCoordinateCount: null, segmentCount: null, closureClassification: shape.direction === 2 ? 'open-or-invalid' : 'not-direction-2', closureGapDistanceMeters: null, accepted: false })\n      rejectedContexts.push(context)`,
    'invalid Shape classification')

  next = replaceExactlyOnce(next,
    `      if (closure.kind === 'open') {\n        rejectedContexts.push(context)`,
    `      if (closure.kind === 'open') {\n        __measure('shape-classified', { shapeId: shape.shapeId, direction: shape.direction, rawCoordinateCount: shape.coordinates.length, normalizedCoordinateCount: normalizedCoordinates.length, segmentCount: buildSegments(normalizedCoordinates).length, closureClassification: 'open-or-invalid', closureGapDistanceMeters: closure.gapDistanceMeters, accepted: false })\n        rejectedContexts.push(context)`,
    'open Direction 2 classification')

  next = replaceExactlyOnce(next,
    `    validShapes.push({\n      ...shape,`,
    `    __measure('shape-classified', { shapeId: shape.shapeId, direction: shape.direction, rawCoordinateCount: shape.coordinates.length, normalizedCoordinateCount: normalizedCoordinates.length, segmentCount: buildSegments(normalizedCoordinates).length, closureClassification: shape.direction === 2 ? direction2ClosureKind : 'not-direction-2', closureGapDistanceMeters, accepted: true })\n    validShapes.push({\n      ...shape,`,
    'accepted Shape classification')

  next = replaceExactlyOnce(next,
    `      const geometry = scoreGeometry(pattern, shape, options)\n      if (!geometry) continue\n      pairs.push({ pattern, shape, ...geometry })`,
    `      const __pairContext = { patternId: pattern.patternId, shapeId: shape.shapeId, stopCount: pattern.normalizedStops.length, rawCoordinateCount: shape.coordinates.length, normalizedCoordinateCount: shape.normalizedCoordinates.length, segmentCount: buildSegments(shape.normalizedCoordinates).length, closureClassification: shape.direction === 2 ? shape.direction2ClosureKind : 'not-direction-2', closureGapDistanceMeters: shape.closureGapDistanceMeters }\n      __measurementPair = __pairContext\n      __measure('pair-start', __pairContext)\n      const __pairStartedAt = performance.now()\n      let geometry: Pick<ScoredPair, 'costMeters' | 'metrics'> | null\n      try { geometry = scoreGeometry(pattern, shape, options) }\n      catch (error) { __measure('pair-end', { ...__pairContext, status: 'throw', compatible: null, elapsedMs: performance.now() - __pairStartedAt }); __measurementPair = null; throw error }\n      __measure('pair-end', { ...__pairContext, status: geometry ? 'compatible' : 'incompatible', compatible: geometry !== null, elapsedMs: performance.now() - __pairStartedAt })\n      __measurementPair = null\n      if (!geometry) continue\n      pairs.push({ pattern, shape, ...geometry })`,
    'pair scoring observer')

  next = replaceExactlyOnce(next,
    `  const forward = scoreOrientation(\n    pattern,\n    shape.normalizedCoordinates,\n    options,\n    shape.closureGapDistanceMeters,\n  )\n  const reverse = scoreOrientation(\n    pattern,\n    [...shape.normalizedCoordinates].reverse(),\n    options,\n    shape.closureGapDistanceMeters,\n  )`,
    `  const forward = __measureOrientation('forward', () => scoreOrientation(\n    pattern,\n    shape.normalizedCoordinates,\n    options,\n    shape.closureGapDistanceMeters,\n  ))\n  const reverse = __measureOrientation('reverse', () => scoreOrientation(\n    pattern,\n    [...shape.normalizedCoordinates].reverse(),\n    options,\n    shape.closureGapDistanceMeters,\n  ))`,
    'orientation observer')

  next = replaceEveryRequired(next,
    `matchOrderedStopsToPolyline(pattern.normalizedStops, unwrapped, {`,
    `__measureProjection(pattern.normalizedStops, unwrapped, {`,
    2,
    'Direction 2 projection calls')
  next = replaceEveryRequired(next,
    `matchOrderedStopsToPolyline(pattern.normalizedStops, orientedCoordinates, {`,
    `__measureProjection(pattern.normalizedStops, orientedCoordinates, {`,
    1,
    'linear projection call')

  next = replaceExactlyOnce(next,
    `  if (!stops.length || !segments.length) return null`,
    `  if (!stops.length || !segments.length) { __measurementProjectionStatus = 'no-path'; return null }`,
    'initial projection no-path status')

  next = replaceExactlyOnce(next,
    `    if (current.every((frontier) => frontier.length === 0)) return null\n    previous = current`,
    `    __measure('projection-layer', { ...(__measurementPair ?? {}), orientation: __measurementOrientation, objective: options.objective, layer: stopIndex, frontierWidth: current.reduce((maximum, frontier) => Math.max(maximum, frontier.length), 0), retainedNodes: current.reduce((sum, frontier) => sum + frontier.length, 0), parentNodeCount: current.flat().filter((node) => node.parent !== null).length, pathKeyChars: current.flat().reduce((sum, node) => sum + node.pathKey.length, 0) })\n    if (current.every((frontier) => frontier.length === 0)) { __measurementProjectionStatus = 'frontier-empty'; return null }\n    previous = current`,
    'projection layer observer')

  next = replaceExactlyOnce(next,
    `  if (!finalNodes.length) return null`,
    `  if (!finalNodes.length) { __measurementProjectionStatus = 'threshold-rejected'; return null }`,
    'projection threshold status')

  next = replaceExactlyOnce(next,
    `  return {\n    projections: selected,\n    distanceSumMeters: best.distanceSumMeters,\n    maxDistanceMeters: best.maxDistanceMeters,\n  }\n}\n\nfunction initialProjectionNode(`,
    `  return {\n    projections: selected,\n    distanceSumMeters: best.distanceSumMeters,\n    maxDistanceMeters: best.maxDistanceMeters,\n  }\n}\n\nexport function __measurementProjectionProbe(\n  stops: ShapePatternStop[],\n  coordinates: ShapePosition[],\n  options: { objective: ProjectionObjective; maxSpanMeters: number | null; maxMeanStopDistanceMeters: number; maxStopDistanceMeters: number },\n  injectThrow = false,\n): ProjectionPath | null {\n  const previousPair = __measurementPair\n  const previousInjectedThrow = __measurementProjectionInjectedThrow\n  __measurementPair = { patternId: 'measurement-probe-pattern', shapeId: 'measurement-probe-shape' }\n  __measurementProjectionInjectedThrow = injectThrow\n  try {\n    return __measureOrientation('forward', () => __measureProjection<ProjectionPath | null>(stops, coordinates, options))\n  } finally {\n    __measurementProjectionInjectedThrow = previousInjectedThrow\n    __measurementPair = previousPair\n  }\n}\n\nfunction initialProjectionNode(`,
    'projection lifecycle probe')

  next = replaceExactlyOnce(next,
    `  const best = solveAssignment(matrix)`,
    `  const best = __measureAssignment('best', () => solveAssignment(matrix))`,
    'best assignment observer')
  next = replaceExactlyOnce(next,
    `      const solution = solveWithForcedMatch(matrix, patternIndex, shapeIndex)`,
    `      const solution = __measureAssignment('forced-match', () => solveWithForcedMatch(matrix, patternIndex, shapeIndex))`,
    'forced match observer')
  next = replaceExactlyOnce(next,
    `    const unmatchedSolution = solveWithForcedUnmatched(matrix, patternIndex)`,
    `    const unmatchedSolution = __measureAssignment('forced-unmatched', () => solveWithForcedUnmatched(matrix, patternIndex))`,
    'forced unmatched observer')
  next = replaceExactlyOnce(next,
    `    states = next\n  }`,
    `    states = next\n    __measure('assignment-state', { kind: __measurementAssignmentKind, activeMaskCount: states.size })\n  }`,
    'assignment state observer')
  return next
}

function observerPrelude() {
  return `let __measurementPair: Record<string, unknown> | null = null
let __measurementOrientation: 'forward' | 'reverse' | null = null
let __measurementProjectionStatus: 'no-path' | 'frontier-empty' | 'threshold-rejected' | 'success' | 'throw' = 'no-path'
let __measurementProjectionInjectedThrow = false
let __measurementAssignmentKind: string | null = null
const __measure = (event: string, payload: Record<string, unknown> = {}): void => {
  try { const hook = globalThis.${HOOK_NAME}; if (typeof hook === 'function') hook(event, payload) } catch { /* Observer failures must not change matcher semantics. */ }
}
const __measureOrientation = <T>(orientation: 'forward' | 'reverse', run: () => T): T => {
  const startedAt = performance.now()
  const previous = __measurementOrientation
  __measurementOrientation = orientation
  __measure('orientation-start', { ...(__measurementPair ?? {}), orientation })
  let status = 'throw'
  try { const value = run(); status = value === null ? 'no-path' : 'success'; return value }
  finally { __measure('orientation-end', { ...(__measurementPair ?? {}), orientation, status, elapsedMs: performance.now() - startedAt }); __measurementOrientation = previous }
}
const __measureProjection = <T>(stops: ShapePatternStop[], coordinates: ShapePosition[], options: { objective: ProjectionObjective; maxSpanMeters: number | null; maxMeanStopDistanceMeters: number; maxStopDistanceMeters: number }): T => {
  const startedAt = performance.now()
  const segmentCount = buildSegments(coordinates).length
  __measurementProjectionStatus = 'no-path'
  __measure('projection-start', { ...(__measurementPair ?? {}), orientation: __measurementOrientation, objective: options.objective, stopCount: stops.length, segmentCount, candidateCount: stops.length * segmentCount })
  try {
    if (__measurementProjectionInjectedThrow) throw new Error('Injected projection measurement failure')
    const value = matchOrderedStopsToPolyline(stops, coordinates, options) as T
    if (value !== null) __measurementProjectionStatus = 'success'
    return value
  } catch (error) {
    __measurementProjectionStatus = 'throw'
    throw error
  } finally {
    __measure('projection-end', { ...(__measurementPair ?? {}), orientation: __measurementOrientation, objective: options.objective, status: __measurementProjectionStatus, elapsedMs: performance.now() - startedAt })
  }
}
const __measureAssignment = <T>(kind: string, run: () => T): T => {
  const startedAt = performance.now()
  const previous = __measurementAssignmentKind
  __measurementAssignmentKind = kind
  __measure('assignment-solve-start', { kind })
  let status = 'throw'
  try { const value = run(); status = 'success'; return value }
  finally { __measure('assignment-solve-end', { kind, status, elapsedMs: performance.now() - startedAt }); __measurementAssignmentKind = previous }
}`
}

function replaceExactlyOnce(source, anchor, replacement, label) {
  const count = source.split(anchor).length - 1
  if (count !== 1) throw unsupportedRevision(`${label} anchor mismatch: expected 1, found ${count}`)
  return source.replace(anchor, replacement)
}

function replaceEveryRequired(source, anchor, replacement, expectedCount, label) {
  const count = source.split(anchor).length - 1
  if (count !== expectedCount) throw unsupportedRevision(`${label} anchor mismatch: expected ${expectedCount}, found ${count}`)
  return source.split(anchor).join(replacement)
}

function unsupportedRevision(message) {
  const error = new Error(`Unsupported matcher revision: ${message}`)
  error.code = 'UNSUPPORTED_MATCHER_REVISION'
  return error
}

export function collectorFailure(_error, context = {}) {
  return boundedFailure('Measurement collector failed.', {
    code: 'MEASUREMENT_COLLECTOR_ERROR',
    stage: 'observer-callback',
    details: context?.event ? { failureClass: boundedEventType(context.event) } : null,
  })
}

function boundedEventType(value) {
  if (typeof value !== 'string') return 'unknown-event'
  return value.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 80) || 'unknown-event'
}

function formatDiagnostic(diagnostic) { return ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n') }

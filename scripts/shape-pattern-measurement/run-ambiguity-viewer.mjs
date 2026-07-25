#!/usr/bin/env node
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildAmbiguityViewerData,
  publishAmbiguityViewer,
} from './ambiguity-viewer.mjs'
import {
  buildAmbiguityCandidateNameIndex,
  enrichAmbiguityViewerCandidateNames,
} from './ambiguity-viewer-names.mjs'
import {
  assertRedacted,
  replayRawBundle,
  safeErrorRecord,
} from './tdx-source.mjs'
import { stableStringify } from './util.mjs'

function parseCli(args) {
  const values = {}
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index]
    const value = args[index + 1]
    if (!name.startsWith('--') || value === undefined || value.startsWith('--')) {
      throw new Error(`Invalid ambiguity viewer argument: ${name}`)
    }
    values[name] = value
    index += 1
  }
  const rawDir = values['--raw-dir']
  const outputDir = values['--output-dir']
  if (!nonEmptyText(rawDir) || !nonEmptyText(outputDir)) {
    throw new Error('Ambiguity viewer requires --raw-dir and --output-dir')
  }
  return {
    rawDir,
    outputDir,
    limits: {
      maxPartitions: optionalInteger(values['--max-partitions']),
      maxPatternsPerPartition: optionalInteger(values['--max-patterns']),
      maxShapesPerPartition: optionalInteger(values['--max-shapes']),
      maxStopsPerPattern: optionalInteger(values['--max-stops']),
      maxCoordinatesPerShape: optionalInteger(values['--max-coordinates']),
    },
  }
}

function optionalInteger(value) {
  if (value === undefined) return undefined
  if (!/^[1-9]\d*$/.test(value)) throw new Error('Ambiguity viewer limits must be positive integers')
  return Number(value)
}

function nonEmptyText(value) {
  return typeof value === 'string' && value.trim().length > 0
}

async function main() {
  try {
    const options = parseCli(process.argv.slice(2))
    let source = await replayRawBundle({ rawDir: options.rawDir })
    const candidateNames = buildAmbiguityCandidateNameIndex(source.bundle)
    const report = enrichAmbiguityViewerCandidateNames(
      buildAmbiguityViewerData(source.bundle, {
        ...source.manifest,
        sourceCommit: process.env.GITHUB_SHA,
      }, Object.fromEntries(Object.entries(options.limits).filter(([, value]) => value !== undefined))),
      candidateNames,
    )
    Reflect.set(source, 'bundle', null)
    source = null
    const outputDir = await publishAmbiguityViewer(report, options.outputDir)
    process.stdout.write(`${stableStringify({
      phase: 'complete',
      outputDir,
      riskyPartitionCount: report.summary.riskyPartitionCount,
      includedPartitionCount: report.summary.includedPartitionCount,
      omittedPartitionCount: report.summary.omittedPartitionCount,
    })}\n`)
  } catch (error) {
    const record = safeErrorRecord(error)
    assertRedacted(record, [process.env.TDX_CLIENT_ID, process.env.TDX_CLIENT_SECRET])
    process.stderr.write(`${stableStringify(record)}\n`)
    process.exitCode = 1
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) await main()

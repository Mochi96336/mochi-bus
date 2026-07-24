#!/usr/bin/env node
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { helpText, parseCli } from './cli.mjs'
import {
  assertRedacted, fetchRawBundle, safeErrorRecord,
} from './tdx-source.mjs'
import { stableStringify } from './util.mjs'

function writeProgress(entry) {
  process.stdout.write(`${stableStringify(entry)}\n`)
}

export async function acquireRawCache(options, dependencies = {}) {
  const source = await (dependencies.fetchRawBundle ?? fetchRawBundle)({
    cities: options.cities,
    includeIntercity: options.includeIntercity,
    rawDir: options.rawDir,
    concurrency: options.fetchConcurrency,
    fetcher: dependencies.fetcher,
    credentials: dependencies.credentials,
    progress: dependencies.progress ?? (() => undefined),
  })
  const manifest = source.manifest
  Reflect.set(source, 'bundle', null)
  return manifest
}

async function main() {
  try {
    const options = await parseCli(process.argv.slice(2), { requireReplayPath: false })
    if (options.help) {
      process.stdout.write(helpText)
      return
    }
    const manifest = await acquireRawCache(options, { progress: writeProgress })
    writeProgress({
      phase: 'acquisition-complete',
      fetchedAt: manifest.fetchedAt,
      endpointCount: manifest.endpoints.length,
      bundleContentHash: manifest.bundleContentHash,
      selectedCities: manifest.cities,
      includeIntercity: manifest.includeIntercity,
    })
  } catch (error) {
    const record = safeErrorRecord(error)
    const secrets = [process.env.TDX_CLIENT_ID, process.env.TDX_CLIENT_SECRET]
    assertRedacted(record, secrets)
    process.stderr.write(`${stableStringify(record)}\n`)
    process.exitCode = 1
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) await main()

#!/usr/bin/env node
import { resolve } from 'node:path'
import { readPublishedReport } from './report.mjs'
import { stableStringify } from './util.mjs'

const runDirectory = process.argv[2]
if (!runDirectory || process.argv.length !== 3) {
  process.stderr.write('Usage: npm run verify:shape-pattern-report -- PATH_TO_RUN_DIRECTORY\n')
  process.exitCode = 1
} else {
  try {
    const report = await readPublishedReport(resolve(runDirectory))
    process.stdout.write(`${stableStringify({
      phase: 'verified',
      runId: report.metadata.runId,
      mode: report.metadata.mode,
      matcherSourceSha256: report.metadata.matcherSourceSha256,
      matcherSourceGitBlobSha1: report.metadata.matcherSourceGitBlobSha1,
      bundleContentHash: report.metadata.provenance.bundleContentHash,
      selectedCities: report.metadata.provenance.selectedCities,
      includeIntercity: report.metadata.provenance.includeIntercity,
      deterministicContentHash: report.metadata.deterministicContentHash,
    })}\n`)
  } catch {
    process.stderr.write(`${stableStringify({ phase: 'verification-failed', failureClass: 'invalid-published-report' })}\n`)
    process.exitCode = 1
  }
}

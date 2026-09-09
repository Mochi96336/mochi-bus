import { pathToFileURL } from 'node:url'
import {
  loadOperationalResources,
  resolveOperationalOrigin,
} from '../instance/operational-resources.mjs'
import { createReleaseSmokeFetch } from './fetch-policy.mjs'
import { main as runPostDeploySmoke } from './run-post-deploy.mjs'

export async function main(env = process.env) {
  const resources = loadOperationalResources({ env })
  const origin = resolveOperationalOrigin(
    resources,
    env.RELEASE_SMOKE_ORIGIN,
    'RELEASE_SMOKE_ORIGIN',
  )
  const originalFetch = globalThis.fetch
  globalThis.fetch = createReleaseSmokeFetch({ fetchImpl: originalFetch })
  try {
    await runPostDeploySmoke({ ...env, RELEASE_SMOKE_ORIGIN: origin })
  } finally {
    globalThis.fetch = originalFetch
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()

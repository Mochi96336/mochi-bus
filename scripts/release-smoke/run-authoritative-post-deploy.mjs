import { pathToFileURL } from 'node:url'
import {
  loadOperationalResources,
  resolveOperationalOrigin,
} from '../instance/operational-resources.mjs'
import { main as runPostDeploySmoke } from './run-post-deploy.mjs'

export async function main(env = process.env) {
  const resources = loadOperationalResources({ env })
  const origin = resolveOperationalOrigin(
    resources,
    env.RELEASE_SMOKE_ORIGIN,
    'RELEASE_SMOKE_ORIGIN',
  )
  await runPostDeploySmoke({ ...env, RELEASE_SMOKE_ORIGIN: origin })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()

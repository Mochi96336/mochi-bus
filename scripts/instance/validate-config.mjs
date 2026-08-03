import { pathToFileURL } from 'node:url'
import { loadInstanceConfig, resolveInstanceConfigPath } from './config.mjs'

export async function main({ argv = process.argv.slice(2), env = process.env, cwd = process.cwd() } = {}) {
  const configPath = await resolveInstanceConfigPath({ argv, env, cwd })
  const config = await loadInstanceConfig(configPath)
  console.log(JSON.stringify({
    message: 'instance_config_valid',
    configPath,
    instanceId: config.instanceId,
    profile: config.operations.profile,
    enabledCities: config.transit.enabledCities,
  }))
  return config
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}

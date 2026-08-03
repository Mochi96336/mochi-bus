import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  DEFAULT_OUTPUT_DIRECTORY,
  compileInstanceConfig,
  loadInstanceConfig,
  parseCliArguments,
  resolveInstanceConfigPath,
  writeCompiledInstance,
} from './config.mjs'

export async function main({ argv = process.argv.slice(2), env = process.env, cwd = process.cwd() } = {}) {
  const parsed = parseCliArguments(argv)
  const configPath = await resolveInstanceConfigPath({ argv, env, cwd })
  const config = await loadInstanceConfig(configPath)
  const outputDirectory = resolve(cwd, parsed.outputDirectory ?? DEFAULT_OUTPUT_DIRECTORY)
  const result = await writeCompiledInstance(compileInstanceConfig(config), outputDirectory)
  console.log(JSON.stringify({
    message: 'instance_config_compiled',
    configPath,
    outputDirectory: result.outputDirectory,
    files: result.files,
  }))
  return result
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}

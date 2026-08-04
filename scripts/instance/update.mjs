import { randomUUID } from 'node:crypto'
import { lstat, open, readFile, rename, rm } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import {
  buildInstanceUpdate,
  instanceUpdateUsage,
  parseInstanceUpdateArguments,
  renderInstanceUpdateJson,
  renderInstanceUpdateText,
} from './update-core.mjs'

export {
  buildInstanceUpdate,
  instanceUpdateUsage,
  parseInstanceUpdateArguments,
  renderInstanceUpdateJson,
  renderInstanceUpdateText,
}

export async function writeInstanceUpdate(result) {
  if (!result.changed) return false
  const lockPath = `${result.configPath}.update.lock`
  const temporary = `${result.configPath}.tmp-${process.pid}-${randomUUID()}`
  const replacement = serializeManifest(result.manifest, result.format)
  let lockHandle = null
  let handle = null
  let ownsLock = false

  try {
    try {
      lockHandle = await open(lockPath, 'wx', 0o600)
      ownsLock = true
    } catch (error) {
      if (error?.code === 'EEXIST') {
        throw new Error('Instance manifest update lock already exists')
      }
      throw error
    }
    await lockHandle.writeFile(`${JSON.stringify({ pid: process.pid })}\n`, 'utf8')
    await lockHandle.sync()

    await assertSourceUnchanged(result)
    handle = await open(temporary, 'wx', result.sourceIdentity.mode)
    await handle.writeFile(replacement, 'utf8')
    await handle.chmod(result.sourceIdentity.mode)
    await handle.sync()
    await handle.close()
    handle = null

    await assertSourceUnchanged(result)
    await rename(temporary, result.configPath)
    await verifyWrittenManifest(result, replacement)
    return true
  } catch (error) {
    if (handle) await handle.close().catch(() => {})
    await rm(temporary, { force: true }).catch(() => {})
    throw error
  } finally {
    await lockHandle?.close().catch(() => {})
    if (ownsLock) await rm(lockPath, { force: true }).catch(() => {})
  }
}

export async function main({
  argv = process.argv.slice(2),
  cwd = process.cwd(),
  env = process.env,
  stdout = process.stdout,
} = {}) {
  const options = parseInstanceUpdateArguments(argv)
  if (options.help) {
    stdout.write(instanceUpdateUsage())
    return null
  }
  const result = await buildInstanceUpdate(options, { cwd, env })
  const written = options.write ? await writeInstanceUpdate(result) : false
  if (options.json) {
    stdout.write(`${JSON.stringify(renderInstanceUpdateJson(result, { written }), null, 2)}\n`)
  } else {
    stdout.write(renderInstanceUpdateText(result, { written }))
  }
  return result
}

async function assertSourceUnchanged(result) {
  const metadata = await lstat(result.configPath)
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error('Refusing to replace a non-regular or symbolic-link instance manifest')
  }
  if (
    metadata.dev !== result.sourceIdentity.dev
    || metadata.ino !== result.sourceIdentity.ino
    || (metadata.mode & 0o7777) !== result.sourceIdentity.mode
  ) {
    throw new Error('Instance manifest changed after preview; rebuild the update before writing')
  }
  if (await readFile(result.configPath, 'utf8') !== result.source) {
    throw new Error('Instance manifest changed after preview; rebuild the update before writing')
  }
}

async function verifyWrittenManifest(result, replacement) {
  const metadata = await lstat(result.configPath)
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error('Written instance manifest is not a regular file')
  }
  if ((metadata.mode & 0o7777) !== result.sourceIdentity.mode) {
    throw new Error('Written instance manifest did not preserve its permission mode')
  }
  const source = await readFile(result.configPath, 'utf8')
  if (source !== replacement) {
    throw new Error('Written instance manifest bytes do not match the reviewed replacement')
  }
  const manifest = JSON.parse(source)
  if (manifest.instanceId !== result.manifest.instanceId) {
    throw new Error('Written instance manifest identity does not match the reviewed replacement')
  }
}

function serializeManifest(manifest, format) {
  const spacing = format.indentation || undefined
  const json = JSON.stringify(manifest, null, spacing).replaceAll('\n', format.eol)
  return `${json}${format.trailingNewline ? format.eol : ''}`
}

// Preview mode remains explicit: NO FILE WAS CHANGED.

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    process.stderr.write(`${errorMessage(error)}\n`)
    process.exitCode = 1
  })
}

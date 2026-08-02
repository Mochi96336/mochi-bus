import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { hashCanonical, parseStrictJson } from './bundle-integrity.mjs'

export async function writeVerifiedManifestReplacement({
  configPath,
  expectedSource,
  sourceIdentity,
  targetSource,
  targetManifestHash,
  expectedInstanceId,
}) {
  assertWriteInputs({
    configPath,
    expectedSource,
    sourceIdentity,
    targetSource,
    targetManifestHash,
    expectedInstanceId,
  })

  const targetManifest = parseStrictJson(targetSource)
  if (!isPlainObject(targetManifest)) throw new Error('Replacement manifest must parse to a JSON object')
  if (targetManifest.instanceId !== expectedInstanceId) {
    throw new Error(`Replacement manifest instanceId must remain ${expectedInstanceId}`)
  }
  const calculatedTargetHash = hashCanonical(targetManifest)
  if (calculatedTargetHash !== targetManifestHash) {
    throw new Error(`Replacement manifest hash mismatch: expected ${targetManifestHash}, received ${calculatedTargetHash}`)
  }
  if (targetSource === expectedSource) {
    throw new Error('Replacement manifest must differ from the current source bytes')
  }

  const lockPath = `${configPath}.apply.lock`
  const temporaryPath = `${configPath}.tmp-${process.pid}-${randomUUID()}`
  let lockHandle
  let ownsLock = false
  let temporaryHandle
  try {
    try {
      lockHandle = await open(lockPath, 'wx', 0o600)
      ownsLock = true
    } catch (error) {
      if (error?.code === 'EEXIST') {
        throw new Error(`Instance manifest apply lock already exists: ${lockPath}`)
      }
      throw error
    }
    await lockHandle.writeFile(`${JSON.stringify({ pid: process.pid, configPath, targetManifestHash })}\n`, 'utf8')
    await lockHandle.sync()

    await assertExpectedCurrentSource(configPath, expectedSource, sourceIdentity)

    temporaryHandle = await open(temporaryPath, 'wx', sourceIdentity.mode)
    await temporaryHandle.writeFile(targetSource, 'utf8')
    await temporaryHandle.chmod(sourceIdentity.mode)
    await temporaryHandle.sync()
    await temporaryHandle.close()
    temporaryHandle = null

    // Re-check after the replacement bytes are fully durable and immediately before rename.
    await assertExpectedCurrentSource(configPath, expectedSource, sourceIdentity)
    await rename(temporaryPath, configPath)

    const written = await readVerifiedReplacement(configPath, {
      targetManifestHash,
      expectedInstanceId,
      targetSource,
    })
    return Object.freeze({
      written: true,
      configPath,
      targetManifestHash,
      bytes: Buffer.byteLength(written.source, 'utf8'),
    })
  } finally {
    await temporaryHandle?.close()
    await rm(temporaryPath, { force: true })
    await lockHandle?.close()
    if (ownsLock) await rm(lockPath, { force: true })
  }
}

async function assertExpectedCurrentSource(configPath, expectedSource, sourceIdentity) {
  const metadata = await lstat(configPath)
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error('Refusing to replace a non-regular or symbolic-link instance manifest')
  }
  if (
    metadata.dev !== sourceIdentity.dev
    || metadata.ino !== sourceIdentity.ino
    || (metadata.mode & 0o777) !== sourceIdentity.mode
    || metadata.size !== Buffer.byteLength(expectedSource, 'utf8')
  ) {
    throw new Error('Instance manifest changed after review; rebuild the proposal before writing')
  }

  const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0
  let handle
  try {
    handle = await open(configPath, constants.O_RDONLY | noFollow)
    const before = await handle.stat()
    const source = await handle.readFile('utf8')
    const after = await handle.stat()
    if (
      before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.dev !== sourceIdentity.dev
      || before.ino !== sourceIdentity.ino
      || (before.mode & 0o777) !== sourceIdentity.mode
      || source !== expectedSource
      || Buffer.byteLength(source, 'utf8') !== before.size
    ) {
      throw new Error('Instance manifest changed after review; rebuild the proposal before writing')
    }
  } finally {
    await handle?.close()
  }
}

async function readVerifiedReplacement(configPath, {
  targetManifestHash,
  expectedInstanceId,
  targetSource,
}) {
  const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0
  let handle
  try {
    handle = await open(configPath, constants.O_RDONLY | noFollow)
    const metadata = await handle.stat()
    if (!metadata.isFile()) throw new Error('Written instance manifest is not a regular file')
    const source = await handle.readFile('utf8')
    if (source !== targetSource) throw new Error('Written instance manifest bytes do not match the prepared replacement')
    const manifest = parseStrictJson(source)
    if (!isPlainObject(manifest)) throw new Error('Written instance manifest must parse to a JSON object')
    if (manifest.instanceId !== expectedInstanceId) {
      throw new Error(`Written instance manifest instanceId must remain ${expectedInstanceId}`)
    }
    const writtenHash = hashCanonical(manifest)
    if (writtenHash !== targetManifestHash) {
      throw new Error(`Written instance manifest hash mismatch: expected ${targetManifestHash}, received ${writtenHash}`)
    }
    return Object.freeze({ source, manifest })
  } finally {
    await handle?.close()
  }
}

function assertWriteInputs({
  configPath,
  expectedSource,
  sourceIdentity,
  targetSource,
  targetManifestHash,
  expectedInstanceId,
}) {
  if (typeof configPath !== 'string' || !configPath) throw new Error('A resolved configPath is required')
  if (typeof expectedSource !== 'string' || !expectedSource) throw new Error('Expected source bytes are required')
  if (typeof targetSource !== 'string' || !targetSource) throw new Error('Replacement source bytes are required')
  if (!isPlainObject(sourceIdentity)) throw new Error('Source file identity is required')
  if (!Number.isInteger(sourceIdentity.dev) || !Number.isInteger(sourceIdentity.ino)) {
    throw new Error('Source file identity must include numeric device and inode values')
  }
  if (!Number.isInteger(sourceIdentity.mode)) throw new Error('Source file identity must include a numeric mode')
  if (!/^[a-f0-9]{64}$/.test(targetManifestHash ?? '')) throw new Error('A lowercase target manifest SHA-256 is required')
  if (typeof expectedInstanceId !== 'string' || !expectedInstanceId) throw new Error('Expected instanceId is required')
  if (dirname(configPath) === configPath) throw new Error('Refusing to write a filesystem root as an instance manifest')
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
}

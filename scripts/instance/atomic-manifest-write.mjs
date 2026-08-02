import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { hashCanonical, parseStrictJson } from './bundle-integrity.mjs'

export const MAX_ATOMIC_MANIFEST_BYTES = 1024 * 1024

export class ManifestReplacementError extends Error {
  constructor(message, {
    writeState = 'not_written',
    configPath = null,
    lockPath = null,
    targetManifestHash = null,
    cleanupErrors = [],
    cause = null,
  } = {}) {
    super(message, cause ? { cause } : undefined)
    this.name = 'ManifestReplacementError'
    this.writeState = writeState
    this.configPath = configPath
    this.lockPath = lockPath
    this.targetManifestHash = targetManifestHash
    this.cleanupErrors = Object.freeze([...cleanupErrors])
  }
}

export async function writeVerifiedManifestReplacement({
  configPath,
  expectedSource,
  sourceIdentity,
  targetSource,
  targetManifestHash,
  expectedInstanceId,
}, {
  afterRename = null,
  remove = rm,
} = {}) {
  const lockPath = typeof configPath === 'string' && configPath ? `${configPath}.apply.lock` : null
  const temporaryPath = typeof configPath === 'string' && configPath
    ? `${configPath}.tmp-${process.pid}-${randomUUID()}`
    : null
  let lockHandle
  let ownsLock = false
  let temporaryHandle
  let renamed = false
  let verified = false
  let result = null
  let operationError = null

  try {
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
    const replacementIdentity = identityFromMetadata(await temporaryHandle.stat())
    await temporaryHandle.close()
    temporaryHandle = null

    // Re-check after the replacement bytes are fully durable and immediately before rename.
    await assertExpectedCurrentSource(configPath, expectedSource, sourceIdentity)
    await rename(temporaryPath, configPath)
    renamed = true
    if (typeof afterRename === 'function') {
      await afterRename({ configPath, lockPath, targetManifestHash })
    }

    const written = await readVerifiedReplacement(configPath, {
      targetManifestHash,
      expectedInstanceId,
      targetSource,
      replacementIdentity,
    })
    verified = true
    result = Object.freeze({
      written: true,
      verified: true,
      writeState: 'written_verified',
      configPath,
      targetManifestHash,
      bytes: Buffer.byteLength(written.source, 'utf8'),
    })
  } catch (error) {
    operationError = error
  }

  const cleanupErrors = []
  await captureCleanup(cleanupErrors, 'close temporary file', async () => temporaryHandle?.close())
  if (temporaryPath) {
    await captureCleanup(cleanupErrors, 'remove temporary file', async () => remove(temporaryPath, { force: true }))
  }
  await captureCleanup(cleanupErrors, 'close apply lock', async () => lockHandle?.close())
  const preserveLock = renamed && !verified
  if (ownsLock && lockPath && !preserveLock) {
    await captureCleanup(cleanupErrors, 'remove apply lock', async () => remove(lockPath, { force: true }))
  }

  if (operationError || cleanupErrors.length > 0) {
    const writeState = verified
      ? 'written_verified_cleanup_failed'
      : renamed
        ? 'written_unverified'
        : 'not_written'
    const details = [errorMessage(operationError), ...cleanupErrors].filter(Boolean)
    throw new ManifestReplacementError(details.join('; ') || 'Instance manifest replacement failed', {
      writeState,
      configPath,
      lockPath,
      targetManifestHash,
      cleanupErrors,
      cause: operationError,
    })
  }

  return result
}

async function assertExpectedCurrentSource(configPath, expectedSource, sourceIdentity) {
  const expectedBytes = Buffer.byteLength(expectedSource, 'utf8')
  const pathBefore = await lstat(configPath)
  assertRegularManifestPath(pathBefore)
  if (!sameIdentity(pathBefore, sourceIdentity) || pathBefore.size !== expectedBytes) {
    throw new Error('Instance manifest changed after review; rebuild the proposal before writing')
  }

  const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0
  let handle
  try {
    handle = await open(configPath, constants.O_RDONLY | noFollow)
    const handleBefore = await handle.stat()
    assertRegularManifestPath(handleBefore)
    assertBoundedExpectedSize(handleBefore, expectedBytes, 'Current instance manifest')
    if (!sameIdentity(handleBefore, sourceIdentity) || !sameIdentity(pathBefore, handleBefore)) {
      throw new Error('Instance manifest changed after review; rebuild the proposal before writing')
    }

    const source = await readBoundedUtf8(handle, expectedBytes, 'Current instance manifest')
    const handleAfter = await handle.stat()
    const pathAfter = await lstat(configPath)
    assertRegularManifestPath(pathAfter)
    if (
      !sameIdentity(handleBefore, handleAfter)
      || !sameIdentity(handleAfter, pathAfter)
      || !sameIdentity(pathAfter, sourceIdentity)
      || handleBefore.size !== handleAfter.size
      || handleAfter.size !== pathAfter.size
      || source !== expectedSource
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
  replacementIdentity,
}) {
  const expectedBytes = Buffer.byteLength(targetSource, 'utf8')
  const pathBefore = await lstat(configPath)
  assertRegularManifestPath(pathBefore, 'Written instance manifest')
  assertBoundedExpectedSize(pathBefore, expectedBytes, 'Written instance manifest')
  if (!sameIdentity(pathBefore, replacementIdentity)) {
    throw new Error('Written instance manifest path no longer points to the prepared replacement')
  }

  const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0
  let handle
  try {
    handle = await open(configPath, constants.O_RDONLY | noFollow)
    const handleBefore = await handle.stat()
    assertRegularManifestPath(handleBefore, 'Written instance manifest')
    assertBoundedExpectedSize(handleBefore, expectedBytes, 'Written instance manifest')
    if (!sameIdentity(pathBefore, handleBefore) || !sameIdentity(handleBefore, replacementIdentity)) {
      throw new Error('Written instance manifest path changed before verification')
    }

    const source = await readBoundedUtf8(handle, expectedBytes, 'Written instance manifest')
    const handleAfter = await handle.stat()
    const pathAfter = await lstat(configPath)
    assertRegularManifestPath(pathAfter, 'Written instance manifest')
    if (
      !sameIdentity(handleBefore, handleAfter)
      || !sameIdentity(handleAfter, pathAfter)
      || !sameIdentity(pathAfter, replacementIdentity)
      || handleBefore.size !== handleAfter.size
      || handleAfter.size !== pathAfter.size
    ) {
      throw new Error('Written instance manifest path or content changed during verification')
    }
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

async function readBoundedUtf8(handle, expectedBytes, label) {
  const bytes = Buffer.allocUnsafe(expectedBytes + 1)
  let offset = 0
  while (offset < bytes.length) {
    const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset)
    if (bytesRead === 0) break
    offset += bytesRead
  }
  if (offset > expectedBytes) {
    throw new Error(`${label} exceeds the ${MAX_ATOMIC_MANIFEST_BYTES}-byte read limit or changed during verification`)
  }
  if (offset !== expectedBytes) {
    throw new Error(`${label} changed during verification`)
  }
  let source
  try {
    source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, offset))
  } catch {
    throw new Error(`${label} must contain valid UTF-8`)
  }
  if (Buffer.byteLength(source, 'utf8') !== offset) {
    throw new Error(`${label} UTF-8 bytes did not round-trip exactly`)
  }
  return source
}

function assertBoundedExpectedSize(metadata, expectedBytes, label) {
  if (metadata.size > MAX_ATOMIC_MANIFEST_BYTES) {
    throw new Error(`${label} exceeds the ${MAX_ATOMIC_MANIFEST_BYTES}-byte read limit`)
  }
  if (metadata.size !== expectedBytes) {
    throw new Error(`${label} changed during verification`)
  }
}

function assertRegularManifestPath(metadata, label = 'Instance manifest') {
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`${label} is not a regular file or is a symbolic link`)
  }
}

function sameIdentity(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && (left.mode & 0o777) === (right.mode & 0o777)
}

function identityFromMetadata(metadata) {
  return Object.freeze({
    dev: metadata.dev,
    ino: metadata.ino,
    mode: metadata.mode & 0o777,
    size: metadata.size,
  })
}

async function captureCleanup(errors, label, action) {
  try {
    await action()
  } catch (error) {
    errors.push(`${label}: ${errorMessage(error)}`)
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
  const expectedBytes = Buffer.byteLength(expectedSource, 'utf8')
  const targetBytes = Buffer.byteLength(targetSource, 'utf8')
  if (expectedBytes > MAX_ATOMIC_MANIFEST_BYTES || targetBytes > MAX_ATOMIC_MANIFEST_BYTES) {
    throw new Error(`Instance manifest replacement exceeds the ${MAX_ATOMIC_MANIFEST_BYTES}-byte write limit`)
  }
  if (!isPlainObject(sourceIdentity)) throw new Error('Source file identity is required')
  if (!Number.isInteger(sourceIdentity.dev) || !Number.isInteger(sourceIdentity.ino)) {
    throw new Error('Source file identity must include numeric device and inode values')
  }
  if (!Number.isInteger(sourceIdentity.mode)) throw new Error('Source file identity must include a numeric mode')
  if (!/^[a-f0-9]{64}$/.test(targetManifestHash ?? '')) throw new Error('A lowercase target manifest SHA-256 is required')
  if (typeof expectedInstanceId !== 'string' || !expectedInstanceId) throw new Error('Expected instanceId is required')
  if (dirname(configPath) === configPath) throw new Error('Refusing to write a filesystem root as an instance manifest')
}

function errorMessage(error) {
  return error instanceof Error ? error.message : error == null ? '' : String(error)
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
}

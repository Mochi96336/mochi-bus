import { createHash } from 'node:crypto'

export function sameMetrics(actual, expected) {
  return Boolean(actual && expected)
    && Object.entries(expected).every(([name, value]) => actual[name] === value)
}

export function sameArtifactManifest(actual, expected) {
  if (!Array.isArray(actual) || !Array.isArray(expected) || actual.length !== expected.length) return false
  const byKey = new Map(actual.map((artifact) => [artifact?.key, artifact]))
  return byKey.size === expected.length && expected.every((artifact) => {
    const candidate = byKey.get(artifact.key)
    return candidate?.bytes === artifact.bytes
      && candidate?.sha256 === artifact.sha256
      && candidate?.contentType === artifact.contentType
  })
}

export function criticalArtifacts(artifacts, prefix) {
  if (!Array.isArray(artifacts)) throw new Error('Remote R2 manifest has no artifact list')
  const required = [
    artifacts.find((item) => item?.key === `${prefix}network.json`),
    artifacts.find((item) => item?.key?.startsWith(`${prefix}shapes/`)),
    artifacts.find((item) => item?.key?.startsWith(`${prefix}schedules/`)),
    artifacts.find((item) => item?.key?.startsWith(`${prefix}places/`)),
    artifacts.find((item) => item?.key === `${prefix}pattern-stops-export.json`),
    artifacts.find((item) => item?.key === `${prefix}place-routing-export.json`),
    artifacts.find((item) => item?.key === `${prefix}transfer-routing-export.json`),
    artifacts.find((item) => item?.key === `${prefix}stop-lookup-export.json`),
  ]
  if (required.some((artifact) => !artifact)) {
    throw new Error('Remote R2 manifest is missing a critical artifact class')
  }
  return required
}

export function assertArtifactIntegrity(artifact, body) {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  if (bytes.byteLength !== artifact?.bytes || sha256 !== artifact?.sha256) {
    throw new Error(`Remote R2 artifact integrity mismatch: ${artifact?.key ?? 'unknown'}`)
  }
}

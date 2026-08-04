import { createHash } from 'node:crypto'

export const INSTANCE_BUNDLE_ARTIFACT_KIND = 'mochi-bus-instance-change-bundle'
export const INSTANCE_BUNDLE_ARTIFACT_SCHEMA_VERSION = 1
export const MAX_INSTANCE_BUNDLE_BYTES = 8 * 1024 * 1024

const SHA256_PATTERN = /^[a-f0-9]{64}$/
const BUNDLE_KEYS = Object.freeze([
  'schemaVersion',
  'nonDestructive',
  'deterministic',
  'changed',
  'cutoverReady',
  'provisioningDraft',
  'risk',
  'instance',
  'consistency',
  'proposal',
  'migrationPlan',
  'provisioningPlan',
  'doctor',
  'hashes',
  'expectedHash',
])
const HASH_KEYS = Object.freeze([
  'algorithm',
  'sourceManifestHash',
  'baselineManifestHash',
  'targetManifestHash',
  'proposalHash',
  'migrationPlanHash',
  'provisioningPlanHash',
  'doctorHash',
  'bundleHash',
])

export function createInstanceBundleArtifact(bundle, evidence) {
  if (!isPlainObject(bundle)) throw new Error('A change bundle object is required')
  if (!isPlainObject(evidence)) throw new Error('Bundle evidence is required')
  if (typeof evidence.sourceManifest !== 'string') throw new Error('Bundle evidence must include exact sourceManifest bytes')
  if (!isPlainObject(evidence.baselineManifest)) throw new Error('Bundle evidence must include baselineManifest')

  const normalizedBundle = structuredClone(bundle)
  normalizedBundle.expectedHash = null
  const payload = {
    artifactSchemaVersion: INSTANCE_BUNDLE_ARTIFACT_SCHEMA_VERSION,
    kind: INSTANCE_BUNDLE_ARTIFACT_KIND,
    bundle: normalizedBundle,
    evidence: {
      sourceManifest: evidence.sourceManifest,
      baselineManifest: structuredClone(evidence.baselineManifest),
    },
  }
  const artifact = {
    ...payload,
    integrity: {
      algorithm: 'sha256',
      artifactHash: hashCanonical(payload),
    },
  }
  const report = verifyInstanceBundleArtifact(artifact)
  if (!report.ok) {
    throw new Error(`Cannot create an invalid change-bundle artifact: ${report.errors.join('; ')}`)
  }
  return deepFreeze(artifact)
}

export function verifyInstanceBundleArtifact(artifact) {
  const checks = []
  const errors = []
  const check = (id, ok, detail) => {
    checks.push({ id, ok, detail })
    if (!ok) errors.push(`${id}: ${detail}`)
  }

  check('artifact-object', isPlainObject(artifact), 'artifact root must be a JSON object')
  if (!isPlainObject(artifact)) return report(checks, errors, null, null)

  check(
    'artifact-keys',
    hasExactKeys(artifact, ['artifactSchemaVersion', 'kind', 'bundle', 'evidence', 'integrity']),
    'artifact root contains unexpected or missing properties',
  )
  check(
    'artifact-schema',
    artifact.artifactSchemaVersion === INSTANCE_BUNDLE_ARTIFACT_SCHEMA_VERSION,
    `artifactSchemaVersion must be ${INSTANCE_BUNDLE_ARTIFACT_SCHEMA_VERSION}`,
  )
  check(
    'artifact-kind',
    artifact.kind === INSTANCE_BUNDLE_ARTIFACT_KIND,
    `kind must be ${INSTANCE_BUNDLE_ARTIFACT_KIND}`,
  )

  const bundle = artifact.bundle
  const evidence = artifact.evidence
  const integrity = artifact.integrity
  check('bundle-object', isPlainObject(bundle), 'bundle must be an object')
  check('evidence-object', isPlainObject(evidence), 'evidence must be an object')
  check('integrity-object', isPlainObject(integrity), 'integrity must be an object')
  if (!isPlainObject(bundle) || !isPlainObject(evidence) || !isPlainObject(integrity)) {
    return report(checks, errors, null, null)
  }

  check('bundle-keys', hasExactKeys(bundle, BUNDLE_KEYS), 'bundle contains unexpected or missing top-level properties')
  check('bundle-schema', bundle.schemaVersion === 1, 'bundle schemaVersion must be 1')
  check('bundle-safety', bundle.nonDestructive === true && bundle.deterministic === true, 'bundle safety flags must both be true')
  check('bundle-expected-hash', bundle.expectedHash === null, 'persisted artifacts must not embed a command-specific expectedHash result')
  check(
    'evidence-keys',
    hasExactKeys(evidence, ['sourceManifest', 'baselineManifest']),
    'evidence contains unexpected or missing properties',
  )
  check('source-evidence', typeof evidence.sourceManifest === 'string', 'sourceManifest must be a string')
  check('baseline-evidence', isPlainObject(evidence.baselineManifest), 'baselineManifest must be an object')
  check(
    'integrity-keys',
    hasExactKeys(integrity, ['algorithm', 'artifactHash']),
    'integrity contains unexpected or missing properties',
  )
  check('integrity-algorithm', integrity.algorithm === 'sha256', 'artifact integrity algorithm must be sha256')
  check('artifact-hash-shape', validHash(integrity.artifactHash), 'artifactHash must be a lowercase SHA-256 digest')

  const hashes = bundle.hashes
  check('hashes-object', isPlainObject(hashes), 'bundle.hashes must be an object')
  if (!isPlainObject(hashes)) return report(checks, errors, integrity.artifactHash ?? null, null)
  check('hash-keys', hasExactKeys(hashes, HASH_KEYS), 'bundle.hashes contains unexpected or missing properties')
  check('hash-algorithm', hashes.algorithm === 'sha256', 'bundle hash algorithm must be sha256')
  for (const key of HASH_KEYS.slice(1)) {
    check(`hash-shape-${key}`, validHash(hashes[key]), `${key} must be a lowercase SHA-256 digest`)
  }

  const proposal = bundle.proposal
  const instance = bundle.instance
  const consistency = bundle.consistency
  const migrationPlan = bundle.migrationPlan
  check('proposal-object', isPlainObject(proposal), 'bundle.proposal must be an object')
  check('instance-object', isPlainObject(instance), 'bundle.instance must be an object')
  check('consistency-object', isPlainObject(consistency), 'bundle.consistency must be an object')
  check('migration-object', isPlainObject(migrationPlan), 'bundle.migrationPlan must be an object')
  if (![proposal, instance, consistency, migrationPlan].every(isPlainObject)) {
    return report(checks, errors, integrity.artifactHash ?? null, hashes.bundleHash ?? null)
  }

  check('target-manifest', isPlainObject(proposal.manifest), 'proposal.manifest must be an object')
  check('changes-array', Array.isArray(proposal.changes), 'proposal.changes must be an array')
  check('warnings-array', Array.isArray(proposal.warnings), 'proposal.warnings must be an array')
  check('strict-validation', isPlainObject(proposal.strictValidation), 'proposal.strictValidation must be an object')
  if (!isPlainObject(proposal.manifest) || !Array.isArray(proposal.changes) || !Array.isArray(proposal.warnings) || !isPlainObject(proposal.strictValidation)) {
    return report(checks, errors, integrity.artifactHash ?? null, hashes.bundleHash ?? null)
  }

  let parsedSourceManifest = null
  try {
    parsedSourceManifest = parseStrictJson(evidence.sourceManifest)
    check('source-manifest-json', isPlainObject(parsedSourceManifest), 'sourceManifest must parse to a JSON object')
  } catch (error) {
    check('source-manifest-json', false, error instanceof Error ? error.message : String(error))
  }
  check(
    'source-baseline-consistency',
    isPlainObject(parsedSourceManifest)
      && canonicalStringify(parsedSourceManifest) === canonicalStringify(evidence.baselineManifest),
    'parsed source manifest does not match baselineManifest evidence',
  )

  const sourceManifestHash = sha256(evidence.sourceManifest)
  const baselineManifestHash = hashCanonical(evidence.baselineManifest)
  const targetManifestHash = hashCanonical(proposal.manifest)
  const proposalFingerprint = hashCanonical({
    configPath: instance.configPath,
    instanceId: proposal.manifest.instanceId,
    fromProfile: evidence.baselineManifest?.operations?.profile,
    toProfile: proposal.manifest?.operations?.profile,
    changes: proposal.changes,
    warnings: proposal.warnings,
  })
  const migrationFingerprint = hashCanonical({
    configPath: migrationPlan?.instance?.configPath,
    instanceId: migrationPlan?.instance?.id,
    fromProfile: migrationPlan?.instance?.fromProfile,
    toProfile: migrationPlan?.instance?.toProfile,
    changes: migrationPlan?.proposal?.changes,
    warnings: migrationPlan?.proposal?.warnings,
  })
  const proposalHash = hashCanonical({
    configPath: instance.configPath,
    changed: proposal.changed,
    changes: proposal.changes,
    warnings: proposal.warnings,
    strictValidation: proposal.strictValidation,
    sourceManifestHash,
    baselineManifestHash,
    targetManifestHash,
    proposalFingerprint,
  })
  const migrationPlanHash = hashCanonical(migrationPlan)
  const provisioningPlanHash = hashCanonical(bundle.provisioningPlan)
  const doctorHash = hashCanonical(bundle.doctor)
  const bundleHash = hashCanonical({
    schemaVersion: 1,
    sourceManifestHash,
    baselineManifestHash,
    targetManifestHash,
    proposalHash,
    migrationPlanHash,
    provisioningPlanHash,
    doctorHash,
  })
  const artifactHash = hashCanonical({
    artifactSchemaVersion: artifact.artifactSchemaVersion,
    kind: artifact.kind,
    bundle,
    evidence,
  })

  check('source-manifest-hash', hashes.sourceManifestHash === sourceManifestHash, 'exact source manifest bytes do not match sourceManifestHash')
  check('baseline-manifest-hash', hashes.baselineManifestHash === baselineManifestHash, 'baseline manifest does not match baselineManifestHash')
  check('target-manifest-hash', hashes.targetManifestHash === targetManifestHash, 'target manifest does not match targetManifestHash')
  check('proposal-fingerprint', consistency.proposalFingerprint === proposalFingerprint, 'stored proposal fingerprint does not match artifact evidence')
  check('migration-fingerprint', migrationFingerprint === proposalFingerprint, 'migration plan does not describe the same canonical proposal')
  check('proposal-consistency', consistency.sameProposal === true, 'sameProposal must be true')
  check('proposal-hash', hashes.proposalHash === proposalHash, 'proposal content does not match proposalHash')
  check('migration-plan-hash', hashes.migrationPlanHash === migrationPlanHash, 'migration plan does not match migrationPlanHash')
  check('provisioning-plan-hash', hashes.provisioningPlanHash === provisioningPlanHash, 'provisioning plan does not match provisioningPlanHash')
  check('doctor-hash', hashes.doctorHash === doctorHash, 'doctor projection does not match doctorHash')
  check('bundle-hash', hashes.bundleHash === bundleHash, 'bundle review hashes do not match bundleHash')
  check('artifact-hash', integrity.artifactHash === artifactHash, 'artifact payload does not match artifactHash')
  check('instance-id', instance.id === proposal.manifest.instanceId && instance.id === evidence.baselineManifest.instanceId, 'baseline, target and bundle instance IDs must match')
  check('profile-from', instance.fromProfile === evidence.baselineManifest?.operations?.profile, 'fromProfile does not match baseline manifest')
  check('profile-to', instance.toProfile === proposal.manifest?.operations?.profile, 'toProfile does not match target manifest')
  check('changed-flag', proposal.changed === (proposal.changes.length > 0) && bundle.changed === proposal.changed, 'changed flags do not match proposal changes')

  return report(checks, errors, artifactHash, bundleHash)
}

export function parseStrictJson(source, { maxDepth = 128 } = {}) {
  if (typeof source !== 'string') throw new Error('JSON source must be a string')
  const scanner = new JsonDuplicateKeyScanner(source, maxDepth)
  scanner.parse()
  return JSON.parse(source)
}

export function hashCanonical(value) {
  return sha256(canonicalStringify(value))
}

export function sha256(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex')
}

export function canonicalStringify(value) {
  return JSON.stringify(canonicalize(value))
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (!value || typeof value !== 'object') return value
  const result = {}
  for (const key of Object.keys(value).sort()) {
    if (value[key] !== undefined) result[key] = canonicalize(value[key])
  }
  return result
}

function report(checks, errors, artifactHash, bundleHash) {
  return deepFreeze({
    schemaVersion: 1,
    ok: errors.length === 0,
    artifactHash,
    bundleHash,
    summary: {
      passed: checks.filter((item) => item.ok).length,
      failed: checks.filter((item) => !item.ok).length,
      total: checks.length,
    },
    checks,
    errors,
  })
}

function hasExactKeys(value, expected) {
  if (!isPlainObject(value)) return false
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index])
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
}

function validHash(value) {
  return typeof value === 'string' && SHA256_PATTERN.test(value)
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const child of Object.values(value)) deepFreeze(child)
  return value
}

class JsonDuplicateKeyScanner {
  constructor(source, maxDepth) {
    this.source = source
    this.maxDepth = maxDepth
    this.index = 0
  }

  parse() {
    this.skipWhitespace()
    this.parseValue(0)
    this.skipWhitespace()
    if (this.index !== this.source.length) this.fail('Unexpected trailing JSON content')
  }

  parseValue(depth) {
    if (depth > this.maxDepth) this.fail(`JSON nesting exceeds ${this.maxDepth}`)
    this.skipWhitespace()
    const char = this.source[this.index]
    if (char === '{') return this.parseObject(depth + 1)
    if (char === '[') return this.parseArray(depth + 1)
    if (char === '"') return this.readString()
    if (char === '-' || isDigit(char)) return this.readNumber()
    if (this.source.startsWith('true', this.index)) return this.consumeLiteral('true')
    if (this.source.startsWith('false', this.index)) return this.consumeLiteral('false')
    if (this.source.startsWith('null', this.index)) return this.consumeLiteral('null')
    this.fail('Invalid JSON value')
  }

  parseObject(depth) {
    this.index += 1
    this.skipWhitespace()
    const keys = new Set()
    if (this.source[this.index] === '}') {
      this.index += 1
      return
    }
    while (this.index < this.source.length) {
      this.skipWhitespace()
      if (this.source[this.index] !== '"') this.fail('Object keys must be JSON strings')
      const key = this.readString()
      if (keys.has(key)) this.fail(`Duplicate JSON object key: ${JSON.stringify(key)}`)
      keys.add(key)
      this.skipWhitespace()
      this.expect(':')
      this.parseValue(depth)
      this.skipWhitespace()
      const separator = this.source[this.index]
      if (separator === '}') {
        this.index += 1
        return
      }
      this.expect(',')
    }
    this.fail('Unterminated JSON object')
  }

  parseArray(depth) {
    this.index += 1
    this.skipWhitespace()
    if (this.source[this.index] === ']') {
      this.index += 1
      return
    }
    while (this.index < this.source.length) {
      this.parseValue(depth)
      this.skipWhitespace()
      const separator = this.source[this.index]
      if (separator === ']') {
        this.index += 1
        return
      }
      this.expect(',')
    }
    this.fail('Unterminated JSON array')
  }

  readString() {
    const start = this.index
    this.index += 1
    while (this.index < this.source.length) {
      const char = this.source[this.index]
      if (char === '"') {
        this.index += 1
        const token = this.source.slice(start, this.index)
        try {
          return JSON.parse(token)
        } catch {
          this.fail('Invalid JSON string escape')
        }
      }
      if (char === '\\') {
        this.index += 2
        continue
      }
      if (char.charCodeAt(0) < 0x20) this.fail('Unescaped control character in JSON string')
      this.index += 1
    }
    this.fail('Unterminated JSON string')
  }

  readNumber() {
    const remaining = this.source.slice(this.index)
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(remaining)
    if (!match) this.fail('Invalid JSON number')
    this.index += match[0].length
  }

  consumeLiteral(literal) {
    this.index += literal.length
  }

  expect(char) {
    if (this.source[this.index] !== char) this.fail(`Expected ${JSON.stringify(char)}`)
    this.index += 1
  }

  skipWhitespace() {
    while (/\s/.test(this.source[this.index] ?? '')) this.index += 1
  }

  fail(message) {
    throw new Error(`${message} at byte ${Buffer.byteLength(this.source.slice(0, this.index), 'utf8')}`)
  }
}

function isDigit(char) {
  return typeof char === 'string' && char >= '0' && char <= '9'
}

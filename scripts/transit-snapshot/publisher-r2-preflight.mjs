import { readFile } from 'node:fs/promises'

const REQUIRED_R2_CREDENTIALS = Object.freeze([
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'CLOUDFLARE_ACCOUNT_ID',
])

export function resolvePublisherR2Credentials({
  env = {},
  snapshotVars = {},
  workerVars = {},
} = {}) {
  const credentials = Object.fromEntries(REQUIRED_R2_CREDENTIALS.map((name) => [
    name,
    env[name] ?? snapshotVars[name] ?? workerVars[name],
  ]))
  const missing = REQUIRED_R2_CREDENTIALS.filter((name) => !nonEmpty(credentials[name]))
  const usesLegacyWorkerVars = REQUIRED_R2_CREDENTIALS.some((name) =>
    nonEmpty(credentials[name])
    && env[name] === undefined
    && snapshotVars[name] === undefined
    && nonEmpty(workerVars[name]))

  return Object.freeze({
    credentials: Object.freeze({ ...credentials }),
    missing: Object.freeze(missing),
    usesLegacyWorkerVars,
  })
}

export async function assertPublisherR2Credentials({
  env = process.env,
  readVars = readPublisherVars,
  warn = (message) => console.warn(message),
} = {}) {
  const [snapshotVars, workerVars] = await Promise.all([
    readVars('.snapshot.env'),
    readVars('.dev.vars'),
  ])
  const resolved = resolvePublisherR2Credentials({ env, snapshotVars, workerVars })

  if (resolved.usesLegacyWorkerVars) {
    warn('Snapshot publisher credentials in .dev.vars are deprecated; move them to .snapshot.env.')
  }
  if (resolved.missing.length > 0) {
    throw new Error(
      `Snapshot publisher requires direct R2 credentials before TDX access: ${resolved.missing.join(', ')}`,
    )
  }
  return resolved.credentials
}

export async function readPublisherVars(file) {
  let content
  try {
    content = await readFile(file, 'utf8')
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return {}
    throw error
  }
  return Object.fromEntries(content
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      const index = line.indexOf('=')
      return [line.slice(0, index).trim(), line.slice(index + 1).trim().replace(/^['"]|['"]$/g, '')]
    }))
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0
}

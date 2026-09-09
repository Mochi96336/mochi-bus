import { pathToFileURL } from 'node:url'
import { readBoundedResponseJson } from './active-probe.mjs'
import { resolvePublicProbeBaseUrl } from './public-probe-origin.mjs'

const FULL_SHA = /^[a-f0-9]{40}$/
const RELEASE_RESPONSE_LIMIT_BYTES = 16 * 1024
// Deploys are serialized and each completed Worker release observes production
// for ten minutes before the next queued deploy can start. Twelve minutes lets
// a push probe survive one existing observation window plus the next Worker
// deployment while still leaving ample room inside the workflow's 20-minute cap
// for the ~3-minute nationwide probe itself.
export const PUBLIC_RELEASE_WAIT_TIMEOUT_MS = 12 * 60 * 1000
export const PUBLIC_RELEASE_WAIT_POLL_MS = 5 * 1000

export async function waitForPublicRelease({
  baseUrl,
  expectedSha,
  fetchImpl = fetch,
  now = () => Date.now(),
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  timeoutMs = PUBLIC_RELEASE_WAIT_TIMEOUT_MS,
  pollMs = PUBLIC_RELEASE_WAIT_POLL_MS,
}) {
  if (!FULL_SHA.test(expectedSha ?? '')) throw new Error('Expected release SHA must be a full lowercase Git SHA')
  const origin = new URL(baseUrl)
  if ((origin.protocol !== 'https:' && origin.protocol !== 'http:')
    || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/') {
    throw new Error('Public release origin must be an absolute HTTP origin')
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new Error('Invalid public release timeout')
  if (!Number.isFinite(pollMs) || pollMs <= 0) throw new Error('Invalid public release poll interval')

  const startedAt = now()
  let lastObservedSha = null
  for (;;) {
    try {
      const response = await fetchImpl(new URL('/api/v1/health/release', origin), {
        headers: { 'Cache-Control': 'no-cache' },
        cache: 'no-store',
        signal: AbortSignal.timeout(20_000),
      })
      if (response.ok) {
        const release = await readBoundedResponseJson(response, RELEASE_RESPONSE_LIMIT_BYTES)
        lastObservedSha = FULL_SHA.test(release?.releaseSha ?? '') ? release.releaseSha : null
        if (release?.schemaVersion === 1 && lastObservedSha === expectedSha) {
          return Object.freeze({
            releaseSha: expectedSha,
            workerVersionId: safeIdentifier(release.workerVersionId),
            workerCreatedAt: safeTimestamp(release.workerCreatedAt),
          })
        }
      } else {
        await response.body?.cancel().catch(() => undefined)
      }
    } catch {
      // Deployment propagation can temporarily fail DNS/TLS/HTTP. Keep polling
      // until the bounded deadline; never print raw response bodies or URLs.
    }

    const elapsed = Math.max(0, now() - startedAt)
    if (elapsed >= timeoutMs) {
      const observed = lastObservedSha ? lastObservedSha.slice(0, 12) : 'none'
      throw new Error(`Public release did not reach expected SHA; last=${observed}`)
    }
    await sleep(Math.min(pollMs, Math.max(1, timeoutMs - elapsed)))
  }
}

function safeIdentifier(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value) ? value : null
}

function safeTimestamp(value) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) return null
  return new Date(value).toISOString()
}

async function main(env = process.env) {
  const release = await waitForPublicRelease({
    baseUrl: resolvePublicProbeBaseUrl({ env }),
    expectedSha: env.EXPECTED_RELEASE_SHA,
  })
  console.log(JSON.stringify({
    message: 'public_probe_release_ready',
    releaseSha: release.releaseSha,
    workerVersionId: release.workerVersionId,
    workerCreatedAt: release.workerCreatedAt,
  }))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main().catch((error) => {
    console.error(JSON.stringify({
      message: 'public_probe_release_wait_failed',
      error: error instanceof Error ? error.message : 'unknown',
    }))
    process.exitCode = 1
  })
}

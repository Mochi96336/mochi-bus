import { instanceOrigin } from './instance-runtime'

const HSTS_MAX_AGE_SECONDS = 86_400
const CSP_REPORT_PATH = '/api/v1/csp-report'

const cspReportOnlyPolicy = [
  "default-src 'self'",
  "base-uri 'self'",
  "connect-src 'self' https://tdx.transportdata.tw",
  "font-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "frame-src 'none'",
  "img-src 'self' data: https://tile.openstreetmap.org",
  "manifest-src 'self'",
  "media-src 'none'",
  "object-src 'none'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "worker-src 'self'",
  `report-uri ${CSP_REPORT_PATH}`,
  'report-to csp',
].join('; ')

const defaultSecurityHeaders = {
  'Content-Security-Policy': "base-uri 'self'; frame-ancestors 'none'; object-src 'none'",
  'Content-Security-Policy-Report-Only': cspReportOnlyPolicy,
  'Permissions-Policy': 'camera=(), geolocation=(self), microphone=(), payment=(), usb=()',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
} as const

function isLocalDevelopmentHost(hostname: string): boolean {
  return hostname === 'localhost'
    || hostname.endsWith('.localhost')
    || hostname === '127.0.0.1'
    || hostname === '0.0.0.0'
    || hostname === '[::1]'
}

export function httpsRedirectTarget(requestUrl: string): string | null {
  const url = new URL(requestUrl)
  if (url.protocol !== 'http:' || isLocalDevelopmentHost(url.hostname)) return null

  url.protocol = 'https:'
  return url.toString()
}

export function securityHeaders(
  isHttps: boolean,
  requestUrl?: string,
): Readonly<Record<string, string>> {
  const headers = {
    ...defaultSecurityHeaders,
    'Reporting-Endpoints': `csp="${new URL(CSP_REPORT_PATH, instanceOrigin(requestUrl))}"`,
  }
  if (!isHttps) return headers
  return { ...headers, 'Strict-Transport-Security': `max-age=${HSTS_MAX_AGE_SECONDS}` }
}

export type CspViolationSummary = {
  directive: string
  blocked: string
  source: string
  disposition?: 'enforce' | 'report'
  statusCode?: number
}

export function cspViolationSummaries(payload: unknown): CspViolationSummary[] {
  const reports = Array.isArray(payload) ? payload : [payload]
  return reports.slice(0, 10).flatMap((report) => {
    const outer = recordOf(report)
    const body = recordOf(outer?.['csp-report']) ?? recordOf(outer?.body)
    if (!body) return []

    const directive = directiveName(body['effective-directive'] ?? body.effectiveDirective)
    if (!directive) return []
    const disposition = body.disposition === 'enforce' || body.disposition === 'report'
      ? body.disposition
      : undefined
    const rawStatus = body['status-code'] ?? body.statusCode
    const statusCode = typeof rawStatus === 'number' && Number.isInteger(rawStatus) && rawStatus >= 100 && rawStatus <= 599
      ? rawStatus
      : undefined
    return [{
      directive,
      blocked: reportTarget(body['blocked-uri'] ?? body.blockedURL),
      source: reportTarget(body['source-file'] ?? body.sourceFile),
      ...(disposition ? { disposition } : {}),
      ...(statusCode ? { statusCode } : {}),
    }]
  })
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function directiveName(value: unknown): string | undefined {
  return typeof value === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(value) ? value : undefined
}

function reportTarget(value: unknown): string {
  if (typeof value !== 'string' || !value) return 'unknown'
  if (/^(?:inline|eval|data|blob|self)$/i.test(value.replaceAll("'", ''))) return value.slice(0, 16)
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : url.protocol
  } catch {
    return 'invalid'
  }
}

import runtimeConfig from '../.generated/instance/instance-runtime.json'

export type CanonicalOriginPolicy = 'request' | `https://${string}`

export type RuntimeInstanceConfig = Readonly<{
  schemaVersion: number
  instanceId: string
  site: Readonly<{
    name: string
    canonicalOrigin: CanonicalOriginPolicy
  }>
  transit: Readonly<{
    enabledCities: readonly string[]
    defaultCity: string
    demoQuery: unknown
  }>
  operationsProfile: 'starter' | 'managed' | 'operator'
}>

export const instanceRuntime = runtimeConfig as RuntimeInstanceConfig
export const instanceId = instanceRuntime.instanceId
export const siteName = instanceRuntime.site.name
export const canonicalOriginPolicy = instanceRuntime.site.canonicalOrigin

export function resolveCanonicalOrigin(
  policy: CanonicalOriginPolicy,
  requestUrl?: string,
): string {
  if (policy !== 'request') return new URL(policy).origin
  if (!requestUrl) throw new Error('Request URL is required when canonicalOrigin is "request"')
  return new URL(requestUrl).origin
}

export function instanceOrigin(requestUrl?: string): string {
  return resolveCanonicalOrigin(canonicalOriginPolicy, requestUrl)
}

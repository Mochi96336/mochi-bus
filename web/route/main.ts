import type { RoutePageIdentity, RoutePageIdentityStop } from '../../src/domain/route-page-identity'
import type { RouteEtaResponse, RouteEtaStop } from '../../src/domain/route-page-detail'
import { ROUTE_UNKNOWN_ETA_LABEL } from '../../src/domain/route-timeline-fallback'
import { routeRetryDecision, routeWarningRetryDecision } from '../lib/retry-policy'
import { isTdxTokenRejectedError, requestMochiJson } from '../tdx/api-client'
import { parseRouteEtaResponse, RouteContractError } from './contract'
import { readRoutePageIdentity, RouteIdentityError } from './identity'
import { createVisibleRefreshController, type VisibleRefreshResult } from './refresh-controller'

const routePage = document.querySelector<HTMLElement>('.route-page')
if (routePage) initializeRoutePage(routePage)

function initializeRoutePage(page: HTMLElement): void {
  prepareSelectedEta(page)
  fillUnknownRouteEta(page)
  try {
    const identity = readRoutePageIdentity()
    const selectedStopUid = new URLSearchParams(window.location.search).get('stopUid')
    validateTimelineIdentity(page, identity, selectedStopUid)

    const refreshController = createVisibleRefreshController({
      refresh: (signal) => refreshRouteEta(page, identity, selectedStopUid, signal),
      isVisible: () => document.visibilityState === 'visible',
    })
    document.addEventListener('visibilitychange', () => {
      void refreshController.visibilityChanged()
    })
    void refreshController.start()
  } catch {
    clearRouteEta(page)
    setSelectedStatus(page, '即時未更新')
    console.error(JSON.stringify({ message: 'route_identity_client_failed' }))
  }
}

async function refreshRouteEta(
  page: HTMLElement,
  identity: RoutePageIdentity,
  selectedStopUid: string | null,
  signal: AbortSignal,
): Promise<VisibleRefreshResult> {
  try {
    const suffix = window.location.search || ''
    const raw = await requestMochiJson<unknown>(
      '/api/v1/route-eta' + suffix,
      { cache: 'no-store', signal },
      { authenticated: true, fallback: '即時到站讀取失敗' },
    )
    const response = parseRouteEtaResponse(raw)
    applyRouteEta(page, response, identity, selectedStopUid)
    return refreshResultFor(response)
  } catch (error) {
    if (isAbortError(error)) return

    clearRouteEta(page)
    const tokenRejected = isTdxTokenRejectedError(error)
    const invariantFailure = error instanceof RouteContractError || error instanceof RouteIdentityError
    setSelectedStatus(page, tokenRejected ? '憑證失效' : '即時未更新')
    console.error(JSON.stringify({
      message: 'route_eta_client_failed',
      failureKind: tokenRejected
        ? 'token-rejected'
        : error instanceof RouteContractError
          ? 'contract'
          : error instanceof RouteIdentityError ? 'identity' : 'transient',
    }))
    if (tokenRejected || invariantFailure) return 'stop'
    const decision = routeRetryDecision(error)
    return decision.retry ? { nextDelayMs: decision.delayMs } : 'stop'
  }
}

function refreshResultFor(response: RouteEtaResponse): VisibleRefreshResult {
  if (response.eta.kind !== 'unavailable') return
  const decision = routeWarningRetryDecision(response.eta.warning)
  return decision.retry ? { nextDelayMs: decision.delayMs } : 'stop'
}

function prepareSelectedEta(page: HTMLElement): void {
  const etaNodes = page.querySelectorAll<HTMLElement>('.route-stop.selected .route-eta')
  etaNodes.forEach((etaNode) => {
    etaNode.setAttribute('aria-live', 'polite')
    etaNode.setAttribute('aria-atomic', 'true')
  })
}

function fillUnknownRouteEta(page: HTMLElement): void {
  page.querySelectorAll<HTMLElement>('.route-stop:not(.selected) .route-eta').forEach((etaNode) => {
    if (!etaNode.textContent?.trim()) etaNode.textContent = ROUTE_UNKNOWN_ETA_LABEL
  })
}

function applyRouteEta(
  page: HTMLElement,
  response: RouteEtaResponse,
  identity: RoutePageIdentity,
  selectedStopUid: string | null,
): void {
  const rows = validateTimelineIdentity(page, identity, selectedStopUid)
  if (response.stops.length !== identity.stops.length) {
    throw new RouteIdentityError('Route ETA station count does not match the server identity')
  }

  const targets = rows.map((row, index) => validateStopTarget(
    row,
    response.stops[index],
    identity.stops[index],
  ))
  targets.forEach(({ etaNode, stop }) => updateStopEta(etaNode, stop))
}

function validateTimelineIdentity(
  page: HTMLElement,
  identity: RoutePageIdentity,
  selectedStopUid: string | null,
): HTMLLIElement[] {
  const rows = Array.from(page.querySelectorAll<HTMLLIElement>('.route-stop'))
  if (rows.length !== identity.stops.length) {
    throw new RouteIdentityError('Route timeline station count does not match the server identity')
  }

  const selectedIdentity = identity.stops.find((stop) => stop.selected)
  if (!selectedIdentity || (selectedStopUid !== null && selectedIdentity.stopUid !== selectedStopUid)) {
    throw new RouteIdentityError('Route selected station does not match the server identity')
  }

  rows.forEach((row, index) => validateRenderedRow(row, identity.stops[index]))
  return rows
}

function validateRenderedRow(row: HTMLLIElement, identityStop: RoutePageIdentityStop | undefined): void {
  const nameNode = row.querySelector<HTMLElement>('strong')
  const etaNode = row.querySelector<HTMLElement>('.route-eta')
  if (!identityStop
    || !nameNode
    || !etaNode
    || nameNode.textContent?.trim() !== identityStop.stopName
    || row.classList.contains('selected') !== identityStop.selected) {
    throw new RouteIdentityError('Route DOM does not match the server identity')
  }
}

function validateStopTarget(
  row: HTMLLIElement,
  stop: RouteEtaStop | undefined,
  identityStop: RoutePageIdentityStop | undefined,
): { etaNode: HTMLElement; stop: RouteEtaStop } {
  const etaNode = row.querySelector<HTMLElement>('.route-eta')
  if (!stop
    || !identityStop
    || !etaNode
    || stop.stopUid !== identityStop.stopUid
    || stop.stopName !== identityStop.stopName
    || stop.sequence !== identityStop.sequence) {
    throw new RouteIdentityError('Route ETA response does not match the server identity')
  }
  return { etaNode, stop }
}

function updateStopEta(etaNode: HTMLElement, stop: RouteEtaStop): void {
  etaNode.classList.remove('live', 'urgent', 'muted')
  etaNode.classList.add(stop.etaTone)
  // 每 20 秒刷新一次,多數站牌的值根本沒變。所選站牌是 aria-live 節點,
  // 無條件重寫 textContent 會讓螢幕閱讀器每 20 秒把同一句再唸一遍。
  // 這跟首頁 eta-row-view 的 signature 檢查是同一條規則:值沒變就不重播。
  const label = stop.etaLabel ?? ROUTE_UNKNOWN_ETA_LABEL
  if (etaNode.textContent === label) return
  etaNode.textContent = label
}

function clearRouteEta(page: HTMLElement): void {
  page.querySelectorAll<HTMLElement>('.route-stop .route-eta').forEach((etaNode) => {
    const selected = etaNode.closest('.route-stop')?.classList.contains('selected') ?? false
    etaNode.textContent = selected ? '' : ROUTE_UNKNOWN_ETA_LABEL
    etaNode.classList.remove('live', 'urgent', 'muted')
    etaNode.classList.add('muted')
  })
}

function setSelectedStatus(page: HTMLElement, label: string): void {
  page.querySelectorAll<HTMLElement>('.route-stop.selected .route-eta').forEach((etaNode) => {
    etaNode.textContent = label
    etaNode.classList.remove('live', 'urgent')
    etaNode.classList.add('muted')
  })
}

function isAbortError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'name' in error
    && (error as { name?: unknown }).name === 'AbortError'
}

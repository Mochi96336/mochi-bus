import { formatJourneyWait } from '../../src/domain/eta-presentation'
import { describeTransferEstimate } from '../../src/domain/map/transfer-estimate'
import { tdxWarningMessages } from '../../src/domain/tdx-warning'
import type { DirectRoute, NearbyPlace, TransferPlan } from './map-api-client'
import type { DrawerView } from './drawer-view'
import type { TripResultsState } from './trip-state'

type TripResultsViewOptions = {
  renderDrawer: (view: DrawerView) => void
  createBackButton: (label: string, onClick: () => void) => HTMLButtonElement
  createHeading: (title: string, description: string) => HTMLElement
  createDegradedNotice: (message: string, onRetry: () => void, credentialRecovery?: boolean) => HTMLElement
  createTripModeButton: () => HTMLButtonElement
  createMatchedControls: (compact?: boolean) => HTMLElement | undefined
  routeColor: (routeName: string) => string
  transferLegColors: (firstRouteName: string, secondRouteName: string) => readonly [string, string]
  onResumeDestination: () => void
  onRetry: () => void
  onSelectDirect: (index: number) => void
  onSelectTransfer: (index: number) => void
  onOpenRoute: (routeName: string, variantKey: string | null | undefined, color: string) => void
  now?: () => Date
}

export type TripPlanErrorView = {
  context: { from: NearbyPlace; to: NearbyPlace }
  message: string
  credentialRecovery: boolean
}

export type TripResultsView = {
  render(state: TripResultsState): void
  renderError(view: TripPlanErrorView): void
}

export function createTripResultsView(options: TripResultsViewOptions): TripResultsView {
  const now = options.now ?? (() => new Date())

  function warningContent(state: TripResultsState): HTMLElement[] {
    return state.warning
      ? [options.createDegradedNotice(tdxWarningMessages[state.warning], options.onRetry)]
      : []
  }

  function renderDirect(state: Extract<TripResultsState, { resultKind: 'direct' }>): void {
    const directRoutes = state.directRoutes
    const selectedIndex = state.selectedDirectIndex
    const list = document.createElement('div')
    list.className = 'direct-route-list'
    if (!directRoutes.length) list.appendChild(paragraph('目前沒有找到直達車。'))

    directRoutes.forEach((route, index) => {
      const color = options.routeColor(route.routeName)
      const selected = index === selectedIndex
      const card = document.createElement('section')
      card.className = 'direct-route-card'
      card.classList.toggle('selected', selected)
      card.style.setProperty('--route-color', color)

      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'direct-route-select'
      button.setAttribute('aria-pressed', String(selected))
      button.setAttribute('aria-label', `${selected ? '目前預覽：' : '選擇：'}${route.routeName} ${route.label}`)

      const top = document.createElement('span')
      const name = document.createElement('strong')
      name.textContent = route.routeName
      const count = document.createElement('span')
      count.textContent = directRouteSummary(route, now())
      top.appendChild(name)
      top.appendChild(count)

      const detail = document.createElement('small')
      detail.textContent = route.label
      button.appendChild(top)
      button.appendChild(detail)
      button.addEventListener('click', () => options.onSelectDirect(index))

      const detailButton = document.createElement('button')
      detailButton.type = 'button'
      detailButton.className = 'direct-route-detail'
      detailButton.textContent = '完整路線 ›'
      detailButton.setAttribute('aria-label', `查看 ${route.routeName} 完整路線`)
      detailButton.addEventListener('click', (event) => {
        event.stopPropagation()
        options.onOpenRoute(route.routeName, route.variantKey, color)
      })

      card.appendChild(button)
      card.appendChild(detailButton)
      list.appendChild(card)
    })

    const matchedControls = options.createMatchedControls(true)
    options.renderDrawer({
      key: `trip-results:${state.from.place.placeId}:${state.to.place.placeId}`,
      mode: 'results',
      header: [
        options.createBackButton('重新選目的地', options.onResumeDestination),
        options.createHeading(
          `${state.from.place.name} → ${state.to.place.name}`,
          directRoutes.length ? `${directRoutes.length} 個直達方向，淡色線為候選路線。` : '沒有直達路線',
        ),
        ...(matchedControls ? [matchedControls] : []),
      ],
      content: [...warningContent(state), list],
      footer: [options.createTripModeButton()],
    })
  }

  function renderTransfer(state: Extract<TripResultsState, { resultKind: 'transfer' | 'empty' }>): void {
    const plans = state.transferPlans
    const list = document.createElement('div')
    list.className = 'transfer-plan-list'
    if (!plans.length) list.appendChild(paragraph('目前沒有找到合理的一次轉乘方案。'))

    plans.forEach((plan, index) => {
      const card = document.createElement('section')
      card.className = 'transfer-plan'
      card.classList.toggle('selected', index === state.selectedTransferIndex)
      card.tabIndex = 0
      card.addEventListener('click', () => options.onSelectTransfer(index))
      card.addEventListener('keydown', (event) => {
        if (event.target !== event.currentTarget) return
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          card.click()
        }
      })

      const title = document.createElement('div')
      title.className = 'transfer-title'
      const transfer = document.createElement('strong')
      transfer.textContent = '一次轉乘'
      const count = document.createElement('span')
      const planPresentation = transferPlanSummary(plan)
      count.textContent = planPresentation.label
      title.appendChild(transfer)
      title.appendChild(count)
      if (planPresentation.connectionTight) card.classList.add('connection-tight')
      card.appendChild(title)

      const assumption = document.createElement('small')
      assumption.className = 'transfer-assumption'
      assumption.textContent = planPresentation.note
      card.appendChild(assumption)

      const legColors = options.transferLegColors(plan.first.routeName, plan.second.routeName)
      ;[plan.first, plan.second].forEach((leg, legIndex) => {
        const color = legColors[legIndex]
        const button = document.createElement('button')
        button.className = 'transfer-leg-button'
        button.style.setProperty('--route-color', color)

        const order = document.createElement('span')
        order.textContent = legIndex === 0 ? '先搭' : '再搭'
        const routeName = document.createElement('strong')
        routeName.textContent = leg.routeName
        const stops = document.createElement('small')
        stops.textContent = transferLegSummary(plan, legIndex as 0 | 1, now())
        button.appendChild(order)
        button.appendChild(routeName)
        button.appendChild(stops)
        button.addEventListener('click', (event) => {
          event.stopPropagation()
          options.onOpenRoute(leg.routeName, leg.variantKey, color)
        })
        card.appendChild(button)

        if (legIndex === 0) {
          const connection = document.createElement('div')
          connection.className = 'transfer-connection'
          const icon = document.createElement('span')
          icon.textContent = '↳'
          icon.setAttribute('aria-hidden', 'true')
          const copy = document.createElement('strong')
          copy.textContent = `於 ${plan.transferName} 轉乘`
          const walk = document.createElement('small')
          walk.textContent = plan.transferWalkMeters ? `步行約 ${plan.transferWalkMeters} m` : '同站轉乘'
          connection.appendChild(icon)
          connection.appendChild(copy)
          connection.appendChild(walk)
          card.appendChild(connection)
        }
      })

      list.appendChild(card)
    })

    const matchedControls = options.createMatchedControls(true)
    options.renderDrawer({
      key: `trip-results:${state.from.place.placeId}:${state.to.place.placeId}`,
      mode: 'results',
      header: [
        options.createBackButton('重新選目的地', options.onResumeDestination),
        options.createHeading(
          `${state.from.place.name} → ${state.to.place.name}`,
          plans.length ? `${plans.length} 個一次轉乘方案` : '沒有直達或一次轉乘方案',
        ),
        ...(matchedControls ? [matchedControls] : []),
      ],
      content: [...warningContent(state), list],
      footer: [options.createTripModeButton()],
    })
  }

  return {
    render(state) {
      if (state.resultKind === 'direct') renderDirect(state)
      else renderTransfer(state)
    },
    renderError(view) {
      options.renderDrawer({
        key: `trip-results:${view.context.from.placeId}:${view.context.to.placeId}`,
        mode: 'compact',
        content: [
          options.createBackButton('重新選目的地', options.onResumeDestination),
          options.createHeading(
            '查詢失敗了',
            `${view.context.from.name} → ${view.context.to.name} 暫時查不到，稍等一下再試。`,
          ),
          options.createDegradedNotice(view.message, options.onRetry, view.credentialRecovery),
        ],
      })
    },
  }
}

export function directRouteSummary(route: DirectRoute, now: Date): string {
  const wait = formatJourneyWait(route.etaMinutes, route.etaSource, now, {
    departureBased: route.etaDepartureBased,
    headwayMinutes: route.etaHeadwayMinutes,
    nextDay: route.etaNextDay,
  })
  return wait ? `${wait} · ${route.stopCount} 站` : `${route.stopCount} 站`
}

export function transferPlanSummary(plan: TransferPlan): {
  label: string
  note: string
  connectionTight: boolean
} {
  const estimate = plan.transferEstimate ? describeTransferEstimate(plan.transferEstimate) : null
  return {
    label: estimate?.label ?? `共 ${plan.totalStops} 站`,
    note: estimate?.note ?? '未取得足夠資料，請以現場資訊為準',
    connectionTight: plan.transferEstimate?.connectionStatus === 'tight'
      || plan.transferEstimate?.connectionStatus === 'missed',
  }
}

export function transferLegSummary(plan: TransferPlan, legIndex: 0 | 1, now: Date): string {
  const leg = legIndex === 0 ? plan.first : plan.second
  const eta = legIndex === 0 ? plan.firstEtaMinutes : plan.secondEtaMinutes
  const etaSource = legIndex === 0 ? plan.firstEtaSource : plan.secondEtaSource
  const wait = formatJourneyWait(eta, etaSource, now, {
    departureBased: legIndex === 0 ? plan.firstEtaDepartureBased : plan.secondEtaDepartureBased,
    headwayMinutes: legIndex === 0 ? plan.firstEtaHeadwayMinutes : plan.secondEtaHeadwayMinutes,
    nextDay: legIndex === 0 ? plan.firstEtaNextDay : plan.secondEtaNextDay,
  })
  return `${wait ? `${wait} · ` : ''}${leg.stopCount} 站 · ${leg.label}`
}

function paragraph(text: string): HTMLParagraphElement {
  const node = document.createElement('p')
  node.className = 'drawer-copy'
  node.textContent = text
  return node
}

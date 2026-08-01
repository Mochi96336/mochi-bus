import type { RouteTimetable, TimetableService } from './map-api-client'
import { taipeiServiceClock, timetableMinutes } from '../../src/domain/map/service-clock'
import { attachRovingTabs } from '../lib/roving-tabs'

let timetablePanelSequence = 0

export function timetableSummaryText(timetable: RouteTimetable): string | null {
  const service = currentTimetableService(timetable)
  if (!service?.firstTime || !service.lastTime) return null
  const nextServicePrefix = !service.today && service.days.length ? `下一服務日 ${service.label} · ` : ''
  if (timetable.mode === 'frequency') {
    const headways = service.periods.flatMap((period) => [period.minHeadwayMinutes, period.maxHeadwayMinutes])
    const minimum = headways.length ? Math.min(...headways) : null
    const maximum = headways.length ? Math.max(...headways) : null
    const headway = minimum !== null && maximum !== null
      ? minimum === maximum ? `${minimum} 分一班` : `${minimum}–${maximum} 分一班`
      : ''
    return `${nextServicePrefix}營運 ${service.firstTime}–${service.lastTime}${headway ? ` · ${headway}` : ''}`
  }
  const prefix = timetable.mode === 'departure'
    ? `${timetable.departureStop?.stopName ?? '起點'}發車`
    : timetable.selectedStop?.stopName ?? ''
  return `${nextServicePrefix}${prefix}${prefix ? ' · ' : ''}首班 ${service.firstTime} · 末班 ${service.lastTime}`
}

export function renderTimetableSummary(summary: HTMLButtonElement, text: string): void {
  const parts = text.split(/(\d{2}:\d{2}(?:–\d{2}:\d{2})?|\d+(?:–\d+)?(?=\s*分))/g)
  const copy = document.createElement('span')
  parts.filter(Boolean).forEach((part) => {
    if (!/^\d/.test(part)) {
      copy.appendChild(document.createTextNode(part))
      return
    }
    const number = document.createElement('strong')
    number.textContent = part
    copy.appendChild(number)
  })
  summary.replaceChildren(copy)
}

export function createTimetablePanel(
  timetable: RouteTimetable,
  onStopChange: (stopUid: string) => void,
): HTMLElement {
  const panel = document.createElement('div')
  panel.className = 'timetable-panel'

  const timedStops = timetable.stops.filter((stop) => stop.hasTimes)
  if (timetable.mode === 'stop' && timedStops.length > 1) {
    const field = document.createElement('label')
    field.className = 'timetable-stop-field'
    const label = document.createElement('span')
    label.textContent = '站牌'
    const select = document.createElement('select')
    select.setAttribute('aria-label', '站牌')
    timedStops.forEach((stop) => {
      const option = document.createElement('option')
      option.value = stop.stopUid
      option.textContent = `${stop.sequence}. ${stop.stopName}`
      option.selected = stop.stopUid === timetable.selectedStop?.stopUid
      select.appendChild(option)
    })
    select.addEventListener('change', () => onStopChange(select.value))
    field.replaceChildren(label, select)
    panel.appendChild(field)
  }

  const content = document.createElement('div')
  content.className = 'timetable-content'
  const hasMultipleServices = timetable.services.length > 1
  const hasTodayService = timetable.services.some((service) => service.today)
  const hasKnownServiceDays = timetable.services.some((service) => service.days.length)
  // 首次渲染由 drawer 的 view 進場動畫負責(design-system:只有 view identity 改變才播放),
  // 這裡只在使用者實際換日期時補一段同樣 180ms/4px 的內容交接,避免同一次開啟播兩次。
  let servicePainted = false
  const renderService = (service: TimetableService) => {
    const fragment = timetableServiceContent(timetable, service, {
      showServiceLabel: !hasMultipleServices,
      noteNoTodayService: !hasTodayService && hasKnownServiceDays,
    })
    if (servicePainted) fragment.classList.add('drawer-content-enter')
    servicePainted = true
    content.replaceChildren(fragment)
  }
  const initialService = currentTimetableService(timetable)
  if (hasMultipleServices) {
    const tabs = document.createElement('div')
    tabs.className = 'timetable-tabs'
    tabs.setAttribute('aria-label', '服務日期')
    const buttons = timetable.services.map((service) => {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'timetable-tab'
      button.textContent = service.label
      button.setAttribute('aria-label', service.label)
      button.title = service.label
      tabs.appendChild(button)
      return button
    })
    panel.appendChild(tabs)
    panel.appendChild(content)
    const initialIndex = initialService
      ? timetable.services.findIndex((service) => service.id === initialService.id)
      : 0
    // role/aria-selected/tabIndex/aria-controls 與方向鍵一律交給共用工具,
    // 這裡只負責「選到第幾個就換成哪一天的內容」。
    attachRovingTabs({
      tablist: tabs,
      tabs: buttons,
      panel: content,
      idPrefix: `timetable-${timetablePanelSequence += 1}`,
      initialIndex: Math.max(0, initialIndex),
      onSelect: (index) => renderService(timetable.services[index]),
    })
    return panel
  }
  if (initialService) renderService(initialService)
  panel.appendChild(content)
  return panel
}

function currentTimetableService(timetable: RouteTimetable): TimetableService | undefined {
  return timetable.services.find((service) => service.today) ?? timetable.services[0]
}

type TimetableServiceContentOptions = {
  showServiceLabel: boolean
  noteNoTodayService: boolean
}

function timetableServiceContent(
  timetable: RouteTimetable,
  service: TimetableService,
  options: TimetableServiceContentOptions,
): HTMLElement {
  const fragment = document.createElement('div')
  const overview = document.createElement('div')
  overview.className = 'timetable-overview'
  const context = document.createElement('span')
  const baseContext = timetable.mode === 'stop'
    ? timetable.selectedStop?.stopName ?? '所選站牌'
    : timetable.mode === 'departure'
      ? `${timetable.departureStop?.stopName ?? '起點'}發車`
      : '班距'
  const contextParts = [baseContext]
  if (options.showServiceLabel) contextParts.push(service.label)
  if (options.noteNoTodayService) contextParts.push('今日無班次')
  context.textContent = contextParts.join(' · ')
  const range = document.createElement('strong')
  range.textContent = service.firstTime && service.lastTime
    ? `${service.firstTime}–${service.lastTime}`
    : '班次資料'
  overview.replaceChildren(context, range)
  fragment.appendChild(overview)

  if (service.times.length) fragment.appendChild(timetableHourList(service))
  if (service.periods.length) {
    const periods = document.createElement('div')
    periods.className = 'timetable-period-list'
    service.periods.forEach((period) => {
      const row = document.createElement('div')
      row.className = 'timetable-period'
      const hours = document.createElement('strong')
      hours.textContent = `${period.startTime}–${period.endTime}`
      const headway = document.createElement('span')
      headway.textContent = period.minHeadwayMinutes === period.maxHeadwayMinutes
        ? `${period.minHeadwayMinutes} 分一班`
        : `${period.minHeadwayMinutes}–${period.maxHeadwayMinutes} 分一班`
      row.replaceChildren(hours, headway)
      periods.appendChild(row)
    })
    fragment.appendChild(periods)
  }

  const note = document.createElement('p')
  note.className = 'timetable-note'
  note.textContent = timetable.mode === 'stop'
    ? '表定到站時間，實際仍可能受路況影響。'
    : timetable.mode === 'departure'
      ? '目前只提供起點發車時間，沿途到站時間會受路況影響。'
      : '此路線以班距提供服務，實際發車仍可能調整。'
  fragment.appendChild(note)
  return fragment
}

export type TimetableTimeState = 'past' | 'next' | 'future'

export function timetableTimeStates(
  service: Pick<TimetableService, 'today' | 'times'>,
  now = new Date(),
): Map<string, TimetableTimeState> {
  const nowMinutes = taipeiServiceClock(now).minutes
  const values = service.times
    .map((time) => ({ time, minutes: timetableMinutes(time) }))
    .filter((entry): entry is { time: string; minutes: number } => entry.minutes !== null)
  const next = service.today ? values.find((entry) => entry.minutes >= nowMinutes)?.time : undefined
  return new Map(values.map(({ time, minutes }) => [
    time,
    time === next ? 'next' : service.today && minutes < nowMinutes ? 'past' : 'future',
  ]))
}

function timetableHourList(service: TimetableService): HTMLElement {
  const list = document.createElement('div')
  list.className = 'timetable-hour-list'
  const grouped = new Map<string, string[]>()
  service.times.forEach((time) => {
    const [hour, minute] = time.split(':')
    const minutes = grouped.get(hour) ?? []
    minutes.push(minute)
    grouped.set(hour, minutes)
  })
  const states = timetableTimeStates(service)
  grouped.forEach((minutes, hour) => {
    const row = document.createElement('div')
    row.className = 'timetable-hour-row'
    const hourNode = document.createElement('strong')
    hourNode.textContent = hour
    const minuteList = document.createElement('div')
    minutes.forEach((minute) => {
      const value = `${hour}:${minute}`
      const chip = document.createElement('span')
      chip.className = 'timetable-minute'
      chip.textContent = minute
      const state = states.get(value) ?? 'future'
      chip.classList.add(state)
      chip.setAttribute('aria-label', `${value}，${state === 'past' ? '已過' : state === 'next' ? '下一班' : '尚未發車'}`)
      if (state === 'next') {
        chip.title = '下一班'
      }
      minuteList.appendChild(chip)
    })
    row.replaceChildren(hourNode, minuteList)
    list.appendChild(row)
  })
  return list
}

// TDX 偶爾會讓某縣市的 Schedule 整份變成 []（高雄自 2026-08 底起就是這樣），
// 但 Route/StopOfRoute/Shape 仍正常更新。若直接發布，scheduledRoutes 會暴跌被驗證擋下，
// 結果整個縣市的路網一起卡在舊版本。這裡在「整份市區時刻表都是空的」時，
// 沿用目前已發布版本的每路線時刻表 artifact，讓路網照常更新、時刻表維持上一版。
//
// 刻意收窄的範圍：
// - 只有整份為空才沿用；部分缺漏仍交給 validateSnapshot 的 40% 下降檢查。
// - 只處理本縣市 City 端點的路線；公路客運有自己的 Schedule/InterCity 來源。
// - 上一版沒有的路線就維持沒有時刻表，不憑空推估。
// - 沿用的內容會寫進新版本 artifact，下一輪可繼續沿用；TDX 一恢復就自動改用新資料。

export const SCHEDULE_CARRY_FORWARD_CONCURRENCY = 8

export function shouldCarryForwardSchedules({ cityRouteUids, cityScheduleItems }) {
  return cityRouteUids.length > 0 && cityScheduleItems.length === 0
}

export function previousScheduleArtifactKey(version, city, routeUid) {
  return `snapshots/${version}/cities/${city}/schedules/${routeUid}.json`
}

/**
 * @param {object} options
 * @param {string} options.city
 * @param {string[]} options.cityRouteUids 本縣市 City 端點的路線 UID（不含公路客運）
 * @param {string | null | undefined} options.previousVersion 目前已發布的快照版本
 * @param {(key: string) => Promise<unknown>} options.readJson 讀 R2 JSON；不存在回 null
 * @param {(items: string[], concurrency: number, worker: (item: string) => Promise<void>) => Promise<void>} options.mapParallel
 */
export async function carryForwardSchedules({
  city,
  cityRouteUids,
  previousVersion,
  readJson,
  mapParallel,
  concurrency = SCHEDULE_CARRY_FORWARD_CONCURRENCY,
}) {
  if (typeof previousVersion !== 'string' || previousVersion.length === 0) {
    return { items: [], report: carryForwardReport(city, null, cityRouteUids.length, 0, 0, 'no_previous_version') }
  }

  const uniqueRouteUids = [...new Set(cityRouteUids)]
  const itemsByRoute = new Map()
  let missingRoutes = 0
  await mapParallel(uniqueRouteUids, concurrency, async (routeUid) => {
    const previous = await readJson(previousScheduleArtifactKey(previousVersion, city, routeUid))
    const items = Array.isArray(previous)
      ? previous.filter((item) => item && typeof item === 'object' && item.RouteUID === routeUid)
      : []
    if (items.length) itemsByRoute.set(routeUid, items)
    else missingRoutes += 1
  })

  // 依輸入順序組回，讓 contentHash 在 TDX 持續為空時保持穩定，避免每輪都被當成「有變更」。
  const items = uniqueRouteUids.flatMap((routeUid) => itemsByRoute.get(routeUid) ?? [])
  return {
    items,
    report: carryForwardReport(
      city,
      previousVersion,
      uniqueRouteUids.length,
      itemsByRoute.size,
      missingRoutes,
      itemsByRoute.size ? 'carried_forward' : 'previous_empty',
    ),
  }
}

function carryForwardReport(city, previousVersion, cityRoutes, carriedRoutes, missingRoutes, outcome) {
  return {
    event: 'snapshot_schedule_carried_forward',
    city,
    outcome,
    sourceVersion: previousVersion,
    cityRoutes,
    carriedRoutes,
    missingRoutes,
  }
}

import type L from 'leaflet'

// 地圖平移範圍包含澎湖、金門、馬祖，並替抽屜鏡頭偏移保留餘裕。
// 它是操作邊界，不是全台總覽的取景框。
export const TAIWAN_PAN_BOUNDS: L.LatLngBoundsExpression = [
  [21.2, 117.7],
  [26.8, 122.4],
]

export const TAIWAN_PAN_BOUNDS_VISCOSITY = .9

type PanBoundedMap = {
  options: L.MapOptions
  setMaxBounds(bounds: L.LatLngBoundsExpression): unknown
}

export function constrainMapPanToTaiwan(map: PanBoundedMap): void {
  map.options.maxBoundsViscosity = TAIWAN_PAN_BOUNDS_VISCOSITY
  map.setMaxBounds(TAIWAN_PAN_BOUNDS)
}

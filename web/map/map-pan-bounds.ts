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
  on(type: 'dragstart' | 'moveend', listener: () => void): unknown
  off(type: 'dragstart' | 'moveend', listener: () => void): unknown
  panInsideBounds(bounds: L.LatLngBoundsExpression, options?: L.PanOptions): unknown
}

type PointerSurface = Pick<EventTarget, 'addEventListener' | 'removeEventListener'>

/**
 * Arms Leaflet maxBounds only for pointer-driven drags.
 *
 * Keeping maxBounds permanently enabled would also clamp drawer-aware setView
 * and fitBounds calls. Gesture-scoping preserves those camera offsets while
 * retaining Leaflet's viscous edge and inertia limiting during manual panning.
 */
export function constrainMapPanToTaiwan(map: PanBoundedMap, surface: PointerSurface): () => void {
  const previousBounds = map.options.maxBounds
  const previousViscosity = map.options.maxBoundsViscosity
  let armed = false
  let dragging = false
  let disposed = false

  const restoreOptions = () => {
    if (!armed) return
    armed = false
    map.options.maxBounds = previousBounds
    map.options.maxBoundsViscosity = previousViscosity
  }

  const onPointerDown: EventListener = () => {
    if (disposed || armed) return
    armed = true
    dragging = false
    map.options.maxBounds = TAIWAN_PAN_BOUNDS
    map.options.maxBoundsViscosity = TAIWAN_PAN_BOUNDS_VISCOSITY
  }

  const onPointerRelease: EventListener = () => {
    queueMicrotask(() => {
      if (!disposed && !dragging) restoreOptions()
    })
  }

  const onDragStart = () => {
    if (armed) dragging = true
  }

  const onMoveEnd = () => {
    if (!armed || !dragging) return
    dragging = false
    restoreOptions()
    map.panInsideBounds(TAIWAN_PAN_BOUNDS, { animate: true })
  }

  surface.addEventListener('pointerdown', onPointerDown, { capture: true })
  surface.addEventListener('pointerup', onPointerRelease, { capture: true })
  surface.addEventListener('pointercancel', onPointerRelease, { capture: true })
  map.on('dragstart', onDragStart)
  map.on('moveend', onMoveEnd)

  return () => {
    if (disposed) return
    disposed = true
    surface.removeEventListener('pointerdown', onPointerDown, { capture: true })
    surface.removeEventListener('pointerup', onPointerRelease, { capture: true })
    surface.removeEventListener('pointercancel', onPointerRelease, { capture: true })
    map.off('dragstart', onDragStart)
    map.off('moveend', onMoveEnd)
    restoreOptions()
  }
}

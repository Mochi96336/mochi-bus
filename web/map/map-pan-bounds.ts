import type L from 'leaflet'

// 地圖平移範圍包含澎湖、金門、馬祖，並替抽屜鏡頭偏移保留餘裕。
// 它是操作邊界，不是全台總覽的取景框。
export const TAIWAN_PAN_BOUNDS: L.LatLngBoundsExpression = [
  [21.2, 117.7],
  [26.8, 122.4],
]

export const TAIWAN_PAN_BOUNDS_VISCOSITY = .9

type MapEventName = 'dragstart' | 'moveend' | 'zoomstart' | 'zoomend'

type PanBoundedMap = {
  options: L.MapOptions
  on(type: MapEventName, listener: () => void): unknown
  off(type: MapEventName, listener: () => void): unknown
  panInsideBounds(bounds: L.LatLngBoundsExpression, options?: L.PanOptions): unknown
}

type PointerSurface = Pick<EventTarget, 'addEventListener' | 'removeEventListener'>

function defaultReleaseSurface(surface: PointerSurface): PointerSurface {
  return typeof window === 'undefined' ? surface : window
}

function pointerId(event: Event): number {
  return 'pointerId' in event && typeof event.pointerId === 'number' ? event.pointerId : 0
}

/**
 * Arms Leaflet maxBounds only for pointer-driven drags.
 *
 * Keeping maxBounds permanently enabled would also clamp drawer-aware setView
 * and fitBounds calls. Gesture-scoping preserves those camera offsets while
 * retaining Leaflet's viscous edge and inertia limiting during manual panning.
 */
export function constrainMapPanToTaiwan(
  map: PanBoundedMap,
  surface: PointerSurface,
  releaseSurface: PointerSurface = defaultReleaseSurface(surface),
): () => void {
  const previousBounds = map.options.maxBounds
  const previousViscosity = map.options.maxBoundsViscosity
  const activePointers = new Set<number>()
  let armed = false
  let dragging = false
  let zooming = false
  let reboundPending = false
  let disposed = false

  const restoreOptions = () => {
    if (!armed) return
    armed = false
    map.options.maxBounds = previousBounds
    map.options.maxBoundsViscosity = previousViscosity
  }

  const finishDrag = () => {
    if (!armed || !reboundPending) return
    dragging = false
    zooming = false
    reboundPending = false
    restoreOptions()
    map.panInsideBounds(TAIWAN_PAN_BOUNDS, { animate: true })
  }

  const finishPointerGesture = (interrupted = false) => {
    queueMicrotask(() => {
      if (disposed || activePointers.size > 0) return
      if (interrupted) {
        if (reboundPending) finishDrag()
        else restoreOptions()
        return
      }
      if (dragging || zooming) return
      if (reboundPending) {
        finishDrag()
        return
      }
      restoreOptions()
    })
  }

  const onPointerDown: EventListener = (event) => {
    if (disposed) return
    const startingGesture = activePointers.size === 0
    activePointers.add(pointerId(event))
    if (!startingGesture) {
      // Leaflet ends its one-pointer drag when another touch joins. Mark that
      // drag as handed off so a stationary two-pointer gesture can still
      // settle after release even when no pinch zoom or later moveend occurs.
      dragging = false
      return
    }

    // A new drag can synchronously stop the previous inertia before Leaflet
    // emits its new dragstart. Keep the old rebound pending, but let the new
    // gesture decide whether it becomes another drag or only a click.
    dragging = false
    if (armed) return

    armed = true
    reboundPending = false
    map.options.maxBounds = TAIWAN_PAN_BOUNDS
    map.options.maxBoundsViscosity = TAIWAN_PAN_BOUNDS_VISCOSITY
  }

  const onPointerRelease: EventListener = (event) => {
    activePointers.delete(pointerId(event))
    if (activePointers.size === 0) finishPointerGesture()
  }

  const onInterruptedGesture: EventListener = (event) => {
    if (event.type === 'blur') activePointers.clear()
    else activePointers.delete(pointerId(event))
    if (activePointers.size === 0) finishPointerGesture(true)
  }

  const onDragStart = () => {
    if (!armed) return
    dragging = true
    reboundPending = true
  }

  const onMoveEnd = () => {
    // Starting a new drag calls Leaflet _stop(), which synchronously emits the
    // previous inertia's moveend before the new dragstart. That moveend belongs
    // to the old gesture and must not disarm the constraint under the pointer.
    if (activePointers.size === 0 && !zooming) finishDrag()
  }

  const onZoomStart = () => {
    if (!armed) return
    zooming = true
  }

  const onZoomEnd = () => {
    if (!armed) return
    zooming = false
    if (activePointers.size === 0) finishDrag()
  }

  surface.addEventListener('pointerdown', onPointerDown, { capture: true })
  releaseSurface.addEventListener('pointerup', onPointerRelease, { capture: true })
  releaseSurface.addEventListener('pointercancel', onInterruptedGesture, { capture: true })
  releaseSurface.addEventListener('blur', onInterruptedGesture, { capture: true })
  map.on('dragstart', onDragStart)
  map.on('moveend', onMoveEnd)
  map.on('zoomstart', onZoomStart)
  map.on('zoomend', onZoomEnd)

  return () => {
    if (disposed) return
    disposed = true
    surface.removeEventListener('pointerdown', onPointerDown, { capture: true })
    releaseSurface.removeEventListener('pointerup', onPointerRelease, { capture: true })
    releaseSurface.removeEventListener('pointercancel', onInterruptedGesture, { capture: true })
    releaseSurface.removeEventListener('blur', onInterruptedGesture, { capture: true })
    map.off('dragstart', onDragStart)
    map.off('moveend', onMoveEnd)
    map.off('zoomstart', onZoomStart)
    map.off('zoomend', onZoomEnd)
    activePointers.clear()
    dragging = false
    zooming = false
    reboundPending = false
    restoreOptions()
  }
}

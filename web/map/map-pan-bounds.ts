import type L from 'leaflet'

// 使用者手動平移時，允許地圖中心停留的範圍。
// 包含澎湖、金門、馬祖，並替抽屜鏡頭偏移保留餘裕。
export const TAIWAN_PAN_CENTER_BOUNDS = [
  [21.2, 117.7],
  [26.8, 122.4],
] as const

export const TAIWAN_PAN_BOUNDS_VISCOSITY = .9

const KEYBOARD_PAN_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowDown', 'ArrowUp'])
const KEYBOARD_PAN_KEY_CODES = new Set([37, 38, 39, 40])
const KEYBOARD_PAN_SETTLE_DELAY_MS = 350
const FINAL_REBOUND_SETTLE_DELAY_MS = 350

type MapEventName = 'dragstart' | 'moveend' | 'zoomstart' | 'zoomend'

type PanBoundedMap = {
  options: L.MapOptions
  getSize(): L.Point
  getZoom(): number
  project(latlng: L.LatLngExpression, zoom?: number): L.Point
  unproject(point: L.PointExpression, zoom?: number): L.LatLng
  on(type: MapEventName, listener: () => void): unknown
  off(type: MapEventName, listener: () => void): unknown
  panInsideBounds(bounds: L.LatLngBoundsExpression, options?: L.PanOptions): unknown
}

type InertiaSafeBounds = L.LatLngBoundsExpression & Pick<L.LatLngBounds, 'getSouthWest' | 'getNorthEast'>
type PointerSurface = Pick<EventTarget, 'addEventListener' | 'removeEventListener'>

export type MapPanConstraintDisposer = (() => void) & {
  releaseForProgrammaticCamera(): void
}

function defaultReleaseSurface(surface: PointerSurface): PointerSurface {
  return typeof window === 'undefined' ? surface : window
}

function pointerId(event: Event): number {
  return 'pointerId' in event && typeof event.pointerId === 'number' ? event.pointerId : 0
}

function keyboardPanKey(event: Event): boolean {
  const altKey = 'altKey' in event && event.altKey === true
  const ctrlKey = 'ctrlKey' in event && event.ctrlKey === true
  const metaKey = 'metaKey' in event && event.metaKey === true
  if (altKey || ctrlKey || metaKey) return false

  const key = 'key' in event && typeof event.key === 'string' ? event.key : undefined
  if (key !== undefined && KEYBOARD_PAN_KEYS.has(key)) return true

  const keyCode = 'keyCode' in event && typeof event.keyCode === 'number' ? event.keyCode : undefined
  return keyCode !== undefined && KEYBOARD_PAN_KEY_CODES.has(keyCode)
}

/**
 * Leaflet maxBounds constrains the whole viewport, while the product boundary
 * describes where the map center may stop. Expanding the center range by half
 * of the current viewport makes those two meanings equivalent at every zoom.
 */
export function taiwanPanBoundsForViewport(
  map: Pick<PanBoundedMap, 'getSize' | 'getZoom' | 'project' | 'unproject'>,
): L.LatLngBoundsExpression {
  const [[south, west], [north, east]] = TAIWAN_PAN_CENTER_BOUNDS
  const zoom = map.getZoom()
  const halfViewport = map.getSize().divideBy(2)
  const northWest = map.unproject(
    map.project([north, west], zoom).subtract(halfViewport),
    zoom,
  )
  const southEast = map.unproject(
    map.project([south, east], zoom).add(halfViewport),
    zoom,
  )

  return [
    [southEast.lat, northWest.lng],
    [northWest.lat, southEast.lng],
  ]
}

/**
 * Leaflet accepts a bounds expression when a drag starts, but its inertia path
 * later reads getSouthWest/getNorthEast directly from map.options.maxBounds.
 * Decorate the expression with those two methods so the module stays usable in
 * Node tests without importing Leaflet's browser-only runtime.
 */
function leafletPanBoundsForViewport(
  map: Pick<PanBoundedMap, 'getSize' | 'getZoom' | 'project' | 'unproject'>,
): InertiaSafeBounds {
  const bounds = taiwanPanBoundsForViewport(map) as [[number, number], [number, number]]
  const [[south, west], [north, east]] = bounds

  return Object.assign(bounds, {
    getSouthWest: () => ({ lat: south, lng: west }) as L.LatLng,
    getNorthEast: () => ({ lat: north, lng: east }) as L.LatLng,
  })
}

/**
 * Arms Leaflet maxBounds only for user-driven pointer and keyboard panning.
 *
 * Keeping maxBounds permanently enabled would also clamp drawer-aware setView
 * and fitBounds calls. Interaction-scoping preserves those camera offsets while
 * retaining Leaflet's viscous edge and inertia limiting during manual panning.
 */
export function constrainMapPanToTaiwan(
  map: PanBoundedMap,
  surface: PointerSurface,
  releaseSurface: PointerSurface = defaultReleaseSurface(surface),
): MapPanConstraintDisposer {
  const previousBounds = map.options.maxBounds
  const previousViscosity = map.options.maxBoundsViscosity
  const wheelZoomFallbackDelay = Math.max(0, map.options.wheelDebounceTime ?? 40) + 16
  const activePointers = new Set<number>()
  let armed = false
  let dragging = false
  let zooming = false
  let wheelZoomPending = false
  let wheelZoomFallback: ReturnType<typeof setTimeout> | undefined
  let keyboardReboundPending = false
  let keyboardReboundFallback: ReturnType<typeof setTimeout> | undefined
  let settling = false
  let settleFallback: ReturnType<typeof setTimeout> | undefined
  let reboundPending = false
  let disposed = false

  const armOptions = () => {
    armed = true
    map.options.maxBounds = leafletPanBoundsForViewport(map)
    map.options.maxBoundsViscosity = TAIWAN_PAN_BOUNDS_VISCOSITY
  }

  const restoreOptions = () => {
    if (!armed) return
    armed = false
    map.options.maxBounds = previousBounds
    map.options.maxBoundsViscosity = previousViscosity
  }

  const clearWheelZoomPending = () => {
    wheelZoomPending = false
    if (wheelZoomFallback === undefined) return
    clearTimeout(wheelZoomFallback)
    wheelZoomFallback = undefined
  }

  const clearKeyboardReboundPending = () => {
    keyboardReboundPending = false
    if (keyboardReboundFallback === undefined) return
    clearTimeout(keyboardReboundFallback)
    keyboardReboundFallback = undefined
  }

  const clearSettling = () => {
    settling = false
    if (settleFallback === undefined) return
    clearTimeout(settleFallback)
    settleFallback = undefined
  }

  const settleInsideBounds = () => {
    clearSettling()
    settling = true
    settleFallback = setTimeout(() => {
      settleFallback = undefined
      settling = false
    }, FINAL_REBOUND_SETTLE_DELAY_MS)
    map.panInsideBounds(taiwanPanBoundsForViewport(map), { animate: true })
  }

  const settleKeyboardPan = () => {
    if (!keyboardReboundPending) return
    clearKeyboardReboundPending()
    settleInsideBounds()
  }

  const handoffKeyboardRebound = () => {
    if (!keyboardReboundPending) return
    clearKeyboardReboundPending()
    reboundPending = true
  }

  const releaseForProgrammaticCamera = () => {
    if (disposed) return
    clearWheelZoomPending()
    clearKeyboardReboundPending()
    clearSettling()
    dragging = false
    zooming = false
    reboundPending = false
    restoreOptions()
  }

  const finishDrag = () => {
    if (!reboundPending) return
    clearWheelZoomPending()
    clearKeyboardReboundPending()
    dragging = false
    zooming = false
    reboundPending = false
    restoreOptions()
    settleInsideBounds()
  }

  const finishPointerGesture = (interrupted = false) => {
    queueMicrotask(() => {
      if (disposed || activePointers.size > 0) return
      if (interrupted) {
        if (reboundPending) finishDrag()
        else restoreOptions()
        return
      }
      if (dragging || zooming || wheelZoomPending) return
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
    handoffKeyboardRebound()
    clearWheelZoomPending()
    dragging = false
    if (armed) return

    armOptions()
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

  const onKeyboardPan: EventListener = (event) => {
    // Leaflet only enables keyboard navigation while the map container itself
    // owns focus. Ignore bubbled arrow keys from controls inside the map.
    if (disposed || event.target !== event.currentTarget || !keyboardPanKey(event)) return

    // Leaflet listens for keyboard navigation on document. Capture the event on
    // the map first, expose maxBounds while Leaflet limits this key's pan offset,
    // then restore programmatic camera freedom after the event has propagated.
    // The real Leaflet animation is settled on moveend because its offset limit
    // alone is not sufficient across repeated animated keyboard pans.
    const armedForKeyboard = !armed
    if (armedForKeyboard) armOptions()

    queueMicrotask(() => {
      if (disposed || !armedForKeyboard) return
      if (activePointers.size > 0 || dragging || zooming || wheelZoomPending || reboundPending) return
      keyboardReboundPending = true
      restoreOptions()

      if (keyboardReboundFallback !== undefined) clearTimeout(keyboardReboundFallback)
      keyboardReboundFallback = setTimeout(() => {
        keyboardReboundFallback = undefined
        if (disposed || !keyboardReboundPending) return
        settleKeyboardPan()
      }, KEYBOARD_PAN_SETTLE_DELAY_MS)
    })
  }

  const onWheel: EventListener = () => {
    handoffKeyboardRebound()
    const interruptsSettle = settling
    if (disposed || activePointers.size > 0 || zooming || (!reboundPending && !interruptsSettle)) return

    // Scroll-wheel zoom can stop either drag inertia or the final animated
    // rebound before it emits zoomstart. Preserve a pending rebound so zoomend
    // performs one last settle using bounds recomputed at the resulting zoom.
    if (interruptsSettle) {
      clearSettling()
      reboundPending = true
    }
    wheelZoomPending = true
    dragging = false
    restoreOptions()

    if (wheelZoomFallback !== undefined) clearTimeout(wheelZoomFallback)
    wheelZoomFallback = setTimeout(() => {
      wheelZoomFallback = undefined
      if (disposed || !wheelZoomPending || zooming || activePointers.size > 0) return
      wheelZoomPending = false
      if (reboundPending) finishDrag()
      else restoreOptions()
    }, wheelZoomFallbackDelay)
  }

  const onDragStart = () => {
    if (!armed) return
    clearWheelZoomPending()
    dragging = true
    reboundPending = true
  }

  const onMoveEnd = () => {
    // Starting a new drag and scroll-wheel zoom both call Leaflet _stop(),
    // which synchronously emits the previous inertia's moveend before the new
    // interaction announces itself. Neither moveend should settle the camera.
    if (wheelZoomPending) return
    if (keyboardReboundPending) {
      settleKeyboardPan()
      return
    }
    if (settling) {
      clearSettling()
      return
    }
    if (activePointers.size === 0 && !zooming) finishDrag()
  }

  const onZoomStart = () => {
    handoffKeyboardRebound()
    if (!armed && !reboundPending && !wheelZoomPending && !settling) return
    clearSettling()
    clearWheelZoomPending()
    zooming = true
    reboundPending = true
  }

  const onZoomEnd = () => {
    if (!armed && !reboundPending && !zooming && !wheelZoomPending) return
    clearWheelZoomPending()
    zooming = false
    if (activePointers.size > 0) {
      // A pinch can hand control back to one remaining finger. Refresh the
      // viewport-expanded bounds at the snapped zoom before that drag starts.
      armOptions()
      return
    }
    if (reboundPending) finishDrag()
    else restoreOptions()
  }

  surface.addEventListener('pointerdown', onPointerDown, { capture: true })
  surface.addEventListener('keydown', onKeyboardPan, { capture: true })
  surface.addEventListener('wheel', onWheel, { capture: true, passive: true })
  releaseSurface.addEventListener('pointerup', onPointerRelease, { capture: true })
  releaseSurface.addEventListener('pointercancel', onInterruptedGesture, { capture: true })
  releaseSurface.addEventListener('blur', onInterruptedGesture, { capture: true })
  map.on('dragstart', onDragStart)
  map.on('moveend', onMoveEnd)
  map.on('zoomstart', onZoomStart)
  map.on('zoomend', onZoomEnd)

  const dispose = (() => {
    if (disposed) return
    disposed = true
    surface.removeEventListener('pointerdown', onPointerDown, { capture: true })
    surface.removeEventListener('keydown', onKeyboardPan, { capture: true })
    surface.removeEventListener('wheel', onWheel, { capture: true })
    releaseSurface.removeEventListener('pointerup', onPointerRelease, { capture: true })
    releaseSurface.removeEventListener('pointercancel', onInterruptedGesture, { capture: true })
    releaseSurface.removeEventListener('blur', onInterruptedGesture, { capture: true })
    map.off('dragstart', onDragStart)
    map.off('moveend', onMoveEnd)
    map.off('zoomstart', onZoomStart)
    map.off('zoomend', onZoomEnd)
    activePointers.clear()
    clearWheelZoomPending()
    clearKeyboardReboundPending()
    clearSettling()
    dragging = false
    zooming = false
    reboundPending = false
    restoreOptions()
  }) as MapPanConstraintDisposer
  dispose.releaseForProgrammaticCamera = releaseForProgrammaticCamera
  return dispose
}

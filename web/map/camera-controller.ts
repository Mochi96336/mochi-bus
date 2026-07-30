import type L from 'leaflet'
import { calculateCameraPadding, cameraPanOffset, type CameraRect } from '../../src/domain/map/camera-padding'
import { constrainMapPanToTaiwan } from './map-pan-bounds'
import { subscribeNearbyCameraTransitions } from './nearby-map-events'

type PointMotion = 'instant' | 'auto' | 'pan'

type PointTarget = {
  kind: 'point'
  center: L.LatLngExpression
  zoom: number
  refreshOptions?: PointFocusOptions
}

type BoundsTarget = {
  kind: 'bounds'
  bounds: L.LatLngBoundsExpression
  maxZoom?: number | (() => number)
}

type CameraTarget = PointTarget | BoundsTarget

type PointFocusOptions = {
  animate?: boolean
  motion?: PointMotion
  duration?: number
  deadZonePx?: number
}

type NearbyTransition = {
  expiresAt: number
}

export type MapCameraController = {
  focusPoint(center: L.LatLngExpression, zoom: number, options?: PointFocusOptions): void
  focusBounds(bounds: L.LatLngBoundsExpression, options?: { maxZoom?: number | (() => number) }): void
  clear(): void
  refresh(): void
  dispose(): void
}

const RECENT_POINTER_WINDOW_MS = 800
const NEARBY_SETTLE_WINDOW_MS = 20_000
const DEFAULT_PAN_DURATION_SECONDS = .32
const DEFAULT_FLY_DURATION_SECONDS = .48
const DEFAULT_DEAD_ZONE_PX = 24
const NEARBY_SETTLE_DEAD_ZONE_PX = 48
const REFRESH_PAN_DURATION_SECONDS = .16
const REFRESH_DEAD_ZONE_PX = 16
const SAME_TARGET_TOLERANCE_PX = .5

/**
 * Keeps one semantic camera target and projects it into the part of the map that
 * is not covered by the drawer. The target survives drawer/content resizes, but
 * is released as soon as the user starts manipulating the map themselves.
 */
export function createMapCameraController(
  map: L.Map,
  mapElement: HTMLElement,
  drawerElement: HTMLElement,
): MapCameraController {
  const taiwanPanConstraint = constrainMapPanToTaiwan(
    map,
    mapElement,
    mapPanReleaseSurface(window),
  )

  let target: CameraTarget | undefined
  let frame: number | undefined
  let disposed = false
  let lastPointerDownAt = Number.NEGATIVE_INFINITY
  let nearbyTransition: NearbyTransition | undefined

  const reducedMotion = () => typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches

  const cameraCenterFor = (point: PointTarget): L.LatLng => {
    const padding = calculateCameraPadding(readRect(mapElement), readRect(drawerElement))
    const offset = cameraPanOffset(padding)
    return map.unproject(map.project(point.center, point.zoom).add(offset), point.zoom)
  }

  const pointDistance = (
    first: L.LatLngExpression,
    second: L.LatLngExpression,
    zoom: number,
  ): number => map.project(first, zoom).distanceTo(map.project(second, zoom))

  const currentDistanceTo = (center: L.LatLngExpression, zoom: number): number =>
    pointDistance(map.getCenter(), center, zoom)

  const refreshOptionsFor = (options: PointFocusOptions): PointFocusOptions | undefined => {
    const motion = options.motion ?? (options.animate ? 'auto' : 'instant')
    return motion === 'instant'
      ? undefined
      : { motion: 'pan', duration: REFRESH_PAN_DURATION_SECONDS, deadZonePx: REFRESH_DEAD_ZONE_PX }
  }

  const apply = (options?: PointFocusOptions) => {
    frame = undefined
    if (disposed || !target) return
    taiwanPanConstraint.releaseForProgrammaticCamera()

    const padding = calculateCameraPadding(readRect(mapElement), readRect(drawerElement))
    if (target.kind === 'bounds') {
      map.fitBounds(target.bounds, {
        ...padding,
        maxZoom: typeof target.maxZoom === 'function' ? target.maxZoom() : target.maxZoom,
        animate: false,
      })
      return
    }

    const pointOptions = options ?? target.refreshOptions ?? {}
    const motion = reducedMotion()
      ? 'instant'
      : pointOptions.motion ?? (pointOptions.animate ? 'auto' : 'instant')
    if (motion !== 'instant') {
      const cameraCenter = cameraCenterFor(target)
      const sameZoom = Math.abs(map.getZoom() - target.zoom) < .001
      const deadZonePx = pointOptions.deadZonePx ?? DEFAULT_DEAD_ZONE_PX
      if (sameZoom && currentDistanceTo(cameraCenter, target.zoom) <= deadZonePx) return

      map.stop()
      if (motion === 'pan' || sameZoom) {
        map.panTo(cameraCenter, {
          animate: true,
          duration: pointOptions.duration ?? DEFAULT_PAN_DURATION_SECONDS,
        })
      } else {
        map.flyTo(cameraCenter, target.zoom, {
          animate: true,
          duration: pointOptions.duration ?? DEFAULT_FLY_DURATION_SECONDS,
        })
      }
      return
    }

    const offset = cameraPanOffset(padding)
    map.setView(target.center, target.zoom, { animate: false })
    if (offset[0] || offset[1]) map.panBy(offset, { animate: false })
  }

  const cancelScheduledApply = () => {
    if (frame === undefined) return
    window.cancelAnimationFrame(frame)
    frame = undefined
  }

  const refresh = () => {
    if (disposed || !target || frame !== undefined) return
    frame = window.requestAnimationFrame(() => apply())
  }

  const clearTarget = () => {
    target = undefined
    cancelScheduledApply()
  }

  const clearNearbyTransition = () => {
    nearbyTransition = undefined
  }

  const clear = () => {
    clearTarget()
    clearNearbyTransition()
    taiwanPanConstraint.releaseForProgrammaticCamera()
  }

  const releaseOnPointerDown = () => {
    lastPointerDownAt = Date.now()
    clearNearbyTransition()
    clearTarget()
  }
  const releaseOnOtherMapInteraction = () => {
    lastPointerDownAt = Number.NEGATIVE_INFINITY
    clearNearbyTransition()
    clearTarget()
  }
  mapElement.addEventListener('pointerdown', releaseOnPointerDown, { capture: true })
  mapElement.addEventListener('wheel', releaseOnOtherMapInteraction, { capture: true, passive: true })
  mapElement.addEventListener('keydown', releaseOnOtherMapInteraction, { capture: true })

  const beginNearbyTransition = (origin: readonly [number, number]) => {
    // Every nearby request owns a fresh transition. Even retries and URL-driven
    // renders that do not animate must invalidate any unfinished pointer request.
    clearNearbyTransition()
    if (disposed || Date.now() - lastPointerDownAt > RECENT_POINTER_WINDOW_MS) return
    lastPointerDownAt = Number.NEGATIVE_INFINITY
    nearbyTransition = { expiresAt: Date.now() + NEARBY_SETTLE_WINDOW_MS }
    target = {
      kind: 'point',
      center: [...origin],
      zoom: map.getZoom(),
      refreshOptions: { motion: 'pan', duration: REFRESH_PAN_DURATION_SECONDS, deadZonePx: REFRESH_DEAD_ZONE_PX },
    }
    cancelScheduledApply()
    apply({ motion: 'pan' })
  }

  const settleNearbyTransition = (position: readonly [number, number]) => {
    const transition = nearbyTransition
    clearNearbyTransition()
    if (!transition || transition.expiresAt < Date.now()) return

    const settleOptions = { motion: 'pan' as const, duration: .2, deadZonePx: NEARBY_SETTLE_DEAD_ZONE_PX }
    target = {
      kind: 'point',
      center: [...position],
      zoom: map.getZoom(),
      refreshOptions: refreshOptionsFor(settleOptions),
    }
    cancelScheduledApply()
    apply(settleOptions)
  }

  const unsubscribeNearbyTransitions = subscribeNearbyCameraTransitions({
    begin: beginNearbyTransition,
    settle: settleNearbyTransition,
    cancel: clearNearbyTransition,
  })

  const resizeObserver = new ResizeObserver(() => refresh())
  resizeObserver.observe(mapElement)
  resizeObserver.observe(drawerElement)

  const refreshAfterViewportResize = () => {
    map.invalidateSize({ pan: false })
    refresh()
  }
  window.addEventListener('resize', refreshAfterViewportResize)
  window.visualViewport?.addEventListener('resize', refreshAfterViewportResize)

  return {
    focusPoint(center, zoom, options = {}) {
      clearNearbyTransition()
      const previousTarget = target
      const sameSemanticTarget = previousTarget?.kind === 'point'
        && Math.abs(previousTarget.zoom - zoom) < .001
        && pointDistance(previousTarget.center, center, zoom) <= SAME_TARGET_TOLERANCE_PX
        && !options.animate
        && !options.motion
      if (sameSemanticTarget) {
        // Keep an in-flight settle intact. Drawer/viewport observers already own
        // geometry corrections; a duplicate semantic focus must not stop and restart it.
        target = { ...previousTarget, center, zoom }
        return
      }

      target = { kind: 'point', center, zoom, refreshOptions: refreshOptionsFor(options) }
      cancelScheduledApply()
      apply(options)
    },
    focusBounds(bounds, options = {}) {
      clearNearbyTransition()
      target = { kind: 'bounds', bounds, maxZoom: options.maxZoom }
      cancelScheduledApply()
      apply()
    },
    clear,
    refresh,
    dispose() {
      if (disposed) return
      disposed = true
      clearTarget()
      clearNearbyTransition()
      unsubscribeNearbyTransitions()
      taiwanPanConstraint()
      resizeObserver.disconnect()
      mapElement.removeEventListener('pointerdown', releaseOnPointerDown, { capture: true })
      mapElement.removeEventListener('wheel', releaseOnOtherMapInteraction, { capture: true })
      mapElement.removeEventListener('keydown', releaseOnOtherMapInteraction, { capture: true })
      window.removeEventListener('resize', refreshAfterViewportResize)
      window.visualViewport?.removeEventListener('resize', refreshAfterViewportResize)
    },
  }
}

function mapPanReleaseSurface(target: Window): Pick<EventTarget, 'addEventListener' | 'removeEventListener'> {
  const eventTarget = target as EventTarget
  return {
    addEventListener(type, listener, options) {
      eventTarget.addEventListener(type, listener, type === 'blur' ? false : options)
    },
    removeEventListener(type, listener, options) {
      eventTarget.removeEventListener(type, listener, type === 'blur' ? false : options)
    },
  }
}

function readRect(element: HTMLElement): CameraRect {
  const { left, top, right, bottom, width, height } = element.getBoundingClientRect()
  return { left, top, right, bottom, width, height }
}

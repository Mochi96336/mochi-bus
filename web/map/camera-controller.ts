import type L from 'leaflet'
import { calculateCameraPadding, cameraPanOffset, type CameraRect } from '../../src/domain/map/camera-padding'
import { constrainMapPanToTaiwan } from './map-pan-bounds'
import { subscribeNearbyCameraFocus } from './nearby-map-events'

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

export type MapCameraController = {
  focusPoint(center: L.LatLngExpression, zoom: number, options?: PointFocusOptions): void
  focusBounds(bounds: L.LatLngBoundsExpression, options?: { maxZoom?: number | (() => number) }): void
  clear(): void
  refresh(): void
  dispose(): void
}

const RECENT_POINTER_WINDOW_MS = 800
const DEFAULT_PAN_DURATION_SECONDS = .32
const DEFAULT_FLY_DURATION_SECONDS = .48
const DEFAULT_DEAD_ZONE_PX = 24
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
  const clear = () => {
    clearTarget()
    taiwanPanConstraint.releaseForProgrammaticCamera()
  }

  const releaseOnPointerDown = () => {
    lastPointerDownAt = Date.now()
    clearTarget()
  }
  const releaseOnOtherMapInteraction = () => {
    lastPointerDownAt = Number.NEGATIVE_INFINITY
    clearTarget()
  }
  mapElement.addEventListener('pointerdown', releaseOnPointerDown, { capture: true })
  mapElement.addEventListener('wheel', releaseOnOtherMapInteraction, { capture: true, passive: true })
  mapElement.addEventListener('keydown', releaseOnOtherMapInteraction, { capture: true })

  const focusNearbyOrigin = (origin: readonly [number, number]) => {
    if (disposed || Date.now() - lastPointerDownAt > RECENT_POINTER_WINDOW_MS) return
    lastPointerDownAt = Number.NEGATIVE_INFINITY
    target = {
      kind: 'point',
      center: [...origin],
      zoom: map.getZoom(),
      refreshOptions: { motion: 'pan', duration: REFRESH_PAN_DURATION_SECONDS, deadZonePx: REFRESH_DEAD_ZONE_PX },
    }
    cancelScheduledApply()
    apply({ motion: 'pan' })
  }

  const unsubscribeNearbyFocus = subscribeNearbyCameraFocus(focusNearbyOrigin)

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
      const previousTarget = target
      const sameSemanticTarget = previousTarget?.kind === 'point'
        && Math.abs(previousTarget.zoom - zoom) < .001
        && pointDistance(previousTarget.center, center, zoom) <= SAME_TARGET_TOLERANCE_PX
        && !options.animate
        && !options.motion
      if (sameSemanticTarget) {
        // Drawer/viewport observers already own geometry corrections; a duplicate
        // semantic focus must not stop and restart an in-flight camera movement.
        target = { ...previousTarget, center, zoom }
        return
      }

      target = { kind: 'point', center, zoom, refreshOptions: refreshOptionsFor(options) }
      cancelScheduledApply()
      apply(options)
    },
    focusBounds(bounds, options = {}) {
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
      unsubscribeNearbyFocus()
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

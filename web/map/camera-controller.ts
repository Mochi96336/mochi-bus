import type L from 'leaflet'
import { calculateCameraPadding, cameraPanOffset, type CameraRect } from '../../src/domain/map/camera-padding'
import { constrainMapPanToTaiwan } from './map-pan-bounds'

type PointTarget = {
  kind: 'point'
  center: L.LatLngExpression
  zoom: number
}

type BoundsTarget = {
  kind: 'bounds'
  bounds: L.LatLngBoundsExpression
  maxZoom?: number | (() => number)
}

type CameraTarget = PointTarget | BoundsTarget

export type MapCameraController = {
  focusPoint(center: L.LatLngExpression, zoom: number, options?: { animate?: boolean }): void
  focusBounds(bounds: L.LatLngBoundsExpression, options?: { maxZoom?: number | (() => number) }): void
  clear(): void
  refresh(): void
  dispose(): void
}

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

  const apply = (animate = false) => {
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

    const offset = cameraPanOffset(padding)
    if (animate) {
      const cameraCenter = map.unproject(map.project(target.center, target.zoom).add(offset), target.zoom)
      map.flyTo(cameraCenter, target.zoom)
      return
    }

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

  const releaseOnMapInteraction = () => clearTarget()
  mapElement.addEventListener('pointerdown', releaseOnMapInteraction, { capture: true })
  mapElement.addEventListener('wheel', releaseOnMapInteraction, { capture: true, passive: true })
  mapElement.addEventListener('keydown', releaseOnMapInteraction, { capture: true })

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
      target = { kind: 'point', center, zoom }
      cancelScheduledApply()
      apply(options.animate)
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
      taiwanPanConstraint()
      resizeObserver.disconnect()
      mapElement.removeEventListener('pointerdown', releaseOnMapInteraction, { capture: true })
      mapElement.removeEventListener('wheel', releaseOnMapInteraction, { capture: true })
      mapElement.removeEventListener('keydown', releaseOnMapInteraction, { capture: true })
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

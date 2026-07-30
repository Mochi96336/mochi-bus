import type L from 'leaflet'
import { calculateCameraPadding, cameraPanOffset, type CameraRect } from '../../src/domain/map/camera-padding'
import {
  DRAWER_SIZE_TRANSITION_EVENT,
  type DrawerSize,
  type DrawerSizeTransition,
} from './drawer-size-transition'
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

type ActiveDrawerTransition = {
  targetRect: CameraRect
  durationMs: number
  timeout: ReturnType<typeof setTimeout>
  finishOnTransitionEnd: (event: Event) => void
}

type MapCameraControllerOptions = {
  measureDrawerRectForSize?: (drawer: HTMLElement, size: DrawerSize) => CameraRect
}

export type MapCameraController = {
  focusPoint(center: L.LatLngExpression, zoom: number, options?: { animate?: boolean }): void
  focusBounds(bounds: L.LatLngBoundsExpression, options?: { maxZoom?: number | (() => number) }): void
  prepareDrawerSizeTransition(transition: DrawerSizeTransition): void
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
  options: MapCameraControllerOptions = {},
): MapCameraController {
  const taiwanPanConstraint = constrainMapPanToTaiwan(
    map,
    mapElement,
    mapPanReleaseSurface(window),
  )
  const measureDrawerRectForSize = options.measureDrawerRectForSize ?? defaultDrawerRectForSize

  let target: CameraTarget | undefined
  let frame: number | undefined
  let drawerTransition: ActiveDrawerTransition | undefined
  let disposed = false

  const apply = (animate = false) => {
    frame = undefined
    if (disposed || !target) return
    taiwanPanConstraint.releaseForProgrammaticCamera()

    const transition = drawerTransition
    const drawerRect = transition?.targetRect ?? readRect(drawerElement)
    const padding = calculateCameraPadding(readRect(mapElement), drawerRect)
    const animationOptions = animate
      ? {
          animate: true,
          ...(transition ? { duration: transition.durationMs / 1000 } : {}),
        }
      : { animate: false }

    if (target.kind === 'bounds') {
      map.fitBounds(target.bounds, {
        ...padding,
        maxZoom: typeof target.maxZoom === 'function' ? target.maxZoom() : target.maxZoom,
        ...animationOptions,
      })
      return
    }

    const offset = cameraPanOffset(padding)
    if (animate) {
      const cameraCenter = map.unproject(map.project(target.center, target.zoom).add(offset), target.zoom)
      map.flyTo(
        cameraCenter,
        target.zoom,
        transition ? { duration: transition.durationMs / 1000 } : undefined,
      )
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

  const finishDrawerTransition = (refreshAtEnd: boolean, stopMapAnimation = false) => {
    const transition = drawerTransition
    if (!transition) return
    drawerTransition = undefined
    clearTimeout(transition.timeout)
    drawerElement.removeEventListener('transitionend', transition.finishOnTransitionEnd)
    drawerElement.removeEventListener('transitioncancel', transition.finishOnTransitionEnd)
    if (stopMapAnimation) map.stop()
    if (refreshAtEnd) refresh()
  }

  const prepareDrawerSizeTransition = (transition: DrawerSizeTransition) => {
    finishDrawerTransition(false, true)
    if (transition.durationMs <= 0 || transition.to === 'content') return

    const targetRect = measureDrawerRectForSize(drawerElement, transition.to)
    if (sameCameraRect(targetRect, readRect(drawerElement))) return

    const finishOnTransitionEnd = (event: Event) => {
      if (event.target !== drawerElement) return
      const propertyName = (event as TransitionEvent).propertyName
      if (propertyName !== 'height' && propertyName !== 'max-height') return
      finishDrawerTransition(true)
    }
    const timeout = setTimeout(
      () => finishDrawerTransition(true),
      transition.durationMs + 80,
    )
    drawerTransition = {
      targetRect,
      durationMs: transition.durationMs,
      timeout,
      finishOnTransitionEnd,
    }
    drawerElement.addEventListener('transitionend', finishOnTransitionEnd)
    drawerElement.addEventListener('transitioncancel', finishOnTransitionEnd)

    // Wait one frame so a focusBounds/focusPoint issued by the new view can replace the old
    // semantic target before the synchronized camera animation begins.
    cancelScheduledApply()
    if (target) frame = window.requestAnimationFrame(() => apply(true))
  }

  const clearTarget = () => {
    target = undefined
    cancelScheduledApply()
  }

  const clear = () => {
    finishDrawerTransition(false, true)
    clearTarget()
    taiwanPanConstraint.releaseForProgrammaticCamera()
  }

  const releaseOnMapInteraction = () => {
    finishDrawerTransition(false, true)
    clearTarget()
  }
  mapElement.addEventListener('pointerdown', releaseOnMapInteraction, { capture: true })
  mapElement.addEventListener('wheel', releaseOnMapInteraction, { capture: true, passive: true })
  mapElement.addEventListener('keydown', releaseOnMapInteraction, { capture: true })

  const resizeObserver = new ResizeObserver((entries) => {
    const drawerOnly = entries.length > 0 && entries.every((entry) => entry.target === drawerElement)
    if (drawerTransition && drawerOnly) return
    refresh()
  })
  resizeObserver.observe(mapElement)
  resizeObserver.observe(drawerElement)

  const refreshAfterViewportResize = () => {
    finishDrawerTransition(false, true)
    map.invalidateSize({ pan: false })
    refresh()
  }
  window.addEventListener('resize', refreshAfterViewportResize)
  window.visualViewport?.addEventListener('resize', refreshAfterViewportResize)

  const onDrawerSizeTransition = (event: Event) => {
    const transition = (event as CustomEvent<DrawerSizeTransition>).detail
    if (transition) prepareDrawerSizeTransition(transition)
  }
  drawerElement.addEventListener(DRAWER_SIZE_TRANSITION_EVENT, onDrawerSizeTransition)

  return {
    focusPoint(center, zoom, focusOptions = {}) {
      target = { kind: 'point', center, zoom }
      cancelScheduledApply()
      if (drawerTransition) map.stop()
      apply(Boolean(drawerTransition) || focusOptions.animate)
    },
    focusBounds(bounds, focusOptions = {}) {
      target = { kind: 'bounds', bounds, maxZoom: focusOptions.maxZoom }
      cancelScheduledApply()
      if (drawerTransition) map.stop()
      apply(Boolean(drawerTransition))
    },
    prepareDrawerSizeTransition,
    clear,
    refresh,
    dispose() {
      if (disposed) return
      disposed = true
      finishDrawerTransition(false, true)
      clearTarget()
      taiwanPanConstraint()
      resizeObserver.disconnect()
      mapElement.removeEventListener('pointerdown', releaseOnMapInteraction, { capture: true })
      mapElement.removeEventListener('wheel', releaseOnMapInteraction, { capture: true })
      mapElement.removeEventListener('keydown', releaseOnMapInteraction, { capture: true })
      drawerElement.removeEventListener(DRAWER_SIZE_TRANSITION_EVENT, onDrawerSizeTransition)
      window.removeEventListener('resize', refreshAfterViewportResize)
      window.visualViewport?.removeEventListener('resize', refreshAfterViewportResize)
    },
  }
}

function defaultDrawerRectForSize(drawer: HTMLElement, size: DrawerSize): CameraRect {
  const probe = drawer.cloneNode(false) as HTMLElement
  probe.removeAttribute('id')
  probe.dataset.size = size
  probe.setAttribute('aria-hidden', 'true')
  probe.style.setProperty('visibility', 'hidden', 'important')
  probe.style.setProperty('pointer-events', 'none', 'important')
  probe.style.setProperty('transition', 'none', 'important')
  probe.style.setProperty('animation', 'none', 'important')
  ;(drawer.parentElement ?? document.body).appendChild(probe)
  try {
    return readRect(probe)
  } finally {
    probe.remove()
  }
}

function sameCameraRect(a: CameraRect, b: CameraRect): boolean {
  return Math.abs(a.left - b.left) <= .5
    && Math.abs(a.top - b.top) <= .5
    && Math.abs(a.right - b.right) <= .5
    && Math.abs(a.bottom - b.bottom) <= .5
    && Math.abs(a.width - b.width) <= .5
    && Math.abs(a.height - b.height) <= .5
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

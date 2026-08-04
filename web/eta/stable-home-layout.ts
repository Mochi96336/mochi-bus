const STYLE_ID = 'mochi-home-layout-stability'

export type HomeTypeScale = {
  routePx: number
  etaPx: number
}

export function homeTypeScale(layoutWidth: number): HomeTypeScale {
  const width = Math.max(280, Math.min(720, layoutWidth))
  return {
    routePx: Math.round(Math.max(30, Math.min(54, width * .10))),
    etaPx: Math.round(Math.max(42, Math.min(58, width * .09))),
  }
}

export function deferHomeScaleUpdate(
  update: () => void,
  requestFrame: (callback: () => void) => unknown,
): void {
  requestFrame(update)
}

export function installStableHomeLayout(): void {
  const root = document.documentElement
  let resizeTimer: number | undefined
  const updateScale = () => {
    // Capture the real layout viewport only while this document is active.
    // iOS temporarily narrows the outgoing page during its native slide; the
    // leaving flag prevents that transition-only width from becoming layout.
    if (root.dataset.mochiPageLeaving === 'true') return
    const scale = homeTypeScale(root.clientWidth)
    root.style.setProperty('--eta-stable-route-size', `${scale.routePx}px`)
    root.style.setProperty('--eta-stable-value-size', `${scale.etaPx}px`)
  }
  const queueScaleUpdate = () => {
    window.clearTimeout(resizeTimer)
    resizeTimer = window.setTimeout(updateScale, 160)
  }

  updateScale()
  window.addEventListener('resize', queueScaleUpdate)
  window.addEventListener('pageshow', () => {
    // return-home clears the leaving flag in the same pageshow dispatch. Defer
    // one frame so BFCache restores after rotation/split-view use the new width
    // regardless of listener installation order.
    deferHomeScaleUpdate(updateScale, (callback) => window.requestAnimationFrame(callback))
  })
  window.addEventListener('orientationchange', queueScaleUpdate)

  if (document.getElementById(STYLE_ID)) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = `
.bus-row {
  grid-template-columns: minmax(0, 1fr) max-content;
}
.bus-route-copy,
.bus-name {
  min-width: 0;
}
.bus-name {
  display: block;
  overflow: hidden;
  font-size: var(--eta-stable-route-size);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.eta-value {
  font-size: var(--eta-stable-value-size);
}
.bus-row,
.eta-footer,
.eta-footer-actions {
  min-width: 0;
}
html[data-mochi-home-snapshot="restored"] .skeleton-row,
html[data-mochi-home-snapshot="restored"] .skeleton-title {
  display: none;
}
`
  document.head.appendChild(style)
}

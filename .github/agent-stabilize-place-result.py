from pathlib import Path


def replace_once(path: Path, old: str, new: str, label: str) -> None:
    source = path.read_text(encoding='utf-8')
    count = source.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected exactly one match, found {count}')
    path.write_text(source.replace(old, new, 1), encoding='utf-8')


view = Path('web/map/place-routes-view.ts')
replace_once(
    view,
    "import type { DrawerView } from './drawer-view'\n",
    "import type { DrawerView, DrawerViewSession } from './drawer-view'\n",
    'drawer session import',
)
replace_once(
    view,
    "  renderDrawer: (view: DrawerView) => void\n",
    "  renderDrawer: (view: DrawerView) => DrawerViewSession\n",
    'drawer renderer contract',
)
replace_once(
    view,
    """  function retry(place: NearbyPlace): () => void {
    return () => options.onRetry(place)
  }

""",
    """  function retry(place: NearbyPlace): () => void {
    return () => options.onRetry(place)
  }

  function renderSettled(view: DrawerView): void {
    const session = options.renderDrawer({ ...view, preserveDesktopHeight: true })
    const frame = requestAnimationFrame(() => session.releasePreservedHeight())
    session.onDispose(() => cancelAnimationFrame(frame))
  }

""",
    'settled drawer transition helper',
)
replace_once(
    view,
    """      options.renderDrawer({
        key: `place:${cityCode}:${place.placeId}`,
        mode: 'map-list',
        header: drawerHeader(
          place,
          `${place.distanceMeters > 0 ? `${Math.round(place.distanceMeters)} 公尺 · ` : ''}${routes.length} 個行車方向`,
""",
    """      renderSettled({
        key: `place:${cityCode}:${place.placeId}`,
        mode: 'map-list',
        header: drawerHeader(
          place,
          `${place.distanceMeters > 0 ? `${Math.round(place.distanceMeters)} 公尺 · ` : ''}${routes.length} 個行車方向`,
""",
    'resolved place routes transition',
)
replace_once(
    view,
    """      options.renderDrawer({
        key: `place:${cityCode}:${place.placeId}`,
        mode: 'map-list',
        header: drawerHeader(place, message),
""",
    """      renderSettled({
        key: `place:${cityCode}:${place.placeId}`,
        mode: 'map-list',
        header: drawerHeader(place, message),
""",
    'place error transition',
)

test = Path('web/map/place-routes-view.test.ts')
replace_once(
    test,
    "import type { DrawerView } from './drawer-view'\n",
    "import type { DrawerView, DrawerViewSession } from './drawer-view'\n",
    'test drawer session import',
)
replace_once(
    test,
    """  const createFavoriteControl = vi.fn(() => element('button') as unknown as HTMLButtonElement)
  const createDegradedNotice = vi.fn((_message: string, retry: () => void, credentialRecovery = false) => {
""",
    """  const createFavoriteControl = vi.fn(() => element('button') as unknown as HTMLButtonElement)
  const releasePreservedHeight = vi.fn()
  const onDispose = vi.fn()
  const createDegradedNotice = vi.fn((_message: string, retry: () => void, credentialRecovery = false) => {
""",
    'test drawer session spies',
)
replace_once(
    test,
    "    renderDrawer: (drawerView) => { rendered = drawerView },\n",
    """    renderDrawer: (drawerView) => {
      rendered = drawerView
      return {
        signal: new AbortController().signal,
        releasePreservedHeight,
        onDispose,
      } satisfies DrawerViewSession
    },
""",
    'test drawer renderer session',
)
replace_once(
    test,
    """    createFavoriteControl,
    createDegradedNotice,
  }
""",
    """    createFavoriteControl,
    createDegradedNotice,
    releasePreservedHeight,
    onDispose,
  }
""",
    'test harness session spies',
)
replace_once(
    test,
    """beforeEach(() => {
  vi.stubGlobal('document', {
    createElement: (tagName: string) => element(tagName),
  })
})
""",
    """beforeEach(() => {
  vi.stubGlobal('document', {
    createElement: (tagName: string) => element(tagName),
  })
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0)
    return 1
  })
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
})
""",
    'animation frame test globals',
)
replace_once(
    test,
    """    const drawer = scrollable(harness.rendered())
    expect(harness.createDegradedNotice).toHaveBeenCalledWith(
""",
    """    const drawer = scrollable(harness.rendered())
    expect(drawer.preserveDesktopHeight).toBe(true)
    expect(harness.releasePreservedHeight).toHaveBeenCalledOnce()
    expect(harness.onDispose).toHaveBeenCalledOnce()
    expect(harness.createDegradedNotice).toHaveBeenCalledWith(
""",
    'resolved route height release assertions',
)
replace_once(
    test,
    """    const drawer = scrollable(harness.rendered())
    expect(drawer.key).toBe('place:Taipei:PLACE')
    expect(harness.createDegradedNotice).toHaveBeenCalledWith('credential', expect.any(Function), true)
""",
    """    const drawer = scrollable(harness.rendered())
    expect(drawer.key).toBe('place:Taipei:PLACE')
    expect(drawer.preserveDesktopHeight).toBe(true)
    expect(harness.releasePreservedHeight).toHaveBeenCalledOnce()
    expect(harness.onDispose).toHaveBeenCalledOnce()
    expect(harness.createDegradedNotice).toHaveBeenCalledWith('credential', expect.any(Function), true)
""",
    'error height release assertions',
)

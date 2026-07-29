from pathlib import Path


def replace_once(path: Path, old: str, new: str, label: str) -> None:
    source = path.read_text(encoding='utf-8')
    count = source.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected exactly one match, found {count}')
    path.write_text(source.replace(old, new, 1), encoding='utf-8')


stability = Path('test/e2e/map-desktop-drawer-stability.spec.ts')
replace_once(
    stability,
    "test('keeps stop lookup loading steps stable, then releases the desktop height for resolved content', async ({ page }) => {",
    "test('keeps the current drawer stable while auto-preview resolves, then opens place loading', async ({ page }) => {",
    'stability test title',
)
replace_once(
    stability,
    """  await nearbyRequested.promise
  await expect(drawer.getByRole('heading', { name: '附近站牌' })).toBeVisible()
  await page.waitForTimeout(100)
""",
    """  await nearbyRequested.promise
  await expect(drawer.getByRole('heading', { name: city.name })).toBeVisible()
  await expect(drawer.getByRole('heading', { name: '附近站牌' })).toHaveCount(0)
  await page.waitForTimeout(100)
""",
    'silent auto-preview loading assertion',
)
replace_once(
    stability,
    "  expectStableFrames(frames, ['catalogue', 'nearby-loading', 'place-loading'])\n",
    """  expectStableFrames(frames, ['catalogue', 'place-loading'])
  expect(frames.some((frame) => frame.phase === 'nearby-loading')).toBe(false)
""",
    'stable auto-preview frame phases',
)

navigation = Path('test/e2e/map-navigation-equivalence.spec.ts')
replace_once(
    navigation,
    "test('auto-preview keeps nearby result markers while skipping the transient list drawer', async ({ page }) => {",
    "test('auto-preview keeps the route drawer, opens the place directly, and returns without catalogue flash', async ({ page }) => {",
    'navigation test title',
)
replace_once(
    navigation,
    """  await page.route('**/api/v1/map/nearby*', (route) => route.fulfill({ json: { places: nearbyPlaces } }))
  await page.route('**/api/v1/map/place/P1/arrivals?city=Tainan', (route) => route.fulfill({ json: { routes: [] } }))
""",
    """  let releaseNearby!: () => void
  let signalNearbyRequested!: () => void
  const nearbyGate = new Promise<void>((resolve) => { releaseNearby = resolve })
  const nearbyRequested = new Promise<void>((resolve) => { signalNearbyRequested = resolve })
  await page.route('**/api/v1/map/nearby*', async (route) => {
    signalNearbyRequested()
    await nearbyGate
    await route.fulfill({ json: { places: nearbyPlaces } })
  })
  await page.route('**/api/v1/map/place/P1/arrivals?city=Tainan', (route) => route.fulfill({
    json: {
      routes: [{
        routeName: '15',
        routeUid: 'TNN-15',
        variantKey: 'TNN-15:0',
        direction: 0,
        label: '奇美醫院 → 大成路口',
        subRouteUid: 'TNN-15',
        subRouteName: '15',
        stopUid: 'S1',
        stopName: '奇美醫院',
        stopSequence: 1,
        estimateSeconds: 120,
        etaLabel: '2 分',
        stopStatus: 0,
        source: 'realtime',
      }],
    },
  }))
""",
    'gated auto-preview fixtures',
)
replace_once(
    navigation,
    """  const routeStops = page.locator('.leaflet-stop-pane svg path.leaflet-interactive')
  await expect(routeStops).toHaveCount(2)
  await routeStops.first().click()

  await expect(page).toHaveURL(/place=P1/)
  await expect(drawer.getByRole('heading', { name: '臺南火車站' })).toBeVisible()
  await expect(drawer.locator('.nearby-place-button')).toHaveCount(0)
  await expect(page.locator('.leaflet-stop-pane svg path.leaflet-interactive')).toHaveCount(3)
""",
    """  const routeStops = page.locator('.leaflet-stop-pane svg path.leaflet-interactive')
  await expect(routeStops).toHaveCount(2)
  await routeStops.first().click()

  await nearbyRequested
  await expect(drawer.getByRole('heading', { name: '15' })).toBeVisible()
  await expect(drawer.getByRole('heading', { name: '附近站牌' })).toHaveCount(0)
  releaseNearby()

  await expect(page).toHaveURL(/place=P1/)
  await expect(drawer.getByRole('heading', { name: '臺南火車站' })).toBeVisible()
  await expect(drawer.locator('.nearby-place-button')).toHaveCount(0)
  await expect(page.locator('.leaflet-stop-pane svg path.leaflet-interactive')).toHaveCount(3)

  await drawer.locator('.place-route-button').click()
  await expect(page).toHaveURL(/route=15/)
  await expect(drawer.getByRole('button', { name: '← 返回站點', exact: true })).toBeVisible()

  await page.evaluate(() => {
    type FrameStore = { active: boolean; headings: string[] }
    const store: FrameStore = { active: true, headings: [] }
    ;(window as Window & { __drawerHeadingFrames?: FrameStore }).__drawerHeadingFrames = store
    const sample = () => {
      if (!store.active) return
      store.headings.push(document.querySelector<HTMLElement>('#map-drawer .drawer-heading h1')?.textContent ?? '')
      requestAnimationFrame(sample)
    }
    requestAnimationFrame(sample)
  })

  await drawer.getByRole('button', { name: '← 返回站點', exact: true }).click()
  await expect(page).toHaveURL(/place=P1/)
  await expect(drawer.getByRole('heading', { name: '臺南火車站' })).toBeVisible()
  await page.waitForTimeout(80)
  const headings = await page.evaluate(() => {
    type FrameStore = { active: boolean; headings: string[] }
    const store = (window as Window & { __drawerHeadingFrames?: FrameStore }).__drawerHeadingFrames!
    store.active = false
    return store.headings
  })
  expect(headings).not.toContain('臺南')
""",
    'route place navigation assertions',
)
